"""Running queries as tracked jobs.

Every heavy read is a job, so the client can always say whether a query is
running or merely waiting, and can cancel either. Page flips are jobs too: on
a filtered 12M-row relation a page is a full rescan, not a cheap seek.
"""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import catalog, folders, gateway, joins, sqlgen
from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..security import User, current_user
from ..serial import result_to_json

router = APIRouter(prefix="/api/query", tags=["query"])

MAX_PAGE = 5000


class QueryRequest(BaseModel):
    mode: Literal["slice", "pivot", "sql", "frequencies", "join", "preview",
                  "check"]
    relation: str | None = None
    page: int = Field(1, ge=1)
    page_size: int = Field(500, ge=1, le=MAX_PAGE)
    # slice
    columns: list[str] = []
    filters: dict[str, Any] | None = None
    sort: str | None = None
    desc: bool = False
    # pivot
    rows: list[str] = []
    value: str | None = None
    agg: str = "sum"
    column_field: str | None = None
    # sql / frequencies
    sql: str | None = None
    column: str | None = None
    # join -- see sqlgen.plan_join for the shape. filters/sort/desc above
    # apply to the joined output.
    join: dict[str, Any] | None = None
    # preview: first rows as stored, or a seeded sample. Size is page_size.
    preview: Literal["head", "sample"] | None = None
    seed: int = 1
    # check: the rows behind an Outliers finding a slice cannot express
    check: Literal["duplicates", "mostly_blank"] | None = None
    # Set by the client after the user reads a cost warning and chooses to go
    # ahead. It never overrides a safety denial.
    confirm_expensive: bool = False


class SaveRequest(BaseModel):
    job_id: str
    name: str
    # True returns the save as a job to watch, as the UI does: writing out a
    # 12M-row slice takes minutes. False waits and returns the result.
    background: bool = False


def gateway_error(review):
    """Return the whole Review to the client, not just a sentence.

    The UI needs the findings and their suggestions to be useful -- a bare
    "query refused" tells an analyst nothing about what to do instead.
    """
    return HTTPException(
        status_code=403 if review.verdict == "deny" else 400,
        detail={"error": "gateway", **review.as_dict()})


async def build_sql(engine, req):
    """-> (sql, base, inputs, review, plan). Raises 400/403/404 on bad input.

    `plan` is the JoinPlan in join mode, whose keys the job probes before it
    runs, and None otherwise.
    """
    if req.mode == "join":
        try:
            plan = await joins.resolve(engine, req.join)
            sql = sqlgen.build_join(plan, filters=req.filters,
                                    sort=req.sort, desc=req.desc)
        except sqlgen.SqlError as e:
            raise HTTPException(400, str(e))
        review = await gateway.review_generated(engine, sql)
        # The probe replaces the planner's generic "fan-out unknown" warning
        # with measured numbers, so that one is dropped rather than shown
        # beside a finding that contradicts it.
        kept = [f for f in review.findings if f.rule != "join_fanout_unknown"]
        review = gateway.Review(gateway._verdict(kept), kept,
                                review.estimated_rows, review.scanned_rows,
                                review.operators)
        if review.verdict == "block" and not req.confirm_expensive:
            raise gateway_error(review)
        return sql, plan.base, plan.inputs, review, plan

    if req.mode == "sql":
        if not (req.sql or "").strip():
            raise HTTPException(400, "no SQL supplied")
        sql = req.sql.strip().rstrip(";")

        review = await gateway.review_sql(
            engine, sql,
            allowed_roots=(*await folders.roots(engine),
                           engine.cfg.parquet_dir))
        # A cost block is "are you sure?" and the caller may confirm it. A
        # denial is a safety decision and is never overridable from here.
        if review.verdict == "deny":
            raise gateway_error(review)
        if review.verdict == "block" and not req.confirm_expensive:
            raise gateway_error(review)

        # Inputs are unknowable for hand-written SQL, so a slice saved from
        # here records none and reports its staleness as unknown rather than
        # inventing a parent.
        return sql, req.relation, [], review, None

    if not req.relation:
        raise HTTPException(400, "no relation selected")
    try:
        schema = await catalog.schema_of(engine, req.relation)
    except KeyError:
        raise HTTPException(404, f"no such relation: {req.relation}")

    if req.mode == "preview":
        rel = next(r for r in await catalog.relations(engine)
                   if r["name"] == req.relation)
        try:
            sql = sqlgen.build_preview(
                req.relation, req.preview or "head", size=req.page_size,
                seed=req.seed,
                parquet_path=rel.get("parquet_path")
                if rel["kind"] == "source" else None)
        except sqlgen.SqlError as e:
            raise HTTPException(400, str(e))
        # Built from the registry's own path and a checked name: only the
        # cost pass applies, as for every generated statement.
        review = await gateway.review_generated(engine, sql)
        return sql, req.relation, [req.relation], review, None

    try:
        if req.mode == "slice":
            sql = sqlgen.build_slice(
                req.relation, schema, columns=req.columns,
                filters=req.filters, sort=req.sort, desc=req.desc)
        elif req.mode == "pivot":
            sql = sqlgen.build_pivot(
                req.relation, schema, rows=req.rows, value=req.value,
                agg=req.agg, column_field=req.column_field,
                filters=req.filters)
        elif req.mode == "check":
            sql = sqlgen.build_check(req.relation, schema, req.check,
                                     column_name=req.column)
        else:
            sql = sqlgen.build_frequencies(req.relation, schema, req.column)
    except sqlgen.SqlError as e:
        raise HTTPException(400, str(e))

    # The builders can still produce something expensive -- a pivot grouping
    # 12M rows by a high-cardinality column costs the same whoever wrote it.
    review = await gateway.review_generated(engine, sql)
    if review.verdict == "block" and not req.confirm_expensive:
        raise gateway_error(review)
    return sql, req.relation, [req.relation], review, None


@router.post("")
async def submit(req: QueryRequest,
                 engine: Engine = Depends(get_engine),
                 registry: JobRegistry = Depends(get_jobs)):
    """Start a query. Returns immediately with a job to watch."""
    built = await build_sql(engine, req)
    return start_query(engine, registry, req, built).status(
        engine.queries)


def start_query(engine, registry, req, built, *, label=None):
    """Run an already-built query as a tracked job. -> Job.

    The one execution path: live queries and saved-query runs both come
    through here, so a saved query is judged and run exactly as if it had
    been typed fresh.
    """
    sql, base, inputs, review, plan = built
    offset = (req.page - 1) * req.page_size

    async def runner(job, sess):
        probed = None
        if plan is not None:
            # Inside the job, so it holds the slot the join will use, and
            # never skipped: a client that did not call /joins/probe first is
            # exactly the case the check exists for.
            found = await joins.probe(sess, plan, job)
            if found["review"].verdict == "block" and not req.confirm_expensive:
                raise gateway.Rejected(found["review"])
            probed = {"steps": found["steps"],
                      "review": found["review"].as_dict()}
        job.set_progress("counting rows")
        total = (await sess.run(sqlgen.wrap_count(sql))).scalar() or 0
        preview = None
        if req.mode == "preview":
            # Say what these rows are: which look, how many, out of how many.
            of = (await sess.run(
                f"SELECT count(*) FROM {sqlgen.qi(base)}")).scalar() or 0
            kind = req.preview or "head"
            preview = {"kind": kind, "size": total, "of": of,
                       "seed": req.seed if kind == "sample" else None,
                       "order": "stored" if kind == "head" else "random"}
        job.set_progress(f"fetching rows {offset + 1}-{offset + req.page_size}")
        page = await sess.run(sqlgen.wrap_page(sql, req.page_size, offset))
        pages = max(1, -(-total // req.page_size))
        return {
            "sql": sql, "base": base, "inputs": inputs, "mode": req.mode,
            "total": total, "page": req.page, "pages": pages,
            "page_size": req.page_size,
            # Warnings that did not stop the query still reach the analyst.
            "gateway": review.as_dict() if review.findings else None,
            # Join mode only: the measured key quality, shown beside the rows.
            "probe": probed,
            # Preview mode only: what these rows are.
            "preview": preview,
            **result_to_json(page),
        }

    return registry.submit(
        engine, kind="query", label=label or f"{req.mode} · {base or 'sql'}",
        runner=runner, queue=engine.queries)


@router.post("/save")
async def save(req: SaveRequest,
               engine: Engine = Depends(get_engine),
               registry: JobRegistry = Depends(get_jobs),
               user: User = Depends(current_user)):
    """Materialise a finished query as a named table, and record its lineage.

    The SQL comes from the job rather than the request body, so nothing can be
    materialised that did not already pass build_sql and the read-only guard.
    """
    job = registry.get(req.job_id)
    if job is None or job.state != "done" or not job.result:
        raise HTTPException(404, "no finished query with that id")
    name = sqlgen.slug(req.name)
    if not name:
        raise HTTPException(400, "that name reduces to nothing usable")

    existing = {r["name"]: r for r in await catalog.relations(engine)}
    prior = existing.get(name)
    if prior and prior["kind"] == "source":
        raise HTTPException(409, f"{name} is a loaded source, not a slice")

    # Two writes of one table collide inside DuckDB; say so instead of
    # letting the second one fail as a server error.
    label = f"save · {name}"
    if registry.active(label):
        raise HTTPException(409, f"{name} is already being saved")

    sql = job.result["sql"]
    inputs = job.result.get("inputs") or []
    base = job.result.get("base")
    total = job.result.get("total")

    async def runner(save_job, s):
        save_job.set_progress(
            f"writing {total:,} rows" if total is not None else "writing rows")
        await s.run(f'CREATE OR REPLACE TABLE "{name}" AS {sql}')
        save_job.set_progress("recording lineage")
        n = (await s.run(f'SELECT count(*) FROM "{name}"')).scalar()
        origin = await s.run(
            "SELECT csv_path FROM _sources WHERE view_name = ?", [base])
        await s.run(
            "INSERT OR REPLACE INTO _lineage VALUES (?,?,?,?,?,?,?)",
            [name, base, origin.scalar() or base, datetime.now(), n, sql,
             user.username])
        await s.run("DELETE FROM _lineage_inputs WHERE table_name = ?", [name])
        for src in inputs:
            await s.run(
                "INSERT OR REPLACE INTO _lineage_inputs VALUES (?,?)",
                [name, src])
        return {"saved": name, "rows": n, "source": base, "inputs": inputs,
                "owner": user.username}

    saving = registry.submit(engine, kind="query", label=label,
                             runner=runner, queue=engine.queries)
    if req.background:
        return saving.status(engine.queries)
    await registry.wait(saving)
    if saving.state != "done":
        raise HTTPException(500, saving.error or f"save {saving.state}")
    return saving.result
