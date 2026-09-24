"""M2: joins across relations, and staleness that follows a chain of slices.

The join tests that matter most are the fan-out ones. A join whose key is not
unique on the right multiplies rows without raising anything, and the result
looks exactly as trustworthy as a correct one. The staleness-chain tests guard
the same kind of silence one level up: a slice cut from a slice used to report
fresh no matter what happened to the file underneath it.
"""

import time

import pytest
from fastapi.testclient import TestClient

from app import sqlgen
from app.main import create_app
from test_m1 import make_config, share, wait

ORDERS = (
    "account,amount,region\n"
    "000123,10,north\n"
    "000456,20,south\n"
    "000789,30,north\n"
    ",40,east\n"                 # empty key -> NULL -- never matches
)
# One row per account except 000456, which appears twice: a join on account
# multiplies that order. 000999 matches nothing.
ACCOUNTS = (
    "account,name,region\n"
    "000123,alpha,north\n"
    "000456,beta,south\n"
    "000456,beta-dup,south\n"
    "000999,omega,west\n"
)
UNIQUE_ACCOUNTS = (
    "account,name\n"
    "000123,alpha\n"
    "000456,beta\n"
    "000789,gamma\n"
)
# Blank fields in a text-forced column and in a numeric one, plus the
# explicit \N marker.
BLANKS = (
    "account,amount\n"
    "000123,10\n"
    ",\n"
    "\\N,\\N\n"
    "000456,20\n"
)
NUMERIC_ACCOUNTS = (
    "acct_no,label\n"
    "123,alpha\n"
    "456,beta\n"
)


@pytest.fixture
def config(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    for name, body in (("orders.csv", ORDERS), ("accounts.csv", ACCOUNTS),
                       ("unique_accounts.csv", UNIQUE_ACCOUNTS),
                       ("numeric_accounts.csv", NUMERIC_ACCOUNTS),
                       ("blanks.csv", BLANKS)):
        (data / name).write_text(body, encoding="utf-8")
    return make_config(db_path=tmp_path / "sda.duckdb", data_dir=data,
                       parquet_dir=tmp_path / "parquets", threads=4)


@pytest.fixture
def client(config):
    with TestClient(create_app(config)) as c:
        yield c


def load(client, path, force_text=("account",)):
    job = client.post("/api/load", json={
        "path": share(client, path), "force_text": list(force_text)}).json()
    done = wait(client, job)
    assert done["state"] == "done", done
    return done["result"]


def run(client, body):
    return wait(client, client.post("/api/query", json=body).json())


def save(client, job_id, name):
    r = client.post("/api/query/save", json={"job_id": job_id, "name": name})
    assert r.status_code == 200, r.text
    return r.json()


def relation(client, name):
    return next(r for r in client.get("/api/relations").json()["relations"]
                if r["name"] == name)


def cut(client, rel, name):
    """Save a plain slice of `rel` under `name`."""
    done = run(client, {"mode": "slice", "relation": rel})
    assert done["state"] == "done", done
    return save(client, done["id"], name)


# ----------------------------------------------------------------------
class TestEmptyFields:
    """An empty field is a missing value, whatever nullstr says.

    With nullstr '\\N' alone, a blank ID loaded as '' -- which matches every
    other blank ID in a join -- and a single blank in a numeric column turned
    the whole column into text.
    """

    def test_empty_fields_load_as_null_in_text_and_numeric_columns(
            self, client):
        load(client, "blanks.csv")
        cols = {c["name"]: c["type"] for c in client.get(
            "/api/relations/blanks/schema").json()["columns"]}
        assert cols == {"account": "VARCHAR", "amount": "BIGINT"}
        done = run(client, {"mode": "sql", "sql":
                            "SELECT count(*) FILTER (account IS NULL), "
                            "count(*) FILTER (amount IS NULL) FROM blanks"})
        assert done["result"]["rows"] == [[2, 2]]

    def test_detect_sees_the_numeric_type_too(self, client):
        body = client.post("/api/load/detect",
                           json={"path": share(client, "blanks.csv")}).json()
        types = {c["name"]: c["type"] for c in body["columns"]}
        assert types["amount"] == "BIGINT"


# ----------------------------------------------------------------------
class TestStalenessChain:
    """source orders -> slice x -> slice y. y reads orders only through x."""

    @pytest.fixture
    def chain(self, client):
        load(client, "orders.csv")
        cut(client, "orders", "x")
        cut(client, "x", "y")
        assert relation(client, "y")["staleness"] == "fresh"
        return client

    def test_reloading_the_root_source_makes_the_grandchild_stale(self, chain):
        time.sleep(1.1)
        load(chain, "orders.csv")
        assert relation(chain, "x")["staleness"] == "stale"
        y = relation(chain, "y")
        assert y["staleness"] == "stale", y
        # The note names both the root cause and the path to it.
        assert "orders" in y["note"] and "x" in y["note"], y["note"]

    def test_recutting_an_input_slice_makes_its_dependent_stale(self, chain):
        """save is CREATE OR REPLACE, so re-saving x swaps out the rows y was
        built from while y still claims to be current."""
        time.sleep(1.1)
        cut(chain, "orders", "x")
        assert relation(chain, "x")["staleness"] == "fresh"
        y = relation(chain, "y")
        assert y["staleness"] == "stale", y
        assert "x" in y["note"]

    def test_deleting_an_input_slice_makes_its_dependent_unknown(self, chain):
        assert chain.delete("/api/relations/x").status_code == 200
        y = relation(chain, "y")
        assert y["staleness"] == "unknown", y
        assert "x" in y["note"]

    def test_hand_written_sql_is_unknown_not_fresh(self, client):
        load(client, "orders.csv")
        done = run(client, {"mode": "sql", "sql": "SELECT 1 AS n"})
        save(client, done["id"], "handmade")
        rel = relation(client, "handmade")
        assert rel["inputs"] == []
        assert rel["staleness"] == "unknown", rel


# ----------------------------------------------------------------------
# Join spec -> SQL. Pure: no database needed to check validation.
# ----------------------------------------------------------------------
SCHEMAS = {
    "orders": {"account": "VARCHAR", "amount": "BIGINT", "region": "VARCHAR"},
    "accounts": {"account": "VARCHAR", "name": "VARCHAR",
                 "region": "VARCHAR"},
    "numeric": {"acct_no": "BIGINT", "label": "VARCHAR"},
    "prefixed": {"o_account": "VARCHAR", "account": "VARCHAR"},
}


def spec(*later, base_cols=()):
    return {"inputs": [{"relation": "orders", "alias": "o",
                        "columns": list(base_cols)}, *later]}


def step(rel="accounts", alias="a", cols=(), type_="inner", with_="o",
         on=(("account", "account"),)):
    return {"relation": rel, "alias": alias, "columns": list(cols),
            "join": {"type": type_, "with": with_,
                     "on": [list(p) for p in on]}}


class TestBuildJoin:
    def test_only_colliding_names_are_prefixed(self):
        plan = sqlgen.plan_join(spec(step(cols=["name", "region"]),
                                     base_cols=["account", "region"]),
                                SCHEMAS)
        assert list(plan.schema) == ["account", "o_region", "name",
                                     "a_region"]
        assert plan.schema["name"] == "VARCHAR"

    def test_empty_columns_means_all(self):
        plan = sqlgen.plan_join(spec(step()), SCHEMAS)
        assert list(plan.schema) == [
            "o_account", "amount", "o_region",
            "a_account", "name", "a_region"]

    def test_anti_join_contributes_no_columns(self):
        plan = sqlgen.plan_join(spec(step(type_="anti")), SCHEMAS)
        assert list(plan.schema) == ["account", "amount", "region"]
        assert "ANTI JOIN" in sqlgen.build_join(plan)

    def test_filters_and_sort_apply_to_output_names(self):
        plan = sqlgen.plan_join(spec(step(cols=["name"])), SCHEMAS)
        sql = sqlgen.build_join(plan, filters={
            "kind": "cond", "column": "name", "op": "=", "value": "alpha"},
            sort="amount", desc=True)
        assert "\"name\" = 'alpha'" in sql and sql.endswith('ORDER BY "amount" DESC')

    def test_self_join_under_two_aliases(self):
        plan = sqlgen.plan_join(spec(step(rel="orders", alias="o2",
                                          cols=["amount"])),
                                SCHEMAS)
        assert "o2_amount" in plan.schema and plan.inputs == ["orders"]

    @pytest.mark.parametrize("bad, message", [
        (spec(step(rel="nope")), "unknown relation"),
        (spec(step(cols=["nope"])), "unknown column"),
        (spec(step(on=[("account", "nope")])), "unknown column"),
        (spec(step(alias="A-1")), "alias"),
        (spec(step(alias="o")), "alias 'o' is used twice"),
        (spec(step(with_="a")), "earlier input"),
        (spec(step(with_="zz")), "earlier input"),
        (spec(step(type_="anti", cols=["name"])), "anti join"),
        (spec(step(type_="cross")), "join type"),
        (spec(step(on=[])), "at least one key"),
        (spec(), "at least two"),
        (spec(*[step(alias=f"a{i}") for i in range(4)]), "at most 4"),
        (spec(step(type_="anti"), step(alias="b", with_="a")), "anti"),
        (spec(step(rel="prefixed", cols=["account", "o_account"])),
         "choose a different alias"),
        ({"inputs": [{"relation": "orders", "alias": "o",
                      "join": {"type": "inner", "with": "o", "on": []}},
                     step()]}, "first input"),
    ])
    def test_bad_specs_are_refused_before_any_sql(self, bad, message):
        with pytest.raises(sqlgen.SqlError, match=message):
            sqlgen.plan_join(bad, SCHEMAS)

    def test_text_key_against_numeric_key_is_refused(self):
        """'000123' would be cast to 123 and match -- or fail mid-scan."""
        with pytest.raises(sqlgen.SqlError) as e:
            sqlgen.plan_join(spec(step(rel="numeric", alias="n",
                                       on=[("account", "acct_no")])),
                             SCHEMAS)
        msg = str(e.value)
        assert "VARCHAR" in msg and "BIGINT" in msg and "text" in msg

    @pytest.mark.parametrize("left, right, ok", [
        ("INTEGER", "BIGINT", True),
        ("BIGINT", "DECIMAL(18,2)", True),
        ("DATE", "TIMESTAMP", True),
        ("VARCHAR", "DATE", False),
        ("BOOLEAN", "INTEGER", False),
    ])
    def test_key_type_families(self, left, right, ok):
        assert (sqlgen.type_family(left) == sqlgen.type_family(right)) is ok


# ----------------------------------------------------------------------
# Probe and join queries, end to end.
# ----------------------------------------------------------------------
def join_spec(right="accounts", type_="inner", on=(("account", "account"),),
              right_cols=("name",)):
    return {"inputs": [
        {"relation": "orders", "alias": "o"},
        {"relation": right, "alias": "a", "columns": list(right_cols),
         "join": {"type": type_, "with": "o", "on": [list(p) for p in on]}},
    ]}


def probe(client, spec_):
    r = client.post("/api/joins/probe", json={"join": spec_})
    assert r.status_code == 200, r.text
    done = wait(client, r.json())
    assert done["state"] == "done", done
    return done["result"]


def rules(review):
    return {f["rule"]: f["severity"] for f in review["findings"]}


@pytest.fixture
def loaded(client):
    load(client, "orders.csv")
    load(client, "accounts.csv")
    load(client, "unique_accounts.csv")
    load(client, "numeric_accounts.csv", force_text=())
    return client


class TestProbe:
    def test_duplicate_right_keys_are_measured_exactly(self, loaded):
        body = probe(loaded, join_spec())
        s = body["steps"][0]
        assert (s["left_rows"], s["right_rows"]) == (4, 4)
        assert (s["left_distinct"], s["right_distinct"]) == (3, 3)
        assert (s["left_nulls"], s["right_nulls"]) == (1, 0)
        assert s["right_unique"] is False
        assert s["matched_left"] == 2
        assert s["max_fanout"] == 2
        assert s["estimated_rows"] == 3      # 000123 once, 000456 twice
        assert rules(body["review"])["fanout"] == "block"
        assert body["review"]["overridable"] is True

    def test_left_join_estimate_counts_unmatched_rows(self, loaded):
        s = probe(loaded, join_spec(type_="left"))["steps"][0]
        assert s["estimated_rows"] == 5      # 3 matched + 2 unmatched

    def test_unique_right_key_does_not_block(self, loaded):
        body = probe(loaded, join_spec(right="unique_accounts"))
        assert body["steps"][0]["right_unique"] is True
        found = rules(body["review"])
        assert "fanout" not in found
        assert found["null_keys"] == "warn"
        assert body["review"]["verdict"] == "warn"

    def test_disjoint_keys_warn_no_matches(self, loaded):
        body = probe(loaded, join_spec(on=[("region", "name")]))
        assert body["steps"][0]["matched_left"] == 0
        assert rules(body["review"])["no_matches"] == "warn"

    def test_text_key_against_numeric_key_is_refused_up_front(self, loaded):
        r = loaded.post("/api/joins/probe", json={"join": join_spec(
            right="numeric_accounts", on=[("account", "acct_no")],
            right_cols=())})
        assert r.status_code == 400
        assert "VARCHAR" in r.text and "BIGINT" in r.text

    def test_unknown_relation_is_a_400(self, loaded):
        r = loaded.post("/api/joins/probe",
                        json={"join": join_spec(right="nope")})
        assert r.status_code == 400 and "unknown relation" in r.text


class TestJoinQuery:
    def test_fanout_is_refused_until_confirmed(self, loaded):
        refused = run(loaded, {"mode": "join", "join": join_spec()})
        assert refused["state"] == "error", refused
        assert rules(refused["detail"])["fanout"] == "block"

        done = run(loaded, {"mode": "join", "join": join_spec(),
                            "confirm_expensive": True})
        assert done["state"] == "done", done
        res = done["result"]
        assert res["total"] == 3
        assert res["columns"] == ["account", "amount", "region", "name"]
        # The multiplication stays visible next to the rows it produced.
        assert res["probe"]["steps"][0]["max_fanout"] == 2
        assert res["inputs"] == ["orders", "accounts"]
        assert res["base"] == "orders"

    def test_clean_join_runs_with_filters_on_output_names(self, loaded):
        done = run(loaded, {
            "mode": "join", "join": join_spec(right="unique_accounts"),
            "filters": {"kind": "cond", "column": "name", "op": "=",
                        "value": "beta"}})
        assert done["state"] == "done", done
        assert done["result"]["rows"] == [["000456", 20, "south", "beta"]]
        # The generic planner warning is replaced by the probe's numbers.
        gw = done["result"]["gateway"] or {"findings": []}
        assert "join_fanout_unknown" not in rules(gw)

    def test_saved_join_goes_stale_when_either_side_reloads(self, loaded):
        done = run(loaded, {"mode": "join",
                            "join": join_spec(right="unique_accounts")})
        saved = save(loaded, done["id"], "orders_named")
        assert sorted(saved["inputs"]) == ["orders", "unique_accounts"]
        assert relation(loaded, "orders_named")["staleness"] == "fresh"

        time.sleep(1.1)
        load(loaded, "unique_accounts.csv")   # the non-base side
        rel = relation(loaded, "orders_named")
        assert rel["staleness"] == "stale", rel
        assert "unique_accounts" in rel["note"]

    def test_three_way_join_probes_every_step(self, loaded):
        """orders -> unique_accounts -> accounts, the second step joining
        onto the second input rather than the base."""
        spec_ = {"inputs": [
            {"relation": "orders", "alias": "o", "columns": ["amount"]},
            {"relation": "unique_accounts", "alias": "u",
             "columns": ["account"],
             "join": {"type": "inner", "with": "o",
                      "on": [["account", "account"]]}},
            {"relation": "accounts", "alias": "b", "columns": ["name"],
             "join": {"type": "left", "with": "u",
                      "on": [["account", "account"]]}},
        ]}
        done = run(loaded, {"mode": "join", "join": spec_,
                            "confirm_expensive": True, "sort": "amount"})
        assert done["state"] == "done", done
        res = done["result"]
        assert res["columns"] == ["amount", "account", "name"]
        assert [s["right"] for s in res["probe"]["steps"]] == ["u", "b"]
        # 000123 -> alpha, 000456 -> beta and beta-dup, 000789 -> no match.
        assert res["total"] == 4
        assert res["inputs"] == ["orders", "unique_accounts", "accounts"]

    def test_bad_spec_is_a_400_not_a_failed_job(self, loaded):
        r = loaded.post("/api/query", json={
            "mode": "join", "join": join_spec(type_="cross")})
        assert r.status_code == 400 and "join type" in r.text
