"""Watching and cancelling jobs.

The client polls a job's status. Its queue position changes when *another*
job finishes, so each poll reports it afresh rather than waiting on this
job's own state.
"""

from fastapi import APIRouter, Depends, HTTPException

from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("/{job_id}")
async def status(job_id: str,
                 engine: Engine = Depends(get_engine),
                 registry: JobRegistry = Depends(get_jobs)):
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job (it may have expired)")
    queue = engine.loads if job.kind == "load" else engine.queries
    out = job.status(queue)
    if job.state == "done":
        out["result"] = job.result
    return out


@router.delete("/{job_id}")
async def cancel(job_id: str, registry: JobRegistry = Depends(get_jobs)):
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return {"cancelled": registry.cancel(job_id)}
