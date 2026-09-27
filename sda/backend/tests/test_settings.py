"""Settings: the demo-data switch, and choosing where data is kept.

The demo switch is destructive when turned off, so the tests pin exactly
what it removes (the sample and what was cut from it) and what it never
touches (the user's own sources). Moving the database starts fresh in the
chosen folder and leaves the old database where it was.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app import prefs
from app.main import create_app
from test_m1 import CSV_BODY, make_config, wait
from test_sample import ROWS, wait_installed


def desktop_config(tmp_path, *, demo=True):
    """The desktop profile's shape: an app folder that keeps preferences."""
    app = tmp_path / "app"
    return make_config(db_path=app / prefs.DB_FILE,
                       data_dir=tmp_path / "none",
                       parquet_dir=app / "parquets", sample_data=demo,
                       sample_rows=ROWS, app_dir=app)


def names(client):
    return {r["name"] for r in client.get("/api/relations").json()["relations"]}


@pytest.fixture
def demo(tmp_path):
    with TestClient(create_app(desktop_config(tmp_path))) as c:
        assert wait_installed(c)["state"] == "installed"
        yield c, tmp_path


def cut(client, name, relation="sample_orders"):
    job = wait(client, client.post("/api/query", json={
        "mode": "slice", "relation": relation, "page": 1, "page_size": 5}).json())
    assert client.post("/api/query/save",
                       json={"job_id": job["id"], "name": name}).status_code == 200


class TestDemoSwitch:
    def test_starts_on_and_says_what_off_would_remove(self, demo):
        client, _ = demo
        cut(client, "big")
        cut(client, "bigger", relation="big")
        body = client.get("/api/sample").json()
        assert body["enabled"] is True
        assert set(body["removes"]["sources"]) == {"sample_orders", "sample_customers"}
        assert set(body["removes"]["slices"]) == {"big", "bigger"}

    def test_off_removes_the_sample_and_its_cuts_only(self, demo):
        client, tmp = demo
        cut(client, "big")
        own = tmp / "mine"
        own.mkdir()
        (own / "orders.csv").write_text(CSV_BODY, encoding="utf-8")
        client.post("/api/folders", json={"path": own.as_posix()})
        wait(client, client.post("/api/load", json={
            "path": (own / "orders.csv").as_posix()}).json())

        body = client.delete("/api/sample").json()
        assert body["enabled"] is False
        assert names(client) == {"orders"}           # the user's own survives
        assert not (tmp / "app" / "sample").exists()
        folders = [f["path"] for f in client.get("/api/folders").json()["folders"]]
        assert own.resolve().as_posix() in folders
        assert not any(f.endswith("/sample") for f in folders)

    def test_off_is_remembered_for_the_next_launch(self, demo):
        client, tmp = demo
        client.delete("/api/sample")
        assert json.loads((tmp / "app" / prefs.FILE).read_text())["demo_data"] is False

    def test_on_again_reinstalls(self, demo):
        client, tmp = demo
        client.delete("/api/sample")
        client.post("/api/sample")
        assert wait_installed(client)["state"] == "installed"
        assert {"sample_orders", "sample_customers"} <= names(client)
        assert json.loads((tmp / "app" / prefs.FILE).read_text())["demo_data"] is True


class TestStorage:
    def test_describes_both_folders(self, tmp_path):
        with TestClient(create_app(desktop_config(tmp_path, demo=False))) as c:
            body = c.get("/api/admin/storage").json()
            assert body["database_dir"].endswith("/app")
            assert body["parquet_dir"].endswith("/app/parquets")
            assert body["changeable"] is True

    def test_new_database_folder_starts_fresh_and_keeps_the_old(self, demo):
        client, tmp = demo
        new = tmp / "elsewhere"
        body = client.post("/api/admin/storage",
                           json={"database_dir": new.as_posix()}).json()
        assert body["database_dir"] == new.resolve().as_posix()
        assert (new / prefs.DB_FILE).is_file()
        assert (tmp / "app" / prefs.DB_FILE).is_file()   # the old one stays
        saved = json.loads((tmp / "app" / prefs.FILE).read_text())
        assert saved["database_dir"] == new.resolve().as_posix()
        # Demo data is on, so the fresh database gets the sample too.
        assert wait_installed(client)["state"] == "installed"

    def test_parquet_folder_changes_where_new_loads_write(self, tmp_path):
        with TestClient(create_app(desktop_config(tmp_path, demo=False))) as c:
            pq = tmp_path / "pq2"
            c.post("/api/admin/storage", json={"parquet_dir": pq.as_posix()})
            own = tmp_path / "mine"
            own.mkdir()
            (own / "orders.csv").write_text(CSV_BODY, encoding="utf-8")
            c.post("/api/folders", json={"path": own.as_posix()})
            done = wait(c, c.post("/api/load", json={
                "path": (own / "orders.csv").as_posix()}).json())
            assert done["result"]["parquet_path"].replace("\\", "/").startswith(
                pq.resolve().as_posix())

    def test_refuses_a_relative_path(self, tmp_path):
        with TestClient(create_app(desktop_config(tmp_path, demo=False))) as c:
            r = c.post("/api/admin/storage", json={"database_dir": "relative/dir"})
            assert r.status_code == 400 and "full path" in r.text

    def test_fixed_outside_the_desktop_profile(self, tmp_path):
        cfg = make_config(db_path=tmp_path / "x.duckdb",
                          data_dir=tmp_path / "d", parquet_dir=tmp_path / "p")
        with TestClient(create_app(cfg)) as c:
            assert c.get("/api/admin/storage").json()["changeable"] is False
            r = c.post("/api/admin/storage", json={"parquet_dir": (tmp_path / "q").as_posix()})
            assert r.status_code == 400


class TestExportFolder:
    """The desktop app writes exports into a folder the user chose, and says
    where; elsewhere they stay downloads."""

    def _slice(self, client):
        return wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "sample_orders", "page": 1,
            "page_size": 5}).json())

    def test_starts_at_downloads(self, tmp_path):
        with TestClient(create_app(desktop_config(tmp_path, demo=False))) as c:
            body = c.get("/api/export/folder").json()
            assert body["changeable"] is True and body["folder"]

    def test_writes_into_the_chosen_folder_and_remembers_it(self, demo, monkeypatch):
        client, tmp = demo
        out = tmp / "my exports"
        body = client.post("/api/export/folder", json={"folder": out.as_posix()}).json()
        assert body["folder"] == out.resolve().as_posix()
        assert json.loads((tmp / "app" / prefs.FILE).read_text())["export_dir"] == body["folder"]
        job = self._slice(client)
        done = wait(client, client.post("/api/export", json={
            "job_id": job["id"], "format": "csv", "filename": "mine"}).json())
        assert done["result"]["saved"] is True
        written = list(out.glob("mine-*.csv"))
        assert len(written) == 1 and done["result"]["path"] == str(written[0])
        # Nothing to collect, and the file stays put.
        assert client.get(f"/api/export/{done['id']}/download").status_code == 400
        shown = []
        from app.routers import export
        monkeypatch.setattr(export, "_reveal", shown.append)
        monkeypatch.setattr(export.os, "name", "nt")
        assert client.post(f"/api/export/{done['id']}/reveal").status_code == 200
        assert shown == [str(written[0])] and written[0].exists()

    def test_refuses_a_relative_folder(self, tmp_path):
        with TestClient(create_app(desktop_config(tmp_path, demo=False))) as c:
            r = c.post("/api/export/folder", json={"folder": "relative"})
            assert r.status_code == 400 and "full path" in r.text

    def test_too_many_rows_for_excel_says_so_plainly(self, demo):
        client, _ = demo
        job = self._slice(client)
        # Pretend the finished query was larger than a sheet.
        client.app.state.jobs.get(job["id"]).result["total"] = 2_000_000
        r = client.post("/api/export", json={"job_id": job["id"], "format": "xlsx"})
        assert r.status_code == 400
        assert "Too many rows for Excel" in r.text and "1,048,576" in r.text
