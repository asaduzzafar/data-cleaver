"""L3: the generated sample dataset.

The sample data is the only data a stranger sees, so it has to demonstrate
the product's claims rather than just fill the grid: zero-padded IDs that a
careless load would ruin, rows the parser rejects, a join key that multiplies
rows, and a later extract that makes a saved result stale. Each test here
checks one of those claims end to end, at a small scale.
"""

import hashlib
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_m1 import make_config, wait

ROWS = 3000


def config(tmp_path, *, sample=True):
    return make_config(db_path=tmp_path / "app" / "x.duckdb",
                       data_dir=tmp_path / "none",
                       parquet_dir=tmp_path / "pq", sample_data=sample,
                       sample_rows=ROWS)


def wait_installed(client, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get("/api/sample").json()
        if body["state"] in ("installed", "failed"):
            return body
        time.sleep(0.1)
    raise AssertionError(f"sample never finished: {body}")


@pytest.fixture
def installed(tmp_path):
    with TestClient(create_app(config(tmp_path))) as c:
        body = wait_installed(c)
        assert body["state"] == "installed", body
        yield c, tmp_path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(client, body):
    return wait(client, client.post("/api/query", json=body).json())


class TestGeneration:
    def test_output_is_byte_identical_across_runs(self, tmp_path):
        digests = []
        for n in (1, 2):
            with TestClient(create_app(config(tmp_path / str(n)))) as c:
                assert wait_installed(c)["state"] == "installed"
            folder = tmp_path / str(n) / "app" / "sample"
            digests.append({p.relative_to(folder).as_posix(): digest(p)
                            for p in sorted(folder.rglob("*.csv"))})
        assert digests[0] == digests[1]
        assert set(digests[0]) == {"sample_orders.csv",
                                   "sample_customers.csv",
                                   "later/sample_orders.csv"}

    def test_not_generated_unless_the_profile_asks(self, tmp_path):
        with TestClient(create_app(config(tmp_path, sample=False))) as c:
            assert c.get("/api/sample").json()["state"] == "not_installed"
            assert c.get("/api/relations").json()["relations"] == []

    def test_no_real_world_names(self, installed):
        """Generic, made-up values only: nothing that reads as a real
        company, person or domain."""
        _, tmp = installed
        text = (tmp / "app" / "sample" / "sample_customers.csv").read_text()
        assert "Customer 000001" in text
        for word in ("Inc", "Ltd", "LLC", "@", "http"):
            assert word not in text


class TestWhatTheSampleDemonstrates:
    def test_first_run_registers_the_folder_and_loads_both(self, installed):
        c, tmp = installed
        folders = [f["path"] for f in c.get("/api/folders").json()["folders"]]
        assert folders == [(tmp / "app" / "sample").resolve().as_posix()]
        rels = {r["name"]: r for r in c.get("/api/relations").json()["relations"]}
        assert {"sample_orders", "sample_customers"} <= set(rels)
        assert rels["sample_orders"]["rows"] == ROWS

    def test_zero_padded_ids_survive(self, installed):
        c, _ = installed
        done = run(c, {"mode": "sql", "sql":
                       "SELECT min(order_id), min(customer_id) "
                       "FROM sample_orders"})
        assert done["result"]["rows"] == [["00000001", "000001"]]

    def test_some_rows_are_rejected_and_recorded(self, installed):
        c, _ = installed
        body = c.get("/api/relations/sample_orders/rejects").json()
        assert body["total"] >= 1

    def test_joining_orders_to_customers_is_a_fanout(self, installed):
        c, _ = installed
        spec = {"inputs": [
            {"relation": "sample_orders", "alias": "o"},
            {"relation": "sample_customers", "alias": "c",
             "columns": ["segment"],
             "join": {"type": "left", "with": "o",
                      "on": [["customer_id", "customer_id"]]}}]}
        refused = run(c, {"mode": "join", "join": spec})
        assert refused["state"] == "error"
        rules = {f["rule"] for f in refused["detail"]["findings"]}
        assert "fanout" in rules

    def test_the_later_extract_makes_a_saved_slice_stale(self, installed):
        c, tmp = installed
        done = run(c, {"mode": "slice", "relation": "sample_orders"})
        c.post("/api/query/save", json={"job_id": done["id"],
                                        "name": "my cut"})
        time.sleep(1.1)
        later = (tmp / "app" / "sample" / "later" /
                 "sample_orders.csv").resolve().as_posix()
        job = c.post("/api/load", json={
            "path": later, "force_text": ["order_id", "customer_id"]}).json()
        assert wait(c, job)["state"] == "done"
        rel = next(r for r in c.get("/api/relations").json()["relations"]
                   if r["name"] == "my_cut")
        assert rel["staleness"] == "stale", rel
        rows = next(r for r in c.get("/api/relations").json()["relations"]
                    if r["name"] == "sample_orders")["rows"]
        assert rows > ROWS

    def test_every_outlier_check_has_something_to_find(self, installed):
        """The sample exists to demonstrate the product: the Profile step's
        leads must point at all four Outliers checks."""
        c, _ = installed
        done = wait(c, c.post("/api/relations/sample_orders/profile").json())
        orders = {(l["column"], l["check"]) for l in done["result"]["leads"]}
        done = wait(c, c.post("/api/relations/sample_customers/profile").json())
        customers = {(l["column"], l["check"])
                     for l in done["result"]["leads"]}
        assert ("quantity", "extremes") in orders
        assert ("product_code", "rare") in orders
        assert ("promo_code", "missing") in orders
        assert ("customer_id", "duplicates") in customers


class TestReinstall:
    def test_install_endpoint_is_idempotent(self, installed):
        c, _ = installed
        r = c.post("/api/sample")
        assert r.status_code == 200
        assert wait_installed(c)["state"] == "installed"
        names = [r["name"] for r in c.get("/api/relations").json()["relations"]]
        assert names.count("sample_orders") == 1

    def test_a_restart_does_not_regenerate(self, tmp_path):
        with TestClient(create_app(config(tmp_path))) as c:
            wait_installed(c)
        before = digest(tmp_path / "app" / "sample" / "sample_orders.csv")
        mtime = (tmp_path / "app" / "sample" / "sample_orders.csv").stat().st_mtime
        with TestClient(create_app(config(tmp_path))) as c:
            assert c.get("/api/sample").json()["state"] == "installed"
        f = tmp_path / "app" / "sample" / "sample_orders.csv"
        assert digest(f) == before and f.stat().st_mtime == mtime
