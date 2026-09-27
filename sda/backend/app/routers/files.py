"""Browsing the folders the user has added.

A browser over the machine's whole disk would let the loader and the SQL tab
reach anything; instead, each folder the user adds is a root, and nothing
outside those roots is listed or loadable. Paths are absolute and
forward-slashed; the top level (an empty path) lists the added folders.

Every requested path is resolved before it is checked, so `../../etc` and a
link pointing outside a folder are both rejected: resolve() collapses the
traversal and follows the link, and the containment test then fails.
"""

import os
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from .. import folders
from ..db import Engine, get_engine

router = APIRouter(prefix="/api/files", tags=["files"])

# What the loader can actually read. Anything else is listed but not offered.
LOADABLE = {".csv", ".tsv", ".txt", ".gz", ".zst", ".parquet"}


async def resolve_within(engine, path):
    """Map a client-supplied path to a real path inside an added folder.

    -> (root, target). 403 when the path is outside every folder, including
    a relative path, which has no folder to be relative to.
    """
    if not path or not Path(path).is_absolute():
        raise HTTPException(403, "that path is not inside an added folder")
    found = folders.within(path, await folders.roots(engine))
    if found is None:
        raise HTTPException(403, "that path is not inside an added folder")
    return found


def _posix(p):
    return Path(p).as_posix()


@router.get("")
async def browse(path: str = "", engine: Engine = Depends(get_engine)):
    if not path:
        return {"root": None, "path": "", "parent": None, "files": [],
                "directories": await folders.describe(engine)}

    if (Path(path).is_absolute() and not Path(path).is_dir()
            and folders.normalise(path) in await folders.paths(engine)):
        raise HTTPException(404, f"{path} is missing -- it was moved or "
                                 "deleted after it was added")
    root, target = await resolve_within(engine, path)
    if not target.is_dir():
        raise HTTPException(404, "no such folder")

    dirs, files = [], []
    with os.scandir(target) as entries:
        for entry in entries:
            try:
                stat = entry.stat()
                is_dir = entry.is_dir()
            except OSError:
                continue  # mid-write, or something we are not allowed to see
            if is_dir:
                dirs.append({"name": entry.name, "path": _posix(entry.path)})
            else:
                ext = os.path.splitext(entry.name)[1].lower()
                files.append({
                    "name": entry.name,
                    "path": _posix(entry.path),
                    "bytes": stat.st_size,
                    "modified": datetime.fromtimestamp(
                        stat.st_mtime).isoformat(timespec="seconds"),
                    "loadable": ext in LOADABLE,
                })
    dirs.sort(key=lambda d: d["name"].lower())
    files.sort(key=lambda f: f["name"].lower())

    return {
        "root": _posix(root),
        "path": _posix(target),
        # An added folder goes up to the folder list, not to its real parent.
        "parent": "" if target == root else _posix(target.parent),
        "directories": dirs,
        "files": files,
    }
