"""App configuration, fixed at startup.

Two ways to build one. `Config.local()` is the desktop app: one person on
their own machine, files in their app-data folder, memory sized from the
machine. `Config.from_env()` is for development and tests, where every value
can be overridden from the environment.

Deliberately plain: these are facts about where the app runs. What the user
changes from the UI belongs in the _settings table inside the database --
except the three choices that cannot live there: where the database and the
Parquet copies are kept, and whether the demo data is on. The desktop profile
reads those from its preferences file (prefs.py).
"""

import ctypes
import getpass
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from . import prefs

APP_DIR_NAME = "DataCleaver"
MB = 1024 ** 2

# What the packaged app carries: PyInstaller unpacks it under sys._MEIPASS.
BUNDLE = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "frozen", False) else None

# The Vite build: bundled in the packaged app, else the source checkout's.
SOURCE_DIST = (BUNDLE / "frontend" / "dist" if BUNDLE
               else Path(__file__).resolve().parents[2] / "frontend" / "dist")

# DuckDB extensions installed at build time (excel, for .xlsx export), so an
# installed app never downloads one. None in a source checkout: DuckDB's own
# per-user folder, downloading on first use.
BUNDLED_EXTENSIONS = BUNDLE / "duckdb_extensions" if BUNDLE else None


def _path(key, default):
    return Path(os.environ.get(key, default)).expanduser()


def physical_memory_bytes():
    """Total physical RAM, or None when it cannot be determined.

    No psutil: on Windows GlobalMemoryStatusEx answers directly, and elsewhere
    sysconf does.
    """
    try:
        if sys.platform == "win32":
            class MemoryStatusEx(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            stat = MemoryStatusEx()
            stat.dwLength = ctypes.sizeof(MemoryStatusEx)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return int(stat.ullTotalPhys)
            return None
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, OSError, ValueError):
        return None


def local_memory_limit():
    """Half of physical RAM, as a DuckDB memory_limit string.

    memory_limit is global to the process, and on a laptop the rest of the
    machine -- the browser, the spreadsheet the user is escaping from --
    needs the other half. DuckDB's own default is 80%, sized for a machine
    that does nothing else. When RAM is unknown, guess low: a query that
    spills to disk is slow, but one that starves the OS takes the whole
    machine down.
    """
    ram = physical_memory_bytes()
    if not ram:
        return "2048MB"
    return f"{max(1024, ram // 2 // MB)}MB"


def local_app_dir():
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / APP_DIR_NAME
    return Path.home() / f".{APP_DIR_NAME.lower()}"


@dataclass(frozen=True)
class Config:
    db_path: Path
    data_dir: Path
    parquet_dir: Path
    memory_limit: str
    threads: int
    query_slots: int
    dev_user: str
    # The built UI to serve at /. None means API only (development, where
    # Vite serves the UI and proxies /api).
    frontend_dist: Path | None = None
    # Generate and load the sample dataset on first run (desktop app only;
    # tests and development start empty unless they ask).
    sample_data: bool = False
    sample_rows: int = 1_000_000
    # Where DuckDB looks for extensions. None keeps DuckDB's default.
    extension_dir: Path | None = None
    # The desktop app's own folder: its preferences file (prefs.py) and the
    # sample files. None outside the desktop profile, where the database and
    # Parquet locations are fixed by the environment and cannot be changed.
    app_dir: Path | None = None

    @classmethod
    def local(cls):
        """The desktop app: one user, loopback only, one process for all."""
        root = local_app_dir()
        dist = _path("SDA_FRONTEND_DIST", str(SOURCE_DIST))
        chosen = prefs.load(root)
        db_dir = Path(chosen.get("database_dir") or root)
        return cls(
            db_path=db_dir / prefs.DB_FILE,
            # Only the default for an unedited folder list. It does not exist
            # on a fresh install, so the list starts empty until the sample
            # installer or the user adds a folder.
            data_dir=root / "data",
            parquet_dir=Path(chosen.get("parquet_dir") or root / "parquets"),
            memory_limit=local_memory_limit(),
            threads=max(1, os.cpu_count() or 2),
            # Two heavy queries at once is plenty for one person; more would
            # only split the same memory budget into smaller pieces.
            query_slots=2,
            # Recorded as the author of loads and saves. Stays on the machine.
            dev_user=getpass.getuser() or "me",
            frontend_dist=dist if (dist / "index.html").is_file() else None,
            # Demo data starts on for a new install; the user can turn it off.
            sample_data=bool(chosen.get("demo_data", True)),
            # Smaller in automated UI tests; the real app uses the default.
            sample_rows=int(os.environ.get("SDA_SAMPLE_ROWS", "1000000")),
            extension_dir=BUNDLED_EXTENSIONS,
            app_dir=root,
        )

    @classmethod
    def from_env(cls):
        root = _path("SDA_ROOT", str(Path.home() / "sda"))
        slots = int(os.environ.get("SDA_QUERY_SLOTS", "4"))
        dist = os.environ.get("SDA_FRONTEND_DIST")
        return cls(
            db_path=_path("SDA_DB", str(root / "sda.duckdb")),
            # The folder the file browser is confined to.
            data_dir=_path("SDA_DATA_DIR", str(root / "data")),
            parquet_dir=_path("SDA_PARQUET_DIR", str(root / "parquets")),
            # GLOBAL scope in DuckDB: the whole process's budget, not per
            # query. The query slots are the only other lever.
            memory_limit=os.environ.get("SDA_MEMORY_LIMIT", local_memory_limit()),
            threads=int(os.environ.get("SDA_THREADS", str(max(2, os.cpu_count() or 4)))),
            query_slots=slots,
            dev_user=os.environ.get("SDA_DEV_USER", "dev"),
            frontend_dist=Path(dist) if dist else None,
        )
