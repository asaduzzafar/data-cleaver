"""Adding and removing the folders the app may read.

The desktop shell feeds this from the native folder picker; the web UI falls
back to typing a path. Either way the server validates it: absolute, an
existing directory, and not already covered by a folder on the list.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import folders
from ..db import Engine, get_engine

router = APIRouter(prefix="/api/folders", tags=["folders"])


class FolderRequest(BaseModel):
    path: str


@router.get("")
async def list_folders(engine: Engine = Depends(get_engine)):
    return {"folders": await folders.describe(engine)}


@router.post("")
async def add_folder(req: FolderRequest,
                     engine: Engine = Depends(get_engine)):
    raw = req.path.strip()
    if not raw or not Path(raw).is_absolute():
        raise HTTPException(400, "give the folder's full path, e.g. "
                                 "C:/Users/you/Documents/exports")
    if not Path(raw).is_dir():
        raise HTTPException(404, f"{raw} is not a folder on this machine")
    path = folders.normalise(raw)
    current = await folders.paths(engine)
    cover = folders.covering(path, current)
    if cover:
        raise HTTPException(
            409, f"{path} is already readable: it is inside {cover}"
            if cover != path else f"{path} is already added")
    await folders.save(engine, current + [path])
    return {"folders": await folders.describe(engine), "added": path}


@router.delete("")
async def remove_folder(path: str, engine: Engine = Depends(get_engine)):
    """Forget a folder. Sources already loaded from it stay loaded: their
    Parquet copies live in the app's own folder, not in this one."""
    target = folders.normalise(path) if path else ""
    current = await folders.paths(engine)
    if target not in current:
        raise HTTPException(404, f"{path} is not on the folder list")
    await folders.save(engine, [p for p in current if p != target])
    return {"folders": await folders.describe(engine), "removed": target}
