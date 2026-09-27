"""Where the database and the Parquet copies live, and moving them.

The desktop app lets the user pick both folders (Settings, with the Windows
folder picker). Choosing a database folder starts fresh there: it opens the
Data Cleaver database already in that folder, or creates an empty one, and
leaves the previous database where it was, untouched. Choosing a Parquet
folder changes where new loads write; sources already loaded keep reading
their existing files.

Both switch the running engine over, so they are refused while anything is
running: a query must never have its connection closed underneath it.
"""

import dataclasses

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import prefs
from ..db import Engine, get_engine
from ..jobs import TERMINAL, JobRegistry, get_jobs

router = APIRouter(prefix="/api/admin/storage", tags=["admin"])


class StorageChange(BaseModel):
    database_dir: str | None = None
    parquet_dir: str | None = None


def _describe(engine):
    cfg = engine.cfg
    return {"database_dir": cfg.db_path.parent.as_posix(),
            "parquet_dir": cfg.parquet_dir.as_posix(),
            # Only the desktop profile keeps preferences; elsewhere the
            # locations come from the environment and are read-only.
            "changeable": cfg.app_dir is not None}


@router.get("")
async def storage(engine: Engine = Depends(get_engine)):
    return _describe(engine)


@router.post("")
async def change(req: StorageChange, request: Request,
                 engine: Engine = Depends(get_engine),
                 registry: JobRegistry = Depends(get_jobs)):
    cfg = engine.cfg
    if cfg.app_dir is None:
        raise HTTPException(400, "these locations are fixed in this setup")
    busy = [j for j in registry._jobs.values() if j.state not in TERMINAL]
    if busy or request.app.state.sample.state == "installing":
        raise HTTPException(409, "wait for running work to finish (or cancel "
                                 "it) before moving where data is kept")

    changes, updates = {}, {}
    for field, raw in (("database_dir", req.database_dir),
                       ("parquet_dir", req.parquet_dir)):
        if raw is None:
            continue
        folder, why = prefs.usable_folder(raw)
        if folder is None:
            raise HTTPException(400, f"{field.replace('_', ' ')}: {why}")
        changes[field] = folder.as_posix()
        if field == "database_dir":
            updates["db_path"] = folder / prefs.DB_FILE
        else:
            updates["parquet_dir"] = folder
    if not updates:
        return _describe(engine)

    # Open the new engine before closing the old one: if the new database
    # cannot be opened, nothing has changed.
    new_cfg = dataclasses.replace(cfg, **updates)
    try:
        new_engine = Engine(new_cfg).open()
    except Exception as exc:
        raise HTTPException(400, f"could not open a database there: {exc}")
    request.app.state.engine = new_engine
    request.app.state.config = new_cfg
    engine.close()
    prefs.save(cfg.app_dir, **changes)

    # A fresh database gets the demo data too, when the user has it on.
    installer = request.app.state.sample
    if "db_path" in updates and prefs.load(cfg.app_dir).get("demo_data", True) \
            and (await installer.status(new_engine))["state"] == "not_installed":
        installer.start(new_engine, registry)
    return _describe(new_engine)
