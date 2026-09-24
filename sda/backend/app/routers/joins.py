"""Join key probe: measure a join before trusting it.

Query submission runs the same probe itself, so this endpoint is for the
builder to show the numbers while keys are still being chosen -- not a step a
client can skip to get a join past the fan-out check.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import joins, sqlgen
from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs

router = APIRouter(prefix="/api/joins", tags=["joins"])


class ProbeRequest(BaseModel):
    join: dict[str, Any]


@router.post("/probe")
async def probe(req: ProbeRequest,
                engine: Engine = Depends(get_engine),
                registry: JobRegistry = Depends(get_jobs)):
    try:
        plan = await joins.resolve(engine, req.join)
    except sqlgen.SqlError as e:
        raise HTTPException(400, str(e))

    async def runner(job, sess):
        found = await joins.probe(sess, plan, job)
        return {"steps": found["steps"],
                "review": found["review"].as_dict()}

    # A full scan of every key column, so it queues like any heavy read.
    job = registry.submit(
        engine, kind="query", label=f"join probe · {' + '.join(plan.inputs)}",
        runner=runner, queue=engine.queries)
    return job.status(engine.queries)
