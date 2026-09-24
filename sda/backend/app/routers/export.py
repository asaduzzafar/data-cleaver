"""Exporting a result as a file.

In the desktop app the file is written straight into the user's export
folder (Downloads until they choose another, remembered in the preferences
file), and the app says exactly where it went and can show it in Explorer.
A browser download from the embedded window would land wherever WebView2
decided, unannounced.

Outside the desktop profile (development, tests) the machine running the
server is not the user's, so the file is written to a scratch directory and
streamed back as a download, then deleted.

The format advice carries over unchanged: CSV holds no type information, so
Excel re-guesses every column on open and the leading zeros you protected at
load time are lost again on the way out.
"""

import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

import duckdb
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import gateway, prefs
from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..sqlgen import lit

router = APIRouter(prefix="/api/export", tags=["export"])

EXCEL_ROW_LIMIT = 1_048_576
FORMATS = {
    "xlsx": ("FORMAT xlsx, HEADER true, SHEET 'data'",
             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "parquet": ("FORMAT parquet, COMPRESSION zstd",
                "application/vnd.apache.parquet"),
    "csv": ("FORMAT csv, HEADER true", "text/csv"),
}


class ExportRequest(BaseModel):
    job_id: str
    format: str = "xlsx"
    filename: str = "export"
    confirm_expensive: bool = False


class FolderChange(BaseModel):
    folder: str


def export_dir(cfg):
    """The desktop profile's export folder, or None outside it."""
    if cfg.app_dir is None:
        return None
    chosen = prefs.load(cfg.app_dir).get("export_dir")
    if chosen:
        return Path(chosen)
    downloads = Path.home() / "Downloads"
    return downloads if downloads.is_dir() else Path.home()


@router.get("/folder")
async def folder(engine: Engine = Depends(get_engine)):
    where = export_dir(engine.cfg)
    return {"folder": where.as_posix() if where else None,
            "changeable": where is not None}


@router.post("/folder")
async def change_folder(req: FolderChange, engine: Engine = Depends(get_engine)):
    if engine.cfg.app_dir is None:
        raise HTTPException(400, "exports are downloaded in this setup")
    where, why = prefs.usable_folder(req.folder)
    if where is None:
        raise HTTPException(400, f"export folder: {why}")
    prefs.save(engine.cfg.app_dir, export_dir=where.as_posix())
    return {"folder": where.as_posix(), "changeable": True}


def safe_name(name):
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "_", name or "").strip("._-")
    return cleaned[:80] or "export"


@router.post("")
async def start(req: ExportRequest,
                engine: Engine = Depends(get_engine),
                registry: JobRegistry = Depends(get_jobs)):
    if req.format not in FORMATS:
        raise HTTPException(400, f"unknown format: {req.format}")
    source = registry.get(req.job_id)
    if source is None or source.state != "done" or not source.result:
        raise HTTPException(404, "no finished query with that id")

    total = source.result.get("total") or 0
    if req.format == "xlsx" and total > EXCEL_ROW_LIMIT:
        raise HTTPException(
            400, f"Too many rows for Excel: {total:,} rows, and one Excel sheet "
                 f"holds at most {EXCEL_ROW_LIMIT:,}. Export as parquet or csv, "
                 f"or filter to fewer rows.")

    # Exports get the exact count rather than an estimate, because the query
    # has already run. Nothing is paged here -- the whole result is written.
    review = gateway.review_export(total, req.format)
    if review.verdict == "block" and not req.confirm_expensive:
        raise HTTPException(400, {"error": "gateway", **review.as_dict()})

    sql = source.result["sql"]
    opts, _ = FORMATS[req.format]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    chosen = export_dir(engine.cfg)
    if chosen is not None:
        out_dir, why = prefs.usable_folder(chosen.as_posix())
        if out_dir is None:
            raise HTTPException(400, f"export folder: {why}. Choose another.")
    else:
        out_dir = engine.cfg.db_path.parent / "exports"
        out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{safe_name(req.filename)}-{stamp}.{req.format}"

    async def runner(job, sess):
        if req.format == "xlsx":
            # The excel extension is loaded on demand. The packaged app ships
            # it pre-installed, so LOAD succeeds offline; only a source
            # checkout without it downloads it once.
            job.set_progress("loading the excel extension")
            try:
                await sess.run("LOAD excel")
            except duckdb.Error:
                await sess.run("INSTALL excel")
                await sess.run("LOAD excel")
        job.set_progress(f"writing {total:,} rows")
        await sess.run(f"COPY ({sql}) TO {lit(target.as_posix())} ({opts})")
        return {
            "path": str(target),
            "filename": target.name,
            "format": req.format,
            "rows": total,
            "bytes": target.stat().st_size if target.exists() else 0,
            "download": f"/api/export/{{job_id}}/download",
            # Written to the user's own folder: nothing to collect.
            "saved": chosen is not None,
            "gateway": review.as_dict() if review.findings else None,
        }

    job = registry.submit(
        engine, kind="query", label=f"export {req.format}", runner=runner,
        queue=engine.queries)
    return job.status(engine.queries)


@router.get("/{job_id}/download")
async def download(job_id: str,
                   registry: JobRegistry = Depends(get_jobs)):
    job = registry.get(job_id)
    if job is None or job.state != "done" or not job.result:
        raise HTTPException(404, "no finished export with that id")
    if job.result.get("saved"):
        raise HTTPException(400, f"that export was saved to {job.result['path']}")
    path = Path(job.result["path"])
    if not path.exists():
        raise HTTPException(410, "that export has already been collected")
    _, media = FORMATS[job.result["format"]]
    # One collection per export: the scratch copy goes as soon as it is sent,
    # so the server does not accumulate everyone's extracts.
    return FileResponse(
        path, media_type=media, filename=path.name,
        background=BackgroundTask(path.unlink, missing_ok=True))


def _reveal(path):
    """Open Explorer on the file, selected. Windows only."""
    subprocess.Popen(["explorer", f"/select,{Path(path)}"])


@router.post("/{job_id}/reveal")
async def reveal(job_id: str,
                 registry: JobRegistry = Depends(get_jobs)):
    job = registry.get(job_id)
    if job is None or job.state != "done" or not (job.result or {}).get("saved"):
        raise HTTPException(404, "no saved export with that id")
    if not Path(job.result["path"]).exists():
        raise HTTPException(410, "that file has been moved or deleted")
    if os.name != "nt":
        raise HTTPException(400, "showing a file in its folder needs Windows")
    _reveal(job.result["path"])
    return {"shown": job.result["path"]}
