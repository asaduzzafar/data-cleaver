"""Relations: what exists, what it looks like, and removing it."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .. import catalog, outliers, profile, sqlgen
from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..serial import result_to_json

router = APIRouter(prefix="/api/relations", tags=["relations"])


async def _schema_or_404(engine, name):
    try:
        return await catalog.schema_of(engine, name)
    except KeyError:
        raise HTTPException(404, f"no such relation: {name}")


@router.get("")
async def list_relations(engine: Engine = Depends(get_engine)):
    return {"relations": await catalog.relations(engine)}


@router.get("/{name}/schema")
async def relation_schema(name: str, engine: Engine = Depends(get_engine)):
    schema = await _schema_or_404(engine, name)
    return {
        "relation": name,
        "columns": [{"name": c, "type": t} for c, t in schema.items()],
    }


@router.get("/{name}/values")
async def distinct_values(
    name: str,
    column: str,
    search: str = "",
    limit: int = Query(200, ge=1, le=1000),
    engine: Engine = Depends(get_engine),
):
    """Distinct values with counts, for the IN picker.

    v3 offered a blind `SELECT DISTINCT ... LIMIT 1000` with no counts and no
    search, so in any high-cardinality column the values you wanted were
    usually the ones cut off. Searching server-side and ordering by frequency
    means the truncation stops hiding things that matter.
    """
    schema = await _schema_or_404(engine, name)
    col = sqlgen.column(column, schema)
    where = ""
    params = []
    if search:
        where = f" AND CAST({col} AS VARCHAR) ILIKE ?"
        params.append(f"%{search}%")
    sql = (f"SELECT {col} AS value, count(*) AS rows FROM \"{name}\" "
           f"WHERE {col} IS NOT NULL{where} "
           f"GROUP BY 1 ORDER BY rows DESC, 1 LIMIT {int(limit)}")
    res = await engine.fetch(sql, params or None)
    total = await engine.fetch(
        f'SELECT count(DISTINCT {col}) FROM "{name}"', heavy=False)
    return {
        "values": result_to_json(res)["rows"],
        "distinct_total": total.scalar(),
        "truncated": (total.scalar() or 0) > limit and not search,
    }


@router.post("/{name}/profile")
async def profile_relation(name: str, engine: Engine = Depends(get_engine),
                           registry: JobRegistry = Depends(get_jobs)):
    """The Profile step: what is in a relation, and what is worth a look.

    A full scan of every column, so it runs as a job and queues like any
    heavy read."""
    schema = await _schema_or_404(engine, name)
    rejected = (await engine.fetch(
        "SELECT count(*) FROM _rejects WHERE source = ?", [name],
        heavy=False)).scalar() or 0

    async def runner(job, sess):
        return await profile.profile(sess, name, schema, rejected=rejected,
                                     job=job)

    job = registry.submit(engine, kind="query", label=f"profile · {name}",
                          runner=runner, queue=engine.queries)
    return job.status(engine.queries)


class OutlierRequest(BaseModel):
    # How far past the middle half counts as extreme: 1.5 is Tukey's usual
    # fence, 3 his "far out".
    k: float = Field(1.5, ge=1.5, le=3.0)
    # A category seen at most this many times is rare.
    n: int = Field(5, ge=1, le=100)


@router.post("/{name}/outliers")
async def outliers_relation(name: str, req: OutlierRequest,
                            engine: Engine = Depends(get_engine),
                            registry: JobRegistry = Depends(get_jobs)):
    """The Outliers step: four checks, each finding with the exact rows it
    counts, as a query the client can run to show them."""
    schema = await _schema_or_404(engine, name)

    async def runner(job, sess):
        return await outliers.check(sess, name, schema, k=req.k, n=req.n,
                                    job=job)

    job = registry.submit(engine, kind="query", label=f"outliers · {name}",
                          runner=runner, queue=engine.queries)
    return job.status(engine.queries)


@router.get("/{name}/rejects")
async def rejects(name: str, limit: int = Query(1000, ge=1, le=10000),
                  engine: Engine = Depends(get_engine)):
    """Rows the parser skipped. They are absent from every row count the UI
    shows, so totals will not reconcile against the source CSV without them."""
    res = await engine.fetch(
        "SELECT line, column_name, error_type, csv_line, error_message "
        "FROM _rejects WHERE source = ? ORDER BY line LIMIT ?",
        [name, limit], heavy=False)
    total = await engine.fetch(
        "SELECT count(*) FROM _rejects WHERE source = ?", [name], heavy=False)
    return {**result_to_json(res), "total": total.scalar(),
            "truncated": (total.scalar() or 0) > limit}


@router.delete("/{name}")
async def remove(name: str, engine: Engine = Depends(get_engine)):
    """Drop a relation and forget its registry rows.

    Dependents are reported rather than blocked: the caller was shown them
    before confirming. The Parquet file is deliberately left on disk -- it is
    the expensive artefact, and an accidental delete should be recoverable.
    """
    rels = {r["name"]: r for r in await catalog.relations(engine)}
    if name not in rels:
        raise HTTPException(404, f"no such relation: {name}")
    target = rels[name]
    dependents = [r["name"] for r in rels.values()
                  if name in (r.get("inputs") or [])]
    await catalog.drop(engine, target)
    return {"removed": name, "orphaned_slices": dependents,
            "parquet_kept": target.get("parquet_path")}
