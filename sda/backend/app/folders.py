"""The folders the user has added: the only places the app may read files.

Kept as one JSON value in _settings, so the registry's table shapes do not
change. Until the list is first edited it defaults to the configured data
folder when that exists; once edited, an empty list stays empty -- removing
the last folder is a choice, not a reason to bring the default back.

Paths are stored resolved and forward-slashed, so the same folder always has
the same spelling and DuckDB can take it as a literal.
"""

import json
from pathlib import Path

KEY = "data_folders"


def normalise(path):
    return Path(path).resolve().as_posix()


async def paths(engine):
    res = await engine.fetch("SELECT v FROM _settings WHERE k = ?", [KEY],
                             heavy=False)
    raw = res.scalar()
    if raw is None:
        default = engine.cfg.data_dir
        return [normalise(default)] if default.is_dir() else []
    return list(json.loads(raw))


async def roots(engine):
    """The added folders that currently exist, as Paths."""
    return [Path(p) for p in await paths(engine) if Path(p).is_dir()]


async def describe(engine):
    return [{"path": p, "name": Path(p).name or p, "present": Path(p).is_dir()}
            for p in await paths(engine)]


async def save(engine, items):
    await engine.fetch("INSERT OR REPLACE INTO _settings VALUES (?, ?)",
                       [KEY, json.dumps(items)], heavy=False)


def covering(folder, existing):
    """The existing folder that already contains `folder`, if any."""
    target = Path(folder)
    for e in existing:
        root = Path(e)
        if target == root or root in target.parents:
            return e
    return None


def within(path, root_paths):
    """-> (root, target) when `path` resolves inside one of `root_paths`.

    Resolution comes first, so `..` segments and links pointing out of a
    folder fail the containment test rather than slipping past it.
    """
    target = Path(path).resolve()
    for root in root_paths:
        root = Path(root).resolve()
        if target == root or root in target.parents:
            return root, target
    return None
