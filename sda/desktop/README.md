# The Windows app

`launch.py` starts Data Cleaver in a native window (pywebview over Edge
WebView2), with the FastAPI backend on a loopback port in the same process.
Data lives in `%LOCALAPPDATA%\DataCleaver`.

Run from source (repository root):

```
.venv/Scripts/python sda/desktop/launch.py
```

## Building the installer

Pushing a tag like `v1.0.0` does all of this in GitHub Actions
(`.github/workflows/release.yml`) and attaches `DataCleaver-Setup.exe` to the
release. To build by hand, from the repository root:

```
.venv/Scripts/python -m pip install -r sda/backend/requirements-dev.txt
(cd sda/frontend && npm ci && npm run build)
.venv/Scripts/python sda/desktop/fetch_extensions.py
.venv/Scripts/pyinstaller --noconfirm --distpath build/dist --workpath build/work sda/desktop/sda.spec
.venv/Scripts/python sda/desktop/smoke.py build/dist/DataCleaver/DataCleaver.exe --clean
ISCC /DAppVersion=1.0.0 sda/desktop/installer.iss
```

The last step needs [Inno Setup 6](https://jrsoftware.org/isinfo.php)
(`winget install JRSoftware.InnoSetup`). The installer lands in
`build/installer/`.

| File | What it does |
|---|---|
| `fetch_extensions.py` | Pre-installs DuckDB's `excel` extension so `.xlsx` export works offline |
| `sda.spec` | PyInstaller one-folder build: the backend, the built UI, the extensions |
| `smoke.py` | Launches a build against a throwaway profile: sample install, a query, an export |
| `installer.iss` | Per-user install (no admin prompt), Start menu entry, uninstaller |

Uninstalling removes the program only. `%LOCALAPPDATA%\DataCleaver` (loaded
data, saved results, settings) is left in place.
