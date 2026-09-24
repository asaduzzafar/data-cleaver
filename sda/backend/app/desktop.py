"""The Windows desktop shell: a native window around the local app.

pywebview hosts the UI in Edge WebView2, which ships with Windows 10 and 11,
so the app gets a real window, taskbar entry and folder picker with no
bundled browser. The server runs in a background thread of the same process;
closing the window stops it through its normal shutdown, which cancels jobs
and closes DuckDB before the process exits.

One copy at a time. DuckDB's file lock admits a single process, so a second
launch would otherwise fail with an error no user should have to read.
Instead the second copy asks the first to bring its window forward, then
exits.
"""

import logging
import logging.handlers
import msvcrt
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import APIRouter

from .config import Config, local_app_dir
from .main import create_app

LOCK_FILE = "instance.lock"
PORT_FILE = "instance.port"
WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
# Edge WebView2 Runtime's client id in EdgeUpdate.
WEBVIEW2_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
TITLE = "Data Cleaver"

log = logging.getLogger("datacleaver.desktop")


def free_port(host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


# ----------------------------------------------------------------------
# One running copy
# ----------------------------------------------------------------------
class InstanceLock:
    """An exclusive lock on a file in the app folder, held for the life of
    the process. Windows releases it if the process dies, so a crash never
    leaves the app unable to start."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self._fh = None

    def acquire(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        fh = open(self.folder / LOCK_FILE, "a+b")
        try:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True

    def publish_port(self, port):
        (self.folder / PORT_FILE).write_text(str(port), encoding="utf-8")

    def running_port(self):
        try:
            return int((self.folder / PORT_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def release(self):
        if self._fh is None:
            return
        try:
            (self.folder / PORT_FILE).unlink(missing_ok=True)
            self._fh.seek(0)
            msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        finally:
            self._fh.close()
            self._fh = None


def ask_running_copy_to_focus(port):
    import urllib.request
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/desktop/focus", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5):
            return True
    except OSError:
        return False


# ----------------------------------------------------------------------
# The server, in a thread of this process
# ----------------------------------------------------------------------
class ServerThread(threading.Thread):
    def __init__(self, cfg, port, on_focus=None):
        super().__init__(name="datacleaver-server", daemon=True)
        self.port = port
        self.url = f"http://127.0.0.1:{port}/"
        router = APIRouter(prefix="/api/desktop", tags=["desktop"],
                           include_in_schema=False)

        @router.post("/focus")
        async def focus():
            if on_focus is not None:
                on_focus()
            return {"focused": on_focus is not None}

        app = create_app(cfg, extra_routers=[router])
        self.server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=port, workers=1,
            log_config=None, log_level="warning"))

    def run(self):
        self.server.run()

    def wait_started(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.server.started:
                return True
            if not self.is_alive():
                return False
            time.sleep(0.05)
        return False

    def stop(self, timeout=30):
        """Graceful: the lifespan cancels running jobs and closes DuckDB."""
        self.server.should_exit = True
        self.join(timeout)


# ----------------------------------------------------------------------
# WebView2
# ----------------------------------------------------------------------
def _webview2_version():
    import winreg
    keys = [
        (winreg.HKEY_LOCAL_MACHINE,
         rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_GUID}"),
        (winreg.HKEY_LOCAL_MACHINE,
         rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_GUID}"),
        (winreg.HKEY_CURRENT_USER,
         rf"Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_GUID}"),
    ]
    for hive, path in keys:
        try:
            with winreg.OpenKey(hive, path) as k:
                return winreg.QueryValueEx(k, "pv")[0]
        except OSError:
            continue
    return None


def webview2_installed():
    try:
        version = _webview2_version()
    except Exception:
        return False
    return bool(version) and version != "0.0.0.0"


def _message_box(text, title=TITLE, error=True):
    import ctypes
    flags = 0x10 if error else 0x40          # MB_ICONERROR / MB_ICONINFORMATION
    ctypes.windll.user32.MessageBoxW(None, text, title, flags)


# ----------------------------------------------------------------------
# The window
# ----------------------------------------------------------------------
class Bridge:
    """Exposed to the page as window.pywebview.api. It only returns what the
    user chose; the page posts it to /api/folders, so a picked folder goes
    through exactly the same validation as a typed one.

    Anything public here is exposed to the page, and pywebview walks public
    attributes recursively: a public reference to the window made it crawl
    the native WinForms object graph until recursion overflowed. So the
    window is kept under a private name, which pywebview skips.
    """

    def __init__(self):
        self._window = None

    def pick_folder(self):
        import webview
        chosen = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        return chosen[0] if chosen else None


def _setup_logging(folder):
    folder.mkdir(parents=True, exist_ok=True)
    # Capped: the app runs for weeks and logs every job.
    handler = logging.handlers.RotatingFileHandler(
        folder / "datacleaver.log", maxBytes=5 * 1024 ** 2, backupCount=3,
        encoding="utf-8")
    logging.basicConfig(
        handlers=[handler], level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main():
    import webview

    cfg = Config.local()
    app_dir = local_app_dir()
    _setup_logging(app_dir)

    lock = InstanceLock(app_dir)
    if not lock.acquire():
        port = lock.running_port()
        if port and ask_running_copy_to_focus(port):
            return 0
        _message_box("Data Cleaver is already running, but it did not "
                     "respond. Close it from the taskbar, or restart "
                     "Windows, and try again.")
        return 1

    try:
        if not webview2_installed():
            _message_box(
                "Data Cleaver needs the Microsoft Edge WebView2 Runtime, "
                "which is missing on this computer.\n\nIt will open in your "
                "browser now: install it, then start Data Cleaver again.")
            webbrowser.open(WEBVIEW2_URL)
            return 1

        bridge = Bridge()
        window_ref = {}

        def focus():
            w = window_ref.get("w")
            if w is not None:
                w.restore()
                w.show()
                # Windows only raises a window above others for the
                # foreground app; a brief on-top toggle gets past that.
                w.on_top = True
                w.on_top = False

        port = free_port()
        server = ServerThread(cfg, port, on_focus=focus)
        server.start()
        if not server.wait_started(timeout=60):
            _message_box("Data Cleaver could not start. Details are in "
                         f"{app_dir / 'datacleaver.log'}.")
            return 1
        lock.publish_port(port)
        log.info("serving on %s", server.url)

        window = webview.create_window(
            TITLE, server.url, js_api=bridge, width=1440, height=900,
            min_size=(1024, 640), text_select=True)
        bridge._window = window_ref["w"] = window
        webview.start(private_mode=False,
                      storage_path=str(app_dir / "webview"))

        # The window is closed: shut the server down before the lock goes,
        # so a relaunch never meets a database still held by this process.
        server.stop(timeout=60)
        log.info("stopped")
        return 0
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
