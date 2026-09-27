"""Machine-level preferences for the desktop app, kept outside the database.

Where the database lives cannot be recorded inside the database, so the
desktop profile keeps three choices in a small JSON file in its app folder:
the database folder, the Parquet folder, and whether the demo data is on.
Everything else the user sets lives in `_settings` inside the database.
"""

import json
from pathlib import Path

FILE = "app.json"
DB_FILE = "datacleaver.duckdb"


def path(app_dir):
    return Path(app_dir) / FILE


def load(app_dir):
    """The saved choices, or {} when none were made (or the file is unreadable:
    a bad preferences file must never stop the app opening on its defaults)."""
    try:
        data = json.loads(path(app_dir).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(app_dir, **changes):
    data = {**load(app_dir), **changes}
    target = path(app_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(target)
    return data


def usable_folder(raw):
    """-> (Path, None) for a folder the app can write to, else (None, why)."""
    if not raw or not str(raw).strip():
        return None, "choose a folder"
    p = Path(str(raw).strip()).expanduser()
    if not p.is_absolute():
        return None, "use a full path, such as C:/Users/you/Documents/Data Cleaver"
    try:
        p.mkdir(parents=True, exist_ok=True)
        probe = p / ".datacleaver-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        return None, f"cannot write to {p}: {exc.strerror or exc}"
    return p.resolve(), None
