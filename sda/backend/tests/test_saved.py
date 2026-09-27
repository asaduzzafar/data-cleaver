"""L4: saved queries, single user.

A saved query stores what the user built (the spec), not a result. Every run
re-checks that spec against the relations as they are now, because a reload
can drop or retype a column: a saved query must fail naming the query and
what it needs, not with a DuckDB error about a binder.
"""

import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_m1 import make_config, share, wait

ORDERS = ("account,amount,region\n"
          "000123,10,north\n000456,20,south\n000789,30,north\n")
ACCOUNTS = ("account,name\n000123,alpha\n000456,beta\n000789,gamma\n")
# The same extract, re-exported without the region column.
ORDERS_NO_REGION = "account,amount\n000123,10\n000456,20\n"


@pytest.fixture
def client(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    for name, body in (("orders.csv", ORDERS), ("accounts.csv", ACCOUNTS),
                       ("orders_v2.csv", ORDERS_NO_REGION)):
        (data / name).write_text(body, encoding="utf-8")
    cfg = make_config(db_path=tmp_path / "x.duckdb", data_dir=data,
                      parquet_dir=tmp_path / "pq")
    with TestClient(create_app(cfg)) as c:
        for f in ("orders.csv", "accounts.csv"):
            job = c.post("/api/load", json={"path": share(c, f),
                                            "force_text": ["account"]}).json()
            assert wait(c, job)["state"] == "done"
        yield c


SPECS = {
    "slice": {"mode": "slice", "relation": "orders",
              "columns": ["account", "region"],
              "filters": {"kind": "cond", "column": "region", "op": "=",
                          "value": "north"},
              "sort": "account"},
    "pivot": {"mode": "pivot", "relation": "orders", "rows": ["region"],
              "value": "amount", "agg": "sum"},
    "sql": {"mode": "sql", "sql": "SELECT region, count(*) AS n FROM orders "
                                  "GROUP BY region ORDER BY region"},
    "join": {"mode": "join", "join": {"inputs": [
        {"relation": "orders", "alias": "o"},
        {"relation": "accounts", "alias": "a", "columns": ["name"],
         "join": {"type": "inner", "with": "o",
                  "on": [["account", "account"]]}}]}},
}


def save(client, name, spec):
    return client.post("/api/saved", json={"name": name, "spec": spec})


def run(client, qid, **extra):
    r = client.post(f"/api/saved/{qid}/run", json=extra)
    return r if r.status_code != 200 else wait(client, r.json())


class TestRoundTrip:
    @pytest.mark.parametrize("kind", SPECS)
    def test_every_kind_saves_reopens_and_reruns(self, client, kind):
        r = save(client, f"my {kind}", SPECS[kind])
        assert r.status_code == 200, r.text
        qid = r.json()["id"]

        got = client.get(f"/api/saved/{qid}").json()
        for k, v in SPECS[kind].items():
            assert got["spec"][k] == v
        assert got["sql"]

        done = run(client, qid)
        assert done["state"] == "done", done
        assert done["result"]["total"] > 0

    def test_run_matches_the_live_query(self, client):
        qid = save(client, "north", SPECS["slice"]).json()["id"]
        saved = run(client, qid)["result"]
        live = wait(client, client.post("/api/query",
                                        json=SPECS["slice"]).json())["result"]
        assert saved["rows"] == live["rows"] == [["000123", "north"],
                                                 ["000789", "north"]]

    def test_list_shows_kind_and_inputs(self, client):
        save(client, "joined", SPECS["join"])
        save(client, "handmade", SPECS["sql"])
        items = {q["name"]: q for q in client.get("/api/saved").json()["saved"]}
        assert items["joined"]["mode"] == "join"
        assert items["joined"]["inputs"] == ["orders", "accounts"]
        assert items["handmade"]["inputs"] == []   # not knowable from SQL


class TestEditing:
    def test_rename_and_update(self, client):
        qid = save(client, "first", SPECS["slice"]).json()["id"]
        time.sleep(0.01)
        r = client.put(f"/api/saved/{qid}", json={"name": "second",
                                                  "spec": SPECS["pivot"]})
        assert r.status_code == 200, r.text
        got = client.get(f"/api/saved/{qid}").json()
        assert got["name"] == "second" and got["spec"]["mode"] == "pivot"
        assert got["updated_at"] > got["created_at"]

    def test_delete(self, client):
        qid = save(client, "gone", SPECS["slice"]).json()["id"]
        assert client.delete(f"/api/saved/{qid}").status_code == 200
        assert client.get(f"/api/saved/{qid}").status_code == 404
        assert run(client, qid).status_code == 404

    def test_names_are_unique_ignoring_case(self, client):
        save(client, "Monthly", SPECS["slice"])
        assert save(client, "monthly", SPECS["pivot"]).status_code == 409


class TestValidationOnSave:
    def test_an_invalid_spec_is_refused_before_it_is_stored(self, client):
        bad = {**SPECS["slice"], "columns": ["nope"]}
        r = save(client, "broken", bad)
        assert r.status_code == 400 and "nope" in r.text
        assert client.get("/api/saved").json()["saved"] == []

    def test_sql_the_gateway_denies_cannot_be_saved(self, client):
        r = save(client, "peek", {"mode": "sql",
                                  "sql": "SELECT * FROM _sources"})
        assert r.status_code == 403

    def test_profile_frequencies_are_not_a_saved_query(self, client):
        r = save(client, "freq", {"mode": "frequencies", "relation": "orders",
                                  "column": "region"})
        assert r.status_code == 400

    def test_a_blank_name_is_refused(self, client):
        assert save(client, "   ", SPECS["slice"]).status_code == 400


class TestRunAfterTheWorldChanged:
    def test_a_dropped_column_names_the_query_and_the_column(self, client):
        qid = save(client, "north only", SPECS["slice"]).json()["id"]
        job = client.post("/api/load", json={
            "path": share(client, "orders_v2.csv"), "name": "orders",
            "force_text": ["account"]}).json()
        assert wait(client, job)["state"] == "done"

        r = run(client, qid)
        assert r.status_code == 400, r.text
        detail = r.json()["detail"]
        assert "north only" in detail and "region" in detail

    def test_a_missing_relation_is_named(self, client):
        cut = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        client.post("/api/query/save", json={"job_id": cut["id"],
                                             "name": "my cut"})
        qid = save(client, "from my cut", {"mode": "slice",
                                           "relation": "my_cut"}).json()["id"]
        client.delete("/api/relations/my_cut")
        r = run(client, qid)
        assert r.status_code in (400, 404), r.text
        detail = r.json()["detail"]
        assert "from my cut" in detail and "my_cut" in detail

    def test_the_gateway_still_judges_sql_on_every_run(self, client):
        """A cost block on a saved query is refused until confirmed, exactly
        as it would be if typed fresh."""
        qid = save(client, "cartesian", {
            "mode": "sql",
            "sql": "SELECT * FROM orders, accounts"}).json()["id"]
        refused = run(client, qid)
        assert refused.status_code == 400
        assert refused.json()["detail"]["error"] == "gateway"
        assert refused.json()["detail"]["query"] == "cartesian"
        done = run(client, qid, confirm_expensive=True)
        assert done["state"] == "done"


class TestLastRun:
    """last_run_at is the last *successful* run. A failed or refused run
    leaves it alone: a timestamp for a run that produced nothing would claim
    a result that does not exist."""

    def test_never_run_is_null(self, client):
        qid = save(client, "fresh", SPECS["slice"]).json()["id"]
        assert client.get(f"/api/saved/{qid}").json()["last_run_at"] is None
        listed = client.get("/api/saved").json()["saved"][0]
        assert listed["last_run_at"] is None

    def test_a_successful_run_records_it(self, client):
        qid = save(client, "ran", SPECS["slice"]).json()["id"]
        assert run(client, qid)["state"] == "done"
        deadline = time.time() + 5
        while time.time() < deadline:
            stamp = client.get(f"/api/saved/{qid}").json()["last_run_at"]
            if stamp:
                break
            time.sleep(0.05)
        assert stamp and stamp >= client.get(
            f"/api/saved/{qid}").json()["created_at"]

    def test_a_refused_run_does_not(self, client):
        qid = save(client, "cartesian", {
            "mode": "sql", "sql": "SELECT * FROM orders, accounts"}).json()["id"]
        assert run(client, qid).status_code == 400
        assert client.get(f"/api/saved/{qid}").json()["last_run_at"] is None


def test_an_older_database_gains_the_column(tmp_path):
    """Databases created before last_run_at existed are migrated on open,
    and their saved queries read as never run rather than failing."""
    import duckdb
    db = tmp_path / "old.duckdb"
    con = duckdb.connect(str(db))
    con.execute("""CREATE TABLE _saved_queries (
         id VARCHAR PRIMARY KEY, name VARCHAR, owner VARCHAR,
         created_at TIMESTAMP, updated_at TIMESTAMP, spec JSON, sql VARCHAR,
         shared BOOLEAN)""")
    con.execute("INSERT INTO _saved_queries VALUES ('q1', 'old', 'me', "
                "now(), now(), '{\"mode\": \"sql\", \"sql\": \"SELECT 1\"}', "
                "'SELECT 1', false)")
    con.close()
    cfg = make_config(db_path=db, data_dir=tmp_path,
                      parquet_dir=tmp_path / "pq")
    with TestClient(create_app(cfg)) as c:
        got = c.get("/api/saved/q1").json()
        assert got["name"] == "old" and got["last_run_at"] is None
