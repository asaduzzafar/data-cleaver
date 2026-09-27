"""D1: the desktop shell's non-GUI parts.

The window itself needs a person to look at it; everything around it -- one
running copy at a time, the server starting and stopping cleanly, the
WebView2 check -- is testable here.
"""

import duckdb
import httpx
import pytest

from app import desktop
from test_m1 import make_config


def cfg(tmp_path):
    return make_config(db_path=tmp_path / "app" / "x.duckdb",
                       data_dir=tmp_path / "none",
                       parquet_dir=tmp_path / "pq")


class TestSingleInstance:
    def test_second_lock_fails_and_finds_the_first_port(self, tmp_path):
        first = desktop.InstanceLock(tmp_path)
        assert first.acquire()
        first.publish_port(51234)

        second = desktop.InstanceLock(tmp_path)
        assert not second.acquire()
        assert second.running_port() == 51234

        first.release()
        third = desktop.InstanceLock(tmp_path)
        assert third.acquire()
        third.release()

    def test_a_stale_port_file_without_a_lock_is_ignored(self, tmp_path):
        (tmp_path / desktop.PORT_FILE).write_text("9", encoding="utf-8")
        lock = desktop.InstanceLock(tmp_path)
        assert lock.acquire()
        lock.release()


class TestServerThread:
    def test_starts_serves_and_releases_duckdb_on_stop(self, tmp_path):
        c = cfg(tmp_path)
        server = desktop.ServerThread(c, port=desktop.free_port())
        server.start()
        try:
            assert server.wait_started(timeout=30)
            r = httpx.get(f"{server.url}api/health", timeout=10)
            assert r.status_code == 200
        finally:
            server.stop(timeout=30)
        assert not server.is_alive()
        # The lifespan closed the database: another process-level open works.
        duckdb.connect(str(c.db_path)).close()

    def test_focus_route_calls_the_window_hook(self, tmp_path):
        calls = []
        server = desktop.ServerThread(cfg(tmp_path), port=desktop.free_port(),
                                      on_focus=lambda: calls.append(1))
        server.start()
        try:
            assert server.wait_started(timeout=30)
            r = httpx.post(f"{server.url}api/desktop/focus", timeout=10)
            assert r.status_code == 200 and calls == [1]
        finally:
            server.stop(timeout=30)


class TestWebView2:
    def test_detection_returns_a_bool(self):
        assert desktop.webview2_installed() in (True, False)

    def test_missing_runtime_is_reported(self, monkeypatch):
        monkeypatch.setattr(desktop, "_webview2_version", lambda: None)
        assert desktop.webview2_installed() is False

    @pytest.mark.parametrize("version", ["153.0.4234.48", "90.0.1"])
    def test_present_runtime_is_found(self, monkeypatch, version):
        monkeypatch.setattr(desktop, "_webview2_version", lambda: version)
        assert desktop.webview2_installed() is True

    def test_zero_version_means_uninstalled(self, monkeypatch):
        # EdgeUpdate leaves "0.0.0.0" behind after an uninstall.
        monkeypatch.setattr(desktop, "_webview2_version", lambda: "0.0.0.0")
        assert desktop.webview2_installed() is False
