"""Tracked background work: queries and CSV loads.

Everything that can queue runs as a job, so the client always has something
honest to display. A query that is waiting reports how many are ahead of it
instead of showing the same spinner as one that is running -- people who
cannot tell those apart press Run again, which lengthens the queue that was
the problem in the first place.

Loads are jobs for a different reason: converting a 1.5 GB CSV takes minutes,
which is far past any sensible HTTP timeout.
"""

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field

from fastapi import Request

QUEUED, RUNNING, DONE, ERROR, CANCELLED = (
    "queued", "running", "done", "error", "cancelled")
TERMINAL = {DONE, ERROR, CANCELLED}

# How long a finished job's result stays fetchable. Long enough to survive a
# page flip or a reconnect, short enough that held result pages do not
# accumulate in a process that never restarts.
TTL_SECONDS = 15 * 60
# A query's recipe (its SQL, base and inputs) outlives its page of rows, so
# a result left on screen can still be saved or exported hours later. It is
# a few hundred bytes; the rows are what cost memory.
RECIPE_SECONDS = 12 * 60 * 60

log = logging.getLogger("datacleaver.jobs")


@dataclass
class Job:
    id: str
    kind: str          # "query" | "load"
    label: str
    state: str = QUEUED
    created_at: float = field(default_factory=time.time)
    started_at: float = None
    finished_at: float = None
    result: dict = None
    error: str = None
    # Structured context for an error the client can act on, e.g. the
    # gateway findings behind a refusal. The string alone says nothing about
    # what to do instead.
    detail: dict = None
    progress: str = None
    _task: asyncio.Task = None
    _session: object = None

    def set_state(self, state):
        self.state = state
        if state == RUNNING and self.started_at is None:
            self.started_at = time.time()
        if state in TERMINAL:
            self.finished_at = time.time()

    def set_progress(self, text):
        self.progress = text

    def status(self, queue=None):
        out = {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "state": self.state,
            "progress": self.progress,
            "error": self.error,
            "detail": self.detail,
            "queued_ms": int(1000 * ((self.started_at or time.time())
                                     - self.created_at)),
            "elapsed_ms": int(1000 * ((self.finished_at or time.time())
                                      - (self.started_at or self.created_at))),
        }
        # 0 means "not waiting" -- running, finished, or already granted.
        out["position"] = queue.position(self.id) if queue else 0
        out["ahead"] = max(0, out["position"] - 1)
        if queue is not None:
            out["queue"] = queue.snapshot()
        return out


class JobRegistry:
    def __init__(self):
        self._jobs = {}

    def submit(self, engine, *, kind, label, runner, queue):
        """`runner(job, session)` does the work and returns the result dict.

        The session is opened here so the job holds a slot for its whole life
        and can be interrupted by id from the cancel endpoint.
        """
        job = Job(id=uuid.uuid4().hex[:16], kind=kind, label=label)
        self._jobs[job.id] = job

        async def wrap():
            try:
                async with engine.session(ticket=job.id, queue=queue) as sess:
                    job._session = sess
                    job.set_state(RUNNING)
                    log.info("job %s started: %s", job.id, job.label)
                    job.result = await runner(job, sess)
                    job.set_state(DONE)
                    log.info("job %s done in %.1fs", job.id,
                             job.finished_at - job.started_at)
            except asyncio.CancelledError:
                job.set_state(CANCELLED)
                log.info("job %s cancelled: %s", job.id, job.label)
                raise
            except Exception as exc:  # surfaced to the client verbatim
                job.error = f"{type(exc).__name__}: {exc}"
                job.detail = getattr(exc, "detail", None)
                job.set_state(ERROR)
                # A refusal is the gateway working; anything else is a fault
                # worth its traceback.
                if job.detail is None:
                    log.exception("job %s failed: %s", job.id, job.label)
                else:
                    log.info("job %s refused: %s", job.id, job.error)
            finally:
                job._session = None

        job._task = asyncio.create_task(wrap())
        self._evict()
        return job

    def get(self, job_id):
        return self._jobs.get(job_id)

    def active(self, label):
        """Whether a job with this label is still queued or running."""
        return any(j.label == label and j.state not in TERMINAL
                   for j in self._jobs.values())

    async def wait(self, job):
        """Until `job` ends. A caller that goes away leaves the job running."""
        try:
            await asyncio.shield(job._task)
        except asyncio.CancelledError:
            if not job._task.cancelled():  # the caller was cancelled, not the job
                raise

    def cancel(self, job_id):
        job = self._jobs.get(job_id)
        if job is None or job.state in TERMINAL:
            return False
        # Interrupt the in-flight statement first; cancelling the task alone
        # would leave DuckDB churning on a query nobody is waiting for.
        if job._session is not None:
            job._session.interrupt()
        if job._task is not None:
            job._task.cancel()
        return True

    async def shutdown(self):
        for job in list(self._jobs.values()):
            if job.state not in TERMINAL and job._task is not None:
                job._task.cancel()
                with contextlib.suppress(Exception):
                    await job._task
        self._jobs.clear()

    def _evict(self):
        now = time.time()
        for jid, job in list(self._jobs.items()):
            if job.state not in TERMINAL:
                continue
            age = now - (job.finished_at or 0)
            recipe = isinstance(job.result, dict) and "sql" in job.result
            if age > (RECIPE_SECONDS if recipe else TTL_SECONDS):
                del self._jobs[jid]
            elif recipe and age > TTL_SECONDS and "rows" in job.result:
                # Keep what save and export read; drop the page. `expired`
                # tells a client polling it to run the query again.
                job.result = {k: v for k, v in job.result.items()
                              if k not in ("rows", "columns", "types")}
                job.result["expired"] = True


def get_jobs(request: Request) -> JobRegistry:
    """FastAPI dependency: the registry stored on app state by the lifespan."""
    return request.app.state.jobs
