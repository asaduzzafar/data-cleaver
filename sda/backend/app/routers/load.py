"""Loading a CSV: detect columns, then convert to Parquet and register it.

Carried over from the two-step loader in v3, the Streamlit predecessor, which
exists for a reason worth restating: DuckDB will happily type an account or
order number as BIGINT, and that silently strips leading zeros on the way into
Parquet. No export format puts them back, and the only fix is a reload. So the
detect step runs first and pre-selects the ID-shaped columns to force to text.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import sqlgen
from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..security import User, current_user
from .files import resolve_within

router = APIRouter(prefix="/api/load", tags=["load"])

# Columns whose names suggest an identifier rather than a quantity.
ID_HINTS = ("number", "id", "code", "account", "ref", "sku", "isbn", "zip",
            "postal", "phone")


class DetectRequest(BaseModel):
    path: str
    delim: str = ","
    nullstr: str = "\\N"
    # Detect previews the view name, so the override belongs here rather than
    # only on the load step.
    name: str | None = Field(None, description="override the derived view name")


class LoadRequest(DetectRequest):
    force_text: list[str] = []


def _looks_like_id(name, dtype):
    return dtype != "VARCHAR" and any(h in name.lower() for h in ID_HINTS)


def _read_csv_call(posix_path, delim, nullstr, *, sample, types=None,
                   rejects=False, ignore_errors=False):
    # An empty field is always NULL, on top of whatever marker the analyst
    # set. With the marker alone, a blank ID loaded as '' (and matched every
    # other blank ID in a join), and one blank in a numeric column turned the
    # whole column into text.
    nulls = ", ".join(sqlgen.lit(s) for s in dict.fromkeys([nullstr, ""]))
    parts = [sqlgen.lit(posix_path),
             f"delim = {sqlgen.lit(delim)}",
             f"nullstr = [{nulls}]",
             f"sample_size = {sample}"]
    if rejects:
        parts.append("store_rejects = true")
    if ignore_errors:
        parts.append("ignore_errors = true")
    if types:
        inner = ", ".join(f"{sqlgen.lit(c)}: 'VARCHAR'" for c in types)
        parts.append(f"types = {{{inner}}}")
    return f"read_csv({', '.join(parts)})"


@router.post("/detect")
async def detect(req: DetectRequest, engine: Engine = Depends(get_engine)):
    """Sample the file for its column types, without converting anything."""
    _, target = await resolve_within(engine, req.path)
    if not target.is_file():
        raise HTTPException(404, f"no such file: {req.path}")

    # ignore_errors matters here: without it, DESCRIBE fails outright on any
    # file containing a malformed row -- which is exactly the file you most
    # want to inspect before committing to a load.
    #
    # sample_size is 20480 so this stays quick on a 1.5 GB file. The load
    # itself uses -1, so the types below are a preview, not a promise: a
    # column can sniff as BIGINT here and still land as VARCHAR after the
    # full scan sees a zero-padded value further down the file.
    call = _read_csv_call(target.as_posix(), req.delim, req.nullstr,
                          sample=20480, ignore_errors=True)
    try:
        res = await engine.fetch(f"DESCRIBE SELECT * FROM {call} LIMIT 0")
    except Exception as e:
        raise HTTPException(400, f"could not read that file: {e}")

    cols = [{"name": r[0], "type": r[1],
             "suggest_text": _looks_like_id(r[0], r[1])} for r in res.rows]
    view = sqlgen.slug(req.name or target.name)
    prior = await engine.fetch(
        "SELECT csv_path, loaded_at FROM _sources WHERE view_name = ?",
        [view], heavy=False)
    prior_row = prior.one()

    return {
        "path": req.path,
        "bytes": target.stat().st_size,
        "view_name": view,
        "parquet_name": f"{view}.parquet",
        "columns": cols,
        "suggested_text": [c["name"] for c in cols if c["suggest_text"]],
        # A reload is legitimate, but it makes every slice cut from the old
        # extract stale, so the UI needs to say so before the button is pressed.
        "already_registered": bool(prior_row),
        "prior_csv_path": (prior_row or {}).get("csv_path"),
        "prior_loaded_at": str((prior_row or {}).get("loaded_at") or "") or None,
    }


@router.post("")
async def start(req: LoadRequest,
                engine: Engine = Depends(get_engine),
                registry: JobRegistry = Depends(get_jobs),
                user: User = Depends(current_user)):
    """Convert the CSV to Parquet, register the view, capture rejected rows.

    Runs on the single-slot load queue: a 1.5 GB conversion competes with
    nobody. Progress is reported per phase rather than per row -- DuckDB does
    not expose row-level progress for COPY, and inventing a percentage would
    be worse than naming the step honestly.
    """
    _, target = await resolve_within(engine, req.path)
    if not target.is_file():
        raise HTTPException(404, f"no such file: {req.path}")

    view = sqlgen.slug(req.name or target.name)
    if not view:
        raise HTTPException(400, "that name reduces to nothing usable")
    job = submit_load(engine, registry, user.username, target, view,
                      force_text=req.force_text, delim=req.delim,
                      nullstr=req.nullstr)
    return job.status(engine.loads)


def submit_load(engine, registry, owner, target, view, *, force_text=(),
                delim=",", nullstr="\\N", label=None):
    """Queue a CSV -> Parquet load as a tracked job. -> Job.

    The one load path: the endpoint and the sample-data installer both come
    through here, so sample sources are loaded exactly as a user's would be.
    `target` must already be checked against the added folders.
    """
    force_text = list(force_text)
    pq_path = engine.cfg.parquet_dir / f"{view}.parquet"
    csv_posix = target.as_posix()

    async def runner(job, sess):
        job.set_progress("preparing")
        pq_path.parent.mkdir(parents=True, exist_ok=True)
        # store_rejects writes reject_errors into this connection's temp
        # schema; clear any leftover from a previous statement on this cursor.
        await sess.run("DROP TABLE IF EXISTS reject_errors")

        call = _read_csv_call(csv_posix, delim, nullstr, sample=-1,
                              types=force_text, rejects=True)
        job.set_progress(f"converting {target.name} to Parquet")
        await sess.run(
            f"COPY (SELECT * FROM {call}) TO {sqlgen.lit(pq_path.as_posix())} "
            "(FORMAT parquet, COMPRESSION zstd)")

        job.set_progress("registering the view")
        await sess.run(
            f'CREATE OR REPLACE VIEW "{view}" AS SELECT * FROM '
            f"read_parquet({sqlgen.lit(pq_path.as_posix())})")
        n = (await sess.run(f'SELECT count(*) FROM "{view}"')).scalar()

        job.set_progress("recording rejected rows")
        await sess.run("DELETE FROM _rejects WHERE source = ?", [view])
        rejected = 0
        try:
            await sess.run(
                "INSERT INTO _rejects SELECT ?, line, column_name, error_type, "
                "csv_line, error_message FROM reject_errors", [view])
            rejected = (await sess.run(
                "SELECT count(*) FROM _rejects WHERE source = ?",
                [view])).scalar()
        except Exception:
            # No rejects table means the parser rejected nothing.
            pass

        await sess.run(
            "INSERT OR REPLACE INTO _sources VALUES (?,?,?,?,?,?,?)",
            [view, str(target), str(pq_path), datetime.now(), n,
             ", ".join(force_text), owner])
        return {
            "view_name": view,
            "rows": n,
            "rejected": rejected,
            "parquet_path": str(pq_path),
            "csv_path": str(target),
            "forced_to_text": force_text,
        }

    return registry.submit(
        engine, kind="load", label=label or f"load {target.name}",
        runner=runner, queue=engine.loads)
