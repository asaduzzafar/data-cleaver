"""Entry point for the Windows app: PyInstaller's script, or run from source.

Python puts this script's own folder on sys.path, not sda/backend where the
`app` package lives, so a source run adds it. A frozen build has `app`
bundled and needs nothing.
"""

import sys
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.desktop import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
