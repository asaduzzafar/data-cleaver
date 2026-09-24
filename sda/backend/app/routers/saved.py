"""Saved queries: named, re-runnable specs.

A saved query keeps what the user built -- the spec -- and the SQL it
compiled to when saved, for reference. It never keeps a result; that is what
Save as table is for. Every run rebuilds the SQL from the spec against the
relations as they are now, through the same validation and job path as a
query typed fresh, so a reload that dropped a column fails naming the query
and the column instead of surfacing a DuckDB binder error.
"""

import asyncio
import json
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..security import User, current_user
from ..serial import jsonable
from .query import MAX_PAGE, QueryRequest, build_sql, start_query

router = APIRouter(prefix="/api/saved", tags=["saved"])

# Profile frequencies are a view of one column, not something to keep.
SAVEABLE = {"slice", "pivot", "sql", "join"}
# Per-run settings, never part of what is saved.
RUNTIME = {"page", "page_size", "confirm_expensive"}
# The event loop holds tasks only weakly; an unreferenced one can be
# collected before it records anything.
_PENDING = set()


class SaveQuery(BaseModel):
    name: str
    spec: dict[str, Any]


class UpdateQuery(BaseModel):
    name: str | None = None
    spec: dict[str, Any] | None = None


class RunQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(500, ge=1, le=MAX_PAGE)
    confirm_expensive: bool = False


def _request(spec, **runtime):
    """spec -> QueryRequest, as a 400 rather than a 422 when malformed."""
    spec = {k: v for k, v in spec.items() if k not in RUNTIME}
    if spec.get("mode") not in SAVEABLE:
        raise HTTPException(400, "only slice, pivot, SQL and join queries "
                                 f"can be saved, not {spec.get('mode')!r}")
    try:
        return QueryRequest(**spec, **runtime)
    except ValidationError as e:
        raise HTTPException(400, f"not a valid query: {e.errors()[0]['msg']}")


def _stored_spec(req):
    return req.model_dump(exclude=RUNTIME)


def _inputs(spec):
    """The relations a spec reads. Unknowable for hand-written SQL."""
    mode = spec.get("mode")
    if mode in ("slice", "pivot"):
        return [spec["relation"]] if spec.get("relation") else []
    if mode == "join":
        rels = [i.get("relation") for i in
                (spec.get("join") or {}).get("inputs") or []]
        return list(dict.fromkeys(r for r in rels if r))
    return []


def _name(raw):
    name = " ".join((raw or "").split())
    if not name:
        raise HTTPException(400, "give the query a name")
    return name


COLUMNS = ("SELECT id, name, owner, created_at, updated_at, spec, sql, "
           "last_run_at FROM _saved_queries")


def _decode(row):
    row = {k: jsonable(v) for k, v in row.items()}
    row["spec"] = json.loads(row["spec"])
    return row


async def _row(engine, qid):
    res = await engine.fetch(f"{COLUMNS} WHERE id = ?", [qid], heavy=False)
    if res.one() is None:
        raise HTTPException(404, "no saved query with that id")
    return _decode(res.one())


async def _name_taken(engine, name, except_id=None):
    res = await engine.fetch(
        "SELECT id FROM _saved_queries WHERE lower(name) = lower(?) "
        "AND id IS DISTINCT FROM ?", [name, except_id], heavy=False)
    return res.scalar() is not None


async def _compile(engine, req):
    """Validate a spec by building it. Cost blocks do not stop a save: they
    are judged again, and must be confirmed, every time it runs."""
    req = req.model_copy(update={"confirm_expensive": True})
    sql, *_ = await build_sql(engine, req)
    return sql


def _summary(row):
    return {"id": row["id"], "name": row["name"],
            "mode": row["spec"].get("mode"), "inputs": _inputs(row["spec"]),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "last_run_at": row["last_run_at"]}


@router.get("")
async def list_saved(engine: Engine = Depends(get_engine)):
    res = await engine.fetch(f"{COLUMNS} ORDER BY lower(name)", heavy=False)
    return {"saved": [_summary(_decode(r)) for r in res.dicts()]}


@router.get("/{qid}")
async def get_saved(qid: str, engine: Engine = Depends(get_engine)):
    row = await _row(engine, qid)
    return {**row, "inputs": _inputs(row["spec"])}


@router.post("")
async def create(req: SaveQuery, engine: Engine = Depends(get_engine),
                 user: User = Depends(current_user)):
    name = _name(req.name)
    if await _name_taken(engine, name):
        raise HTTPException(409, f"a saved query called {name!r} exists")
    query = _request(req.spec)
    sql = await _compile(engine, query)
    qid, now = uuid.uuid4().hex[:12], datetime.now()
    await engine.fetch(
        "INSERT INTO _saved_queries (id, name, owner, created_at, "
        "updated_at, spec, sql, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [qid, name, user.username, now, now, json.dumps(_stored_spec(query)),
         sql, False], heavy=False)
    return _summary(await _row(engine, qid))


@router.put("/{qid}")
async def update(qid: str, req: UpdateQuery,
                 engine: Engine = Depends(get_engine)):
    row = await _row(engine, qid)
    name = _name(req.name) if req.name is not None else row["name"]
    if await _name_taken(engine, name, except_id=qid):
        raise HTTPException(409, f"a saved query called {name!r} exists")
    spec, sql = row["spec"], row["sql"]
    if req.spec is not None:
        query = _request(req.spec)
        sql = await _compile(engine, query)
        spec = _stored_spec(query)
    await engine.fetch(
        "UPDATE _saved_queries SET name = ?, spec = ?, sql = ?, "
        "updated_at = ? WHERE id = ?",
        [name, json.dumps(spec), sql, datetime.now(), qid], heavy=False)
    return _summary(await _row(engine, qid))


@router.delete("/{qid}")
async def delete(qid: str, engine: Engine = Depends(get_engine)):
    row = await _row(engine, qid)
    await engine.fetch("DELETE FROM _saved_queries WHERE id = ?", [qid],
                       heavy=False)
    return {"deleted": row["id"], "name": row["name"]}


@router.post("/{qid}/run")
async def run(qid: str, req: RunQuery,
              engine: Engine = Depends(get_engine),
              registry: JobRegistry = Depends(get_jobs)):
    row = await _row(engine, qid)
    name = row["name"]
    query = _request(row["spec"], page=req.page, page_size=req.page_size,
                     confirm_expensive=req.confirm_expensive)
    try:
        built = await build_sql(engine, query)
    except HTTPException as e:
        if isinstance(e.detail, dict):
            # A gateway review: keep its structure so the UI can offer
            # "run anyway", and say which saved query it was about.
            raise HTTPException(e.status_code, {**e.detail, "query": name})
        raise HTTPException(
            e.status_code,
            f"Saved query {name!r} no longer matches its data: {e.detail}. "
            "A reload may have removed or renamed what it needs; reopen it "
            "to fix the spec.")
    job = start_query(engine, registry, query, built,
                      label=f"saved · {name}")
    task = asyncio.create_task(_record_success(engine, qid, job))
    _PENDING.add(task)
    task.add_done_callback(_PENDING.discard)
    return job.status(engine.queries)


async def _record_success(engine, qid, job):
    """Stamp last_run_at only once the run has actually produced a result.
    Refused, failed and cancelled runs leave the previous value alone."""
    try:
        await job._task
    except BaseException:
        return
    if job.state == "done":
        await engine.fetch(
            "UPDATE _saved_queries SET last_run_at = ? WHERE id = ?",
            [datetime.now(), qid], heavy=False)
