"""E2: the Preview step -- look at some rows.

Two honest ways to look. "First rows as stored" follows each row's position
in the stored Parquet file (or a saved table's row id): stable run to run,
and labelled as stored order, because the CSV -> Parquet load does not keep
the CSV's order and "the first rows of the file" would be a claim the app
cannot back. "Sample" orders rows by a hash of that position with a seed:
the same seed gives the same rows on every run and every thread count, and
a new seed gives new ones.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_m1 import make_config, share, wait

CSV = "id,v\n" + "\n".join(f"{i:04d},{i}" for i in range(1, 2001)) + "\n"


@pytest.fixture
def client(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "nums.csv").write_text(CSV, encoding="utf-8")
    cfg = make_config(db_path=tmp_path / "x.duckdb", data_dir=data,
                      parquet_dir=tmp_path / "pq", threads=4)
    with TestClient(create_app(cfg)) as c:
        job = c.post("/api/load", json={"path": share(c, "nums.csv"),
                                        "force_text": ["id"]}).json()
        assert wait(c, job)["state"] == "done"
        yield c


def preview(client, rel="nums", **kw):
    body = {"mode": "preview", "relation": rel, "page_size": 20, **kw}
    r = client.post("/api/query", json=body)
    assert r.status_code == 200, r.text
    done = wait(client, r.json())
    assert done["state"] == "done", done
    return done["result"]


def ids(result):
    return [row[0] for row in result["rows"]]


class TestFirstRowsAsStored:
    def test_stable_and_labelled_as_stored_order(self, client):
        a, b = preview(client, preview="head"), preview(client, preview="head")
        assert ids(a) == ids(b)
        assert len(ids(a)) == 20
        assert a["preview"] == {"kind": "head", "size": 20, "of": 2000,
                                "seed": None, "order": "stored"}

    def test_works_on_a_saved_slice_too(self, client):
        cut = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "nums",
            "filters": {"kind": "cond", "column": "v", "op": "<=",
                        "value": 100}}).json())
        client.post("/api/query/save", json={"job_id": cut["id"],
                                             "name": "small"})
        a = preview(client, rel="small", preview="head")
        assert ids(a) == ids(preview(client, rel="small", preview="head"))
        assert a["preview"]["of"] == 100


class TestSample:
    def test_same_seed_same_rows_new_seed_new_rows(self, client):
        a = preview(client, preview="sample", seed=7)
        assert ids(a) == ids(preview(client, preview="sample", seed=7))
        assert ids(a) != ids(preview(client, preview="sample", seed=8))
        assert a["preview"] == {"kind": "sample", "size": 20, "of": 2000,
                                "seed": 7, "order": "random"}

    def test_a_sample_is_not_just_the_head(self, client):
        assert ids(preview(client, preview="sample", seed=1)) != \
            ids(preview(client, preview="head"))

    def test_rows_are_real_and_distinct(self, client):
        got = ids(preview(client, preview="sample", seed=3))
        assert len(set(got)) == 20
        assert all(len(i) == 4 for i in got)    # zero-padded IDs intact

    def test_size_is_bounded(self, client):
        r = client.post("/api/query", json={
            "mode": "preview", "relation": "nums", "preview": "sample",
            "page_size": 5001})
        assert r.status_code == 422

    def test_a_small_relation_returns_everything_it_has(self, client):
        res = preview(client, preview="sample", seed=1, page_size=5000)
        assert res["preview"]["size"] == 2000 and len(res["rows"]) == 2000


def test_unknown_preview_kind_is_refused(client):
    r = client.post("/api/query", json={"mode": "preview", "relation": "nums",
                                        "preview": "tail"})
    assert r.status_code in (400, 422)
