# PyInstaller spec for Data Cleaver (Windows, one-folder build).
#
# Build from the repository root, after `npm run build` in sda/frontend and
# `python sda/desktop/fetch_extensions.py`:
#
#     pyinstaller --noconfirm sda/desktop/sda.spec
#
# Output: dist/DataCleaver/DataCleaver.exe, which the Inno Setup script
# (installer.iss) packages. One-folder rather than one-file: a one-file exe
# unpacks ~100 MB to a temp folder on every launch.

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

HERE = Path(SPECPATH)
ROOT = HERE.parents[1]
BACKEND = ROOT / "sda" / "backend"
DIST = ROOT / "sda" / "frontend" / "dist"
EXTENSIONS = HERE / "build" / "duckdb_extensions"

for need, how in ((DIST / "index.html", "npm run build in sda/frontend"),
                  (EXTENSIONS, "python sda/desktop/fetch_extensions.py")):
    if not need.exists():
        raise SystemExit(f"missing {need}: run `{how}` first")

a = Analysis(
    [str(HERE / "launch.py")],
    pathex=[str(BACKEND)],
    datas=[(str(DIST), "frontend/dist"),
           (str(EXTENSIONS), "duckdb_extensions")],
    # Routers are imported by name inside functions, and uvicorn picks its
    # loop and protocol implementations at runtime: neither is visible to
    # PyInstaller's import scan.
    hiddenimports=collect_submodules("app") + collect_submodules("uvicorn"),
    # Installed for development, never imported by the app. DuckDB imports
    # numpy only for DataFrame and array results, which the app never asks
    # for; leaving it out saves ~27 MB.
    excludes=["pandas", "pyarrow", "numpy", "tkinter", "matplotlib", "IPython",
              "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="DataCleaver",
    console=False,          # a window app; logs go to datacleaver.log
    icon=str(HERE / "datacleaver.ico") if (HERE / "datacleaver.ico").exists() else None,
    version=str(HERE / "version.txt") if (HERE / "version.txt").exists() else None,
    upx=False,              # UPX-packed exes trip antivirus heuristics
)
coll = COLLECT(exe, a.binaries, a.datas, name="DataCleaver", upx=False)
