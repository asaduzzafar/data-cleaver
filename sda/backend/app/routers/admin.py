"""Backups.

The backup endpoint exists because of the file lock. While this process holds
the database, nothing else on the machine can read it -- so the usual answer,
a nightly file-level snapshot, is not merely inconvenient: copying the file
mid-write can produce something that looks like a backup, sits in the backup
folder at a plausible size, and will not open. Running EXPORT DATABASE from
inside the process avoids that, because the process knows when it is safe.

What this protects is not the bulk data. Sources live in Parquet outside the
lock and can be reloaded from the CSVs regardless. It protects the registry --
who cut which slice from what, when, with what SQL. An afternoon reloads an
extract; nothing reconstructs months of lineage.
"""

from datetime import datetime

from fastapi import APIRouter, Depends

from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..sqlgen import lit

router = APIRouter(prefix="/api/admin", tags=["admin"])

@router.get("/backups")
async def backups(engine: Engine = Depends(get_engine)):
    root = engine.cfg.db_path.parent / "backups"
    if not root.is_dir():
        return {"root": str(root), "backups": []}
    out = []
    for d in sorted(root.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        files = [f for f in d.rglob("*") if f.is_file()]
        out.append({
            "name": d.name,
            "path": str(d),
            "files": len(files),
            "bytes": sum(f.stat().st_size for f in files),
            "created": datetime.fromtimestamp(
                d.stat().st_mtime).isoformat(timespec="seconds"),
        })
    return {"root": str(root), "backups": out}


@router.post("/backup")
async def backup(engine: Engine = Depends(get_engine),
                 registry: JobRegistry = Depends(get_jobs)):
    """Write a consistent copy of the registry and every saved slice."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = engine.cfg.db_path.parent / "backups" / stamp
    target.parent.mkdir(parents=True, exist_ok=True)

    async def runner(job, sess):
        job.set_progress("exporting the database")
        await sess.run(
            f"EXPORT DATABASE {lit(target.as_posix())} (FORMAT parquet)")
        files = [f for f in target.rglob("*") if f.is_file()]
        return {
            "path": str(target),
            "name": stamp,
            "files": len(files),
            "bytes": sum(f.stat().st_size for f in files),
            # Worth restating wherever this result is shown.
            "note": ("Registry and saved slices only. Source Parquet files "
                     "live outside the database and are not included -- they "
                     "are reloadable from the CSVs."),
        }

    job = registry.submit(
        engine, kind="query", label=f"backup {stamp}",
        runner=runner, queue=engine.queries)
    return job.status(engine.queries)
