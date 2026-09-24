"""The demo data: its status, turning it on, and turning it off.

Settings shows it as one switch, "Enable demo data". On generates and loads
the sample (a new install starts with it on); off removes the sample sources
and every slice cut from them. The choice is remembered for the next launch
in the desktop app's preferences, so a removed sample is not reinstalled.
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import prefs
from ..db import Engine, get_engine
from ..jobs import JobRegistry, get_jobs
from ..sample import plan_removal, remove

router = APIRouter(prefix="/api/sample", tags=["sample"])


def get_installer(request: Request):
    return request.app.state.sample


def _remember(engine, on):
    if engine.cfg.app_dir is not None:
        prefs.save(engine.cfg.app_dir, demo_data=on)


async def _status(engine, installer):
    status = await installer.status(engine)
    _, sources, slices = await plan_removal(engine)
    return {**status,
            "enabled": status["state"] in ("installed", "installing"),
            # What turning it off would remove, so the UI can say so first.
            "removes": {"sources": sources, "slices": slices}}


@router.get("")
async def status(engine: Engine = Depends(get_engine),
                 installer=Depends(get_installer)):
    return await _status(engine, installer)


@router.post("")
async def enable(engine: Engine = Depends(get_engine),
                 registry: JobRegistry = Depends(get_jobs),
                 installer=Depends(get_installer)):
    """Generate any missing files and load any missing sources. Never
    reloads a source that is already there: that would make every result
    cut from it stale."""
    _remember(engine, True)
    installer.start(engine, registry)
    return await _status(engine, installer)


@router.delete("")
async def disable(engine: Engine = Depends(get_engine),
                  installer=Depends(get_installer)):
    if (await installer.status(engine))["state"] == "installing":
        raise HTTPException(409, "the demo data is still being prepared; "
                                 "try again when it has finished")
    removed = await remove(engine)
    _remember(engine, False)
    return {**await _status(engine, installer), **removed}
