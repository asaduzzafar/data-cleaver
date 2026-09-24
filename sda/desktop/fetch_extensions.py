"""Pre-install the DuckDB extensions the packaged app needs.

Run before PyInstaller. The installed app points DuckDB's
extension_directory at the bundled copy, so .xlsx export works with no
network and never downloads code at runtime.

    python sda/desktop/fetch_extensions.py
"""

import sys
from pathlib import Path

import duckdb

EXTENSIONS = ("excel",)
DEST = Path(__file__).resolve().parent / "build" / "duckdb_extensions"


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{DEST.as_posix()}'")
    for name in EXTENSIONS:
        con.execute(f"INSTALL {name}")
        con.execute(f"LOAD {name}")     # proves the file is usable
    found = sorted(p.relative_to(DEST).as_posix()
                   for p in DEST.rglob("*.duckdb_extension"))
    print(f"duckdb {duckdb.__version__}: {', '.join(found)}")
    return 0 if len(found) >= len(EXTENSIONS) else 1


if __name__ == "__main__":
    sys.exit(main())
