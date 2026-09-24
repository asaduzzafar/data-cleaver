"""The query gateway: what may run, and what it costs.

Two kinds of assertion here, and the distinction matters. The safety tests
check things the gateway must *never* let through regardless of what the
caller confirms. The cost tests check judgement calls the caller may override
after reading the warning.

There is deliberately no test for `' OR 1=1` style patterns in the SQL tab.
That tab is an authorised console, not an injection surface, and pattern
matching there would reject O'Brien while missing anything real. The
injection surface is the *builders*, which construct SQL from user input --
those tests are at the bottom, against sqlgen, where the guard actually lives.
"""

import time

import pytest
from fastapi.testclient import TestClient

from app import gateway
from app.main import create_app
from test_m1 import make_config, share

CSV_BODY = "account,amount,name\n000123,10.5,alpha\n000456,20.25,beta\n"


@pytest.fixture
def config(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "orders.csv").write_text(CSV_BODY, encoding="utf-8")
    (tmp_path / "secret.txt").write_text("not for you", encoding="utf-8")
    return make_config(db_path=tmp_path / "sda.duckdb", data_dir=data,
                       parquet_dir=tmp_path / "parquets", threads=4)


@pytest.fixture
def client(config):
    with TestClient(create_app(config)) as c:
        yield c


def wait(client, job, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/jobs/{job['id']}").json()
        if body["state"] in ("done", "error", "cancelled"):
            return body
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def load(client):
    job = client.post("/api/load", json={
        "path": share(client, "orders.csv"), "force_text": ["account"]}).json()
    assert wait(client, job)["state"] == "done"


def run_sql(client, sql, **extra):
    return client.post("/api/query",
                       json={"mode": "sql", "sql": sql, **extra})


def detail(response):
    return response.json()["detail"]


# ======================================================================
# Safety: never overridable
# ======================================================================
class TestFileAccess:
    """Closes the hole M1 shipped with and documented.

    read_csv('anything') is a legitimate SELECT, and external access cannot be
    turned off globally because every source view is itself a read_parquet.
    """

    @pytest.mark.parametrize("sql", [
        "SELECT * FROM read_csv('C:/Windows/win.ini')",
        "SELECT * FROM read_text('/etc/passwd')",
        "SELECT * FROM read_parquet('D:/elsewhere/data.parquet')",
        "SELECT * FROM read_blob('C:/Users/someone/.ssh/id_rsa')",
        "SELECT 1 WHERE EXISTS (SELECT * FROM read_text('C:/hosts'))",
        "SELECT * FROM glob('C:/**')",
    ])
    def test_reading_outside_the_share_is_denied(self, client, sql):
        load(client)
        r = run_sql(client, sql)
        assert r.status_code == 403, r.text
        assert detail(r)["verdict"] == "deny"
        assert detail(r)["findings"][0]["rule"] == "file_access_outside_share"

    def test_a_denial_cannot_be_confirmed_away(self, client):
        """confirm_expensive covers cost, never safety."""
        load(client)
        r = run_sql(client, "SELECT * FROM read_text('C:/Windows/win.ini')",
                    confirm_expensive=True)
        assert r.status_code == 403
        assert detail(r)["overridable"] is False

    def test_traversal_out_of_the_share_is_denied(self, client, config):
        load(client)
        escape = (config.data_dir / ".." / "secret.txt").as_posix()
        r = run_sql(client, f"SELECT * FROM read_text('{escape}')")
        assert r.status_code == 403, r.text

    def test_reading_inside_the_share_is_allowed(self, client, config):
        load(client)
        inside = (config.data_dir / "orders.csv").as_posix()
        job = run_sql(client, f"SELECT * FROM read_csv('{inside}')").json()
        assert wait(client, job)["state"] == "done"

    def test_denial_names_a_real_alternative(self, client):
        load(client)
        r = run_sql(client, "SELECT * FROM read_csv('C:/elsewhere/x.csv')")
        suggestions = " ".join(detail(r)["findings"][0]["suggestions"]).lower()
        assert "load" in suggestions


class TestRegistryTables:
    """The registry holds every analyst's file paths and who cut what."""

    @pytest.mark.parametrize("table", [
        "_sources", "_lineage", "_settings", "_rejects", "_saved_queries",
    ])
    def test_direct_reads_are_denied(self, client, table):
        load(client)
        r = run_sql(client, f"SELECT * FROM {table}")
        assert r.status_code == 403, r.text
        assert detail(r)["findings"][0]["rule"] == "registry_table_access"

    def test_denied_inside_a_cte_too(self, client):
        load(client)
        r = run_sql(client, "WITH x AS (SELECT * FROM _sources) "
                            "SELECT count(*) FROM x")
        assert r.status_code == 403, r.text

    def test_ordinary_relations_still_work(self, client):
        load(client)
        job = run_sql(client, "SELECT count(*) FROM orders").json()
        assert wait(client, job)["state"] == "done"


class TestNonSelect:
    @pytest.mark.parametrize("sql", [
        "DROP TABLE orders",
        "SELECT 1; DROP TABLE orders",
        "ATTACH 'evil.db'",
        "COPY orders TO 'C:/tmp/leak.csv'",
        "UPDATE _lineage SET owner = 'someone'",
        "INSTALL httpfs",
    ])
    def test_denied(self, client, sql):
        load(client)
        r = run_sql(client, sql)
        assert r.status_code == 403, f"{sql!r} was allowed"
        assert detail(r)["findings"][0]["rule"] == "not_a_single_select"


# ======================================================================
# Cost: overridable after the analyst reads the warning
# ======================================================================
class TestCostRules:
    def test_cartesian_is_blocked_with_a_usable_suggestion(self, client):
        load(client)
        r = run_sql(client, "SELECT a.name FROM orders a, orders b")
        assert r.status_code == 400, r.text
        body = detail(r)
        assert body["verdict"] == "block"
        assert body["overridable"] is True
        assert body["findings"][0]["rule"] == "cartesian_join"
        assert any("JOIN" in s for s in body["findings"][0]["suggestions"])

    def test_a_cost_block_can_be_confirmed(self, client):
        """Otherwise a deliberate cross join becomes impossible, and the
        gateway stops being a warning and starts being a wall."""
        load(client)
        job = run_sql(client, "SELECT a.name FROM orders a, orders b",
                      confirm_expensive=True).json()
        assert wait(client, job)["state"] == "done"

    def test_select_star_is_not_blocked(self, client):
        """Measured: the paging wrapper plus Parquet metadata counts make this
        ~0.02s on 20M rows. Blocking it would be cargo cult."""
        load(client)
        job = run_sql(client, "SELECT * FROM orders").json()
        assert wait(client, job)["state"] == "done"

    def test_unbounded_order_by_is_not_blocked(self, client):
        """Also measured: the outer LIMIT pushes down and the sort becomes a
        TOP_N. 0.04s on 20M rows."""
        load(client)
        job = run_sql(client, "SELECT * FROM orders ORDER BY name").json()
        assert wait(client, job)["state"] == "done"

    def test_joins_carry_a_fanout_warning_but_still_run(self, client):
        load(client)
        job = run_sql(client,
                      "SELECT a.name FROM orders a "
                      "JOIN orders b ON a.account = b.account").json()
        done = wait(client, job)
        assert done["state"] == "done"
        rules = [f["rule"] for f in done["result"]["gateway"]["findings"]]
        assert "join_fanout_unknown" in rules

    def test_a_clean_query_carries_no_gateway_noise(self, client):
        load(client)
        job = run_sql(client, "SELECT name FROM orders LIMIT 10").json()
        assert wait(client, job)["result"]["gateway"] is None


class TestCostAnalysisUnits:
    """The rules, without a server. Plans are shaped as DuckDB emits them."""

    @staticmethod
    def plan(name, card, children=()):
        return {"name": name, "children": list(children),
                "extra_info": {"Estimated Cardinality": str(card)}}

    def test_cartesian_blocks(self):
        p = [self.plan("CROSS_PRODUCT", 4 * 10**14,
                       [self.plan("SEQ_SCAN", 20_000_000)])]
        findings, est, *_ = gateway.cost_findings(p)
        assert findings[0].rule == "cartesian_join"
        assert est == 4 * 10**14

    def test_absurd_cardinality_blocks_without_a_cross_product(self):
        p = [self.plan("HASH_JOIN", 5 * 10**9,
                       [self.plan("SEQ_SCAN", 10_000_000)])]
        findings, *_ = gateway.cost_findings(p)
        assert findings[0].rule == "absurd_cardinality"

    def test_bounded_sort_is_quiet(self):
        p = [self.plan("TOP_N", 500, [self.plan("SEQ_SCAN", 50_000_000)])]
        findings, *_ = gateway.cost_findings(p)
        assert [f.rule for f in findings] == []

    def test_unbounded_sort_over_a_big_scan_warns(self):
        p = [self.plan("ORDER_BY", 50_000_000,
                       [self.plan("SEQ_SCAN", 50_000_000)])]
        findings, *_ = gateway.cost_findings(p)
        assert [f.rule for f in findings] == ["unbounded_sort"]
        assert findings[0].severity == "warn"

    def test_unbounded_sort_over_a_small_scan_is_quiet(self):
        p = [self.plan("ORDER_BY", 1000, [self.plan("SEQ_SCAN", 1000)])]
        findings, *_ = gateway.cost_findings(p)
        assert findings == []

    def test_high_cardinality_group_warns(self):
        p = [self.plan("HASH_GROUP_BY", 40_000_000,
                       [self.plan("READ_PARQUET", 40_000_000)])]
        findings, *_ = gateway.cost_findings(p)
        assert [f.rule for f in findings] == ["high_cardinality_group"]

    def test_perfect_hash_group_is_quiet(self):
        """DuckDB picks the perfect-hash path when the groups are few, which
        is precisely the case not worth warning about."""
        p = [self.plan("PERFECT_HASH_GROUP_BY", 7,
                       [self.plan("READ_PARQUET", 40_000_000)])]
        findings, *_ = gateway.cost_findings(p)
        assert findings == []


class TestExportReview:
    def test_small_export_is_quiet(self):
        assert gateway.review_export(1000, "csv").verdict == "allow"

    def test_large_export_warns_and_names_the_format_cost(self):
        review = gateway.review_export(8_000_000, "csv")
        assert review.verdict == "warn"
        assert "leading zeros" in review.findings[0].detail

    def test_parquet_is_not_told_to_use_parquet(self):
        review = gateway.review_export(8_000_000, "parquet")
        joined = " ".join(review.findings[0].suggestions)
        assert "Use parquet" not in joined

    def test_enormous_export_blocks(self):
        review = gateway.review_export(200_000_000, "parquet")
        assert review.verdict == "block"
        assert review.overridable is True


# ======================================================================
# The actual injection surface: SQL the app builds from user input
# ======================================================================
class TestBuilderInjection:
    """The filter and pivot builders are where untrusted input meets SQL.

    The guard is structural -- identifiers are checked against the relation's
    live schema, values go through lit() -- so these assert the structure
    holds rather than that any particular payload string is caught.
    """

    @pytest.mark.parametrize("payload", [
        'name"; DROP TABLE orders; --',
        "name' OR '1'='1",
        "*",
        "1; DELETE FROM _sources",
        "amount FROM orders UNION SELECT 1,2,3 --",
    ])
    def test_column_names_must_exist_in_the_schema(self, client, payload):
        load(client)
        r = client.post("/api/query", json={
            "mode": "slice", "relation": "orders", "columns": [payload]})
        assert r.status_code == 400
        assert "unknown column" in r.text

    @pytest.mark.parametrize("payload", [
        "0 OR 1=1",
        "1; DROP TABLE orders",
        "' OR ''='",
    ])
    def test_filter_values_are_literals_never_sql(self, client, payload):
        """v3 interpolated non-VARCHAR values raw, so `0 OR 1=1` in a numeric
        filter widened the result to every row."""
        load(client)
        job = client.post("/api/query", json={
            "mode": "slice", "relation": "orders",
            "filters": {"kind": "group", "children": [
                {"kind": "cond", "column": "amount", "op": ">",
                 "value": payload}]}}).json()
        done = wait(client, job)
        # Either the cast fails or it matches nothing. What must never happen
        # is the payload becoming SQL and returning every row.
        if done["state"] == "done":
            assert done["result"]["total"] == 0, done["result"]["sql"]
        else:
            assert done["state"] == "error"

    def test_a_quote_in_a_value_is_data_not_syntax(self, client):
        load(client)
        job = client.post("/api/query", json={
            "mode": "slice", "relation": "orders",
            "filters": {"kind": "group", "children": [
                {"kind": "cond", "column": "name", "op": "=",
                 "value": "O'Brien"}]}}).json()
        done = wait(client, job)
        assert done["state"] == "done", done
        assert done["result"]["total"] == 0

    def test_relation_names_must_exist(self, client):
        load(client)
        r = client.post("/api/query", json={
            "mode": "slice", "relation": 'orders"; DROP TABLE orders; --'})
        assert r.status_code == 404

    @pytest.mark.parametrize("payload", ["count(*) FROM orders; --", "evil()"])
    def test_aggregates_are_whitelisted(self, client, payload):
        load(client)
        r = client.post("/api/query", json={
            "mode": "pivot", "relation": "orders", "rows": ["name"],
            "value": "amount", "agg": payload})
        assert r.status_code == 400
        assert "unsupported aggregate" in r.text

    @pytest.mark.parametrize("payload", ["=; DROP TABLE orders --", "UNION"])
    def test_operators_are_whitelisted(self, client, payload):
        load(client)
        r = client.post("/api/query", json={
            "mode": "slice", "relation": "orders",
            "filters": {"kind": "group", "children": [
                {"kind": "cond", "column": "amount", "op": payload,
                 "value": "1"}]}})
        assert r.status_code == 400
        assert "unsupported operator" in r.text
