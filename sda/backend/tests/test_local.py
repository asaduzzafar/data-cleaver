"""L1: the local desktop profile.

One person, one machine: the app listens on loopback only, sizes DuckDB's
memory from the machine rather than assuming a server, keeps its files in the
user's app-data folder, and serves the built UI itself so a single process is
the whole app.
"""

import pytest
from fastapi.testclient import TestClient

from app import __main__ as entry
from app import config as config_mod
from app.config import Config
from app.main import create_app
from test_m1 import make_config

GB = 1024 ** 3


class TestMemorySizing:
    @pytest.mark.parametrize("ram, expected", [
        (16 * GB, "8192MB"),     # half of physical RAM
        (8 * GB, "4096MB"),
        (3 * GB, "1536MB"),
        (1 * GB, "1024MB"),      # floor: DuckDB needs room to work at all
    ])
    def test_half_of_physical_ram_with_a_floor(self, monkeypatch, ram,
                                               expected):
        monkeypatch.setattr(config_mod, "physical_memory_bytes", lambda: ram)
        assert config_mod.local_memory_limit() == expected

    def test_unknown_ram_is_conservative_not_a_server_guess(self, monkeypatch):
        monkeypatch.setattr(config_mod, "physical_memory_bytes", lambda: None)
        assert config_mod.local_memory_limit() == "2048MB"

    def test_physical_ram_is_readable_on_this_machine(self):
        n = config_mod.physical_memory_bytes()
        assert n is None or n > 256 * 1024 ** 2


class TestLocalProfile:
    def test_files_live_in_the_app_data_folder(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
        cfg = Config.local()
        root = tmp_path / "DataCleaver"
        assert cfg.db_path == root / "datacleaver.duckdb"
        assert cfg.parquet_dir == root / "parquets"
        assert cfg.data_dir == root / "data"

    def test_sample_size_can_be_reduced_for_ui_tests(self, monkeypatch,
                                                     tmp_path):
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
        assert Config.local().sample_rows == 1_000_000
        monkeypatch.setenv("SDA_SAMPLE_ROWS", "5000")
        assert Config.local().sample_rows == 5000

    def test_machine_sized_memory(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
        monkeypatch.setattr(config_mod, "physical_memory_bytes",
                            lambda: 16 * GB)
        cfg = Config.local()
        assert cfg.memory_limit == "8192MB"
        assert cfg.threads >= 1


@pytest.fixture
def dist(tmp_path):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<title>Data Cleaver</title>",
                                  encoding="utf-8")
    (d / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    return d


def local_config(tmp_path, dist=None):
    return make_config(db_path=tmp_path / "db" / "x.duckdb",
                       data_dir=tmp_path / "data",
                       parquet_dir=tmp_path / "pq", frontend_dist=dist)


class TestSingleOrigin:
    def test_serves_the_ui_and_the_api_from_one_process(self, tmp_path, dist):
        with TestClient(create_app(local_config(tmp_path, dist))) as c:
            page = c.get("/")
            assert page.status_code == 200 and "Data Cleaver" in page.text
            assert c.get("/assets/app.js").status_code == 200
            assert c.get("/api/health").json()["status"] == "ok"

    def test_unknown_api_path_is_still_a_json_404(self, tmp_path, dist):
        """The static mount must not swallow API mistakes as index.html."""
        with TestClient(create_app(local_config(tmp_path, dist))) as c:
            r = c.get("/api/nope")
            assert r.status_code == 404
            assert r.headers["content-type"].startswith("application/json")

    def test_without_a_built_ui_the_api_still_runs(self, tmp_path):
        with TestClient(create_app(local_config(tmp_path, None))) as c:
            assert c.get("/api/health").status_code == 200

    def test_no_cors_headers_when_no_origins(self, tmp_path, dist):
        with TestClient(create_app(local_config(tmp_path, dist))) as c:
            r = c.get("/api/health", headers={"Origin": "http://evil.test"})
            assert "access-control-allow-origin" not in r.headers


class TestEntryPoint:
    @pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
    def test_loopback_is_allowed(self, host):
        entry.check_host(host, allow_remote=False)

    @pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.5", "::"])
    def test_anything_else_is_refused_without_the_flag(self, host):
        with pytest.raises(SystemExit, match="loopback"):
            entry.check_host(host, allow_remote=False)

    def test_the_flag_allows_it(self):
        entry.check_host("0.0.0.0", allow_remote=True)

    def test_free_port_is_bindable(self):
        port = entry.free_port("127.0.0.1")
        assert 1024 <= port <= 65535
