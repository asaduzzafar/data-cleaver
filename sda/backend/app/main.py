"""Data Cleaver (codename SDA) -- FastAPI application.

The desktop app starts through `python -m app` (see __main__.py). For
development, run exactly one worker -- DuckDB's file lock is exclusive, so a
second worker cannot open the database at all:

    uvicorn app.main:app --workers 1 --port 8000
"""

import contextlib
import logging

import duckdb
from fastapi import Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from . import folders
from .sample import Installer
from .config import Config
from .db import Engine, get_engine
from .jobs import JobRegistry
from .registry import CATALOG_VERSION_SQL, COUNTS_SQL
from .routers import (admin, export, files, jobs_api, joins, load, query,
                      relations)
from .routers import folders as folders_api
from .routers import sample as sample_api
from .routers import saved
from .routers import storage
from .security import User, current_user


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = engine = Engine(app.state.config).open()
    app.state.jobs = JobRegistry()
    app.state.sample = Installer()
    if engine.cfg.sample_data and (await app.state.sample.status(engine))["state"] == "not_installed":
        # In the background: the window opens at once and the catalog fills
        # in as the tracked jobs finish.
        app.state.sample.start(engine, app.state.jobs)
    try:
        yield
    finally:
        await app.state.sample.stop()
        # Cancel in-flight work before closing the connection, or DuckDB is
        # torn down underneath a running query.
        await app.state.jobs.shutdown()
        app.state.engine.close()


def create_app(config=None, extra_routers=()):
    # The desktop app logs to a file before it gets here; under a bare
    # `uvicorn app.main:app` nothing would show below WARNING without this.
    if not logging.getLogger().handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = FastAPI(title="Data Cleaver", version="1.0.0", lifespan=lifespan)
    app.state.config = cfg = config or Config.from_env()

    @app.get("/api/health")
    async def health(engine: Engine = Depends(get_engine),
                     user: User = Depends(current_user)):
        cfg = engine.cfg
        counts = (await engine.fetch(COUNTS_SQL, heavy=False)).dicts()[0]
        return {
            "status": "ok",
            "user": user.username,
            "duckdb": duckdb.__version__,
            "database": str(cfg.db_path),
            "folders": await folders.describe(engine),
            "parquet_dir": str(cfg.parquet_dir),
            "memory_limit": cfg.memory_limit,
            "threads": cfg.threads,
            "query_slots": cfg.query_slots,
            "queries": engine.queries.snapshot(),
            "loads": engine.loads.snapshot(),
            "registry": counts,
            "catalog_version": (await engine.fetch(
                CATALOG_VERSION_SQL, heavy=False)).scalar(),
        }

    for module in (relations, query, joins, jobs_api, files, folders_api,
                   sample_api, saved, load, export, admin, storage):
        app.include_router(module.router)
    # Before the /api catch-all below, or it would answer for them.
    for router in extra_routers:
        app.include_router(router)

    if cfg.frontend_dist is not None:
        # Registered before the static mount so an unknown API path is a JSON
        # 404 the UI can read, not a plain-text miss from the file server.
        @app.api_route("/api/{rest:path}",
                       methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
                       include_in_schema=False)
        async def api_not_found(rest: str):
            raise HTTPException(404, f"no such endpoint: /api/{rest}")

        app.mount("/", StaticFiles(directory=cfg.frontend_dist, html=True),
                  name="ui")
    return app


app = create_app()
