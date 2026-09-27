"""L2: folders the user adds, instead of one configured share.

Adding a folder is how the app gets permission to read it. The file browser,
the loader and the SQL gateway's file-read guard all consult the same list,
so the confinement that protected a server still holds on a laptop -- it just
follows the user's choices instead of a mount point.
"""

import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_m1 import make_config, wait

CSV = "id,amount\n001,10\n002,20\n"


@pytest.fixture
def dirs(tmp_path):
    default = tmp_path / "default"
    (default / "nested").mkdir(parents=True)
    (default / "a.csv").write_text(CSV, encoding="utf-8")
    other = tmp_path / "other"
    other.mkdir()
    (other / "b.csv").write_text(CSV, encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.csv").write_text(CSV, encoding="utf-8")
    return {"default": default, "other": other, "outside": outside,
            "tmp": tmp_path}


@pytest.fixture
def client(dirs):
    t = dirs["tmp"]
    cfg = make_config(db_path=t / "db" / "x.duckdb", data_dir=dirs["default"],
                      parquet_dir=t / "pq")
    with TestClient(create_app(cfg)) as c:
        yield c


def posix(p):
    return p.resolve().as_posix()


def folders(client):
    return [f["path"] for f in client.get("/api/folders").json()["folders"]]


def add(client, path):
    return client.post("/api/folders", json={"path": str(path)})


class TestFolderList:
    def test_starts_with_the_default_folder(self, client, dirs):
        assert folders(client) == [posix(dirs["default"])]

    def test_add_and_remove(self, client, dirs):
        r = add(client, dirs["other"])
        assert r.status_code == 200, r.text
        assert folders(client) == [posix(dirs["default"]),
                                   posix(dirs["other"])]
        r = client.delete("/api/folders",
                          params={"path": posix(dirs["default"])})
        assert r.status_code == 200, r.text
        assert folders(client) == [posix(dirs["other"])]

    def test_removing_the_last_folder_stays_removed(self, client, dirs):
        """An empty list is a choice, not a reason to bring the default back."""
        client.delete("/api/folders", params={"path": posix(dirs["default"])})
        assert folders(client) == []

    @pytest.mark.parametrize("bad, status", [
        ("relative/path", 400),
        ("", 400),
    ])
    def test_refuses_non_absolute_paths(self, client, bad, status):
        assert add(client, bad).status_code == status

    def test_refuses_a_file_or_a_missing_folder(self, client, dirs):
        assert add(client, dirs["default"] / "a.csv").status_code == 404
        assert add(client, dirs["tmp"] / "nope").status_code == 404

    def test_refuses_duplicates_and_folders_already_covered(self, client,
                                                            dirs):
        assert add(client, dirs["default"]).status_code == 409
        r = add(client, dirs["default"] / "nested")
        assert r.status_code == 409 and "already" in r.text

    def test_a_folder_that_went_missing_is_reported_not_crashed_on(
            self, client, dirs):
        gone = dirs["tmp"] / "gone"
        gone.mkdir()
        add(client, gone)
        gone.rmdir()
        entry = next(f for f in client.get("/api/folders").json()["folders"]
                     if f["path"] == posix(gone))
        assert entry["present"] is False
        r = client.get("/api/files", params={"path": posix(gone)})
        assert r.status_code == 404


class TestBrowsing:
    def test_top_level_lists_the_added_folders(self, client, dirs):
        add(client, dirs["other"])
        body = client.get("/api/files").json()
        assert [d["path"] for d in body["directories"]] == [
            posix(dirs["default"]), posix(dirs["other"])]
        assert body["files"] == [] and body["parent"] is None

    def test_inside_a_folder_paths_are_absolute(self, client, dirs):
        body = client.get("/api/files",
                          params={"path": posix(dirs["default"])}).json()
        assert [f["path"] for f in body["files"]] == [
            posix(dirs["default"] / "a.csv")]
        assert body["directories"][0]["path"] == posix(
            dirs["default"] / "nested")
        assert body["parent"] == ""   # back to the folder list

    def test_a_subfolder_goes_up_to_its_parent(self, client, dirs):
        body = client.get("/api/files", params={
            "path": posix(dirs["default"] / "nested")}).json()
        assert body["parent"] == posix(dirs["default"])

    @pytest.mark.parametrize("attack", ["..", "nested/../..", "/etc",
                                        "C:/Windows"])
    def test_cannot_escape_the_added_folders(self, client, attack):
        r = client.get("/api/files", params={"path": attack})
        assert r.status_code in (403, 404), f"{attack}: {r.status_code}"

    def test_cannot_browse_a_folder_that_was_not_added(self, client, dirs):
        r = client.get("/api/files", params={"path": posix(dirs["outside"])})
        assert r.status_code == 403

    def test_traversal_out_of_an_added_folder_is_refused(self, client, dirs):
        sneaky = posix(dirs["default"]) + "/../outside"
        assert client.get("/api/files",
                          params={"path": sneaky}).status_code == 403


class TestLoadingAndSql:
    def test_loads_from_any_added_folder(self, client, dirs):
        add(client, dirs["other"])
        job = client.post("/api/load", json={
            "path": posix(dirs["other"] / "b.csv"),
            "force_text": ["id"]}).json()
        assert wait(client, job)["state"] == "done"

    def test_cannot_load_from_a_folder_that_was_not_added(self, client, dirs):
        r = client.post("/api/load", json={
            "path": posix(dirs["outside"] / "secret.csv")})
        assert r.status_code == 403

    def test_removing_a_folder_keeps_sources_loaded_from_it(self, client,
                                                            dirs):
        job = client.post("/api/load", json={
            "path": posix(dirs["default"] / "a.csv"),
            "force_text": ["id"]}).json()
        assert wait(client, job)["state"] == "done"
        client.delete("/api/folders", params={"path": posix(dirs["default"])})
        names = [r["name"] for r in
                 client.get("/api/relations").json()["relations"]]
        assert "a" in names

    def test_sql_file_reads_follow_the_folder_list(self, client, dirs):
        def read(path):
            job = client.post("/api/query", json={
                "mode": "sql",
                "sql": f"SELECT * FROM read_csv('{posix(path)}')"})
            return job

        assert read(dirs["other"] / "b.csv").status_code == 403
        add(client, dirs["other"])
        r = read(dirs["other"] / "b.csv")
        assert r.status_code == 200, r.text
        assert wait(client, r.json())["state"] == "done"

    def test_health_reports_folders_and_their_presence(self, client, dirs):
        body = client.get("/api/health").json()
        assert body["folders"] == [{"path": posix(dirs["default"]),
                                    "name": "default", "present": True}]


def test_health_carries_a_catalog_version_that_moves_on_load_and_reload(
        client, dirs):
    """The UI polls health, not the catalog; this is how it learns that a
    background load (the sample install, a load it is not watching)
    changed what the catalog should show. A reload changes no count, so the
    version must include when things last changed, not only how many."""
    before = client.get("/api/health").json()["catalog_version"]
    body = {"path": posix(dirs["default"] / "a.csv"), "force_text": ["id"]}
    assert wait(client, client.post("/api/load", json=body).json())["state"] == "done"
    loaded = client.get("/api/health").json()["catalog_version"]
    assert loaded != before
    time.sleep(0.01)
    assert wait(client, client.post("/api/load", json=body).json())["state"] == "done"
    assert client.get("/api/health").json()["catalog_version"] != loaded
