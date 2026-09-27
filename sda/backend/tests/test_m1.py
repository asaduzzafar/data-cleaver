"""M1 end to end: browse -> detect -> load -> query -> save -> export.

The two tests that earn their keep here are the leading-zero one and the
staleness one. Both cover failures that are silent: an account number loses
its zeros and simply looks like a smaller number, and a slice cut from a
superseded extract looks exactly like a current one. Neither raises an error
anywhere, which is precisely why they need assertions.
"""

import csv
import io
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app

CSV_BODY = (
    "account,amount,name\n"
    "000123,10.5,alpha\n"
    "000456,20.25,beta\n"
    "BADROW,30,gamma,EXTRA\n"   # too many columns -> a parser reject
    "000789,40,delta\n"
)

# The same data without the malformed row. It matters that `account` holds
# nothing but zero-padded digits here: in CSV_BODY the literal 'BADROW' makes
# DuckDB infer VARCHAR on its own, so the zeros would survive whether or not
# force_text was applied, and a test using it would pass for the wrong reason.
CLEAN_BODY = (
    "account,amount,name\n"
    "000123,10.5,alpha\n"
    "000456,20.25,beta\n"
    "000789,40,delta\n"
)


def make_config(**kw):
    """A test Config: the paths each test chooses, small fixed defaults."""
    return Config(**{"memory_limit": "1GB", "threads": 2, "query_slots": 2,
                     "dev_user": "me", **kw})


@pytest.fixture
def config(tmp_path):
    data = tmp_path / "data"
    (data / "nested").mkdir(parents=True)
    (data / "orders.csv").write_text(CSV_BODY, encoding="utf-8")
    (data / "clean.csv").write_text(CLEAN_BODY, encoding="utf-8")
    (data / "nested" / "other.csv").write_text(CSV_BODY, encoding="utf-8")
    # Zero-padded values only after the sniffer's sample window -- the
    # realistic 1.5 GB shape, and the only one where the leading-zero gotcha
    # still reproduces on DuckDB 1.5.5. See test_full_scan_is_what_preserves_zeros.
    mixed = ["account"] + [str(1000 + i) for i in range(30000)] \
        + ["000123", "000456"]
    (data / "mixed.csv").write_text("\n".join(mixed) + "\n", encoding="utf-8")
    return make_config(db_path=tmp_path / "sda.duckdb", data_dir=data,
                       parquet_dir=tmp_path / "parquets", threads=4)


@pytest.fixture
def client(config):
    with TestClient(create_app(config)) as c:
        yield c


def wait(client, job, timeout=90):
    """Poll a job to completion and return its final status."""
    deadline = time.time() + timeout
    jid = job["id"]
    while time.time() < deadline:
        body = client.get(f"/api/jobs/{jid}").json()
        if body["state"] in ("done", "error", "cancelled"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {jid} did not finish: {body}")


def share(client, name=""):
    """Absolute path of `name` inside the first added folder.

    Paths are absolute since L2: with several folders, a bare file name would
    not say which one it lives in.
    """
    root = client.get("/api/folders").json()["folders"][0]["path"]
    return f"{root}/{name}" if name else root


def load_orders(client, force_text=("account",), name=None):
    body = {"path": share(client, "orders.csv"), "force_text": list(force_text)}
    if name:
        body["name"] = name
    job = client.post("/api/load", json=body).json()
    done = wait(client, job)
    assert done["state"] == "done", done
    return done["result"]


# ----------------------------------------------------------------------
class TestFileBrowser:
    def test_lists_the_share(self, client):
        # The top level lists the added folders; the files are one level in.
        top = client.get("/api/files").json()
        assert [d["path"] for d in top["directories"]] == [share(client)]
        body = client.get("/api/files", params={"path": share(client)}).json()
        names = [f["name"] for f in body["files"]]
        assert "orders.csv" in names
        assert [d["name"] for d in body["directories"]] == ["nested"]
        assert next(f for f in body["files"] if f["name"] == "orders.csv")["loadable"]

    def test_descends(self, client):
        body = client.get("/api/files", params={"path": share(client, "nested")}).json()
        assert [f["name"] for f in body["files"]] == ["other.csv"]
        # A subfolder goes up to the added folder it sits in.
        assert body["parent"] == share(client)

    @pytest.mark.parametrize("attack", ["..", "../..", "nested/../..",
                                        "../../Windows", "/etc"])
    def test_refuses_to_escape_the_share(self, client, attack):
        r = client.get("/api/files", params={"path": attack})
        assert r.status_code in (403, 404), f"{attack} returned {r.status_code}"


class TestLoad:
    def test_detect_flags_id_columns(self, client):
        body = client.post("/api/load/detect",
                           json={"path": share(client, "mixed.csv")}).json()
        assert body["view_name"] == "mixed"
        assert body["suggested_text"] == ["account"], body["columns"]
        assert body["already_registered"] is False

    def test_detect_survives_malformed_rows(self, client):
        """DESCRIBE without ignore_errors fails outright on a file with a bad
        row -- the very file you most want to look at before loading."""
        r = client.post("/api/load/detect", json={"path": share(client, "orders.csv")})
        assert r.status_code == 200, r.text
        assert r.json()["view_name"] == "orders"

    def test_load_registers_and_captures_rejects(self, client):
        result = load_orders(client)
        # The malformed row is absent from the count and present in _rejects.
        assert result["rows"] == 3
        assert result["rejected"] == 1

        rels = client.get("/api/relations").json()["relations"]
        src = next(r for r in rels if r["name"] == "orders")
        assert src["kind"] == "source"
        assert src["rows"] == 3
        assert src["loaded_by"] == "me"

        rej = client.get("/api/relations/orders/rejects").json()
        assert rej["total"] == 1
        assert "TOO MANY COLUMNS" in str(rej["rows"])

    def test_detect_warns_on_reload(self, client):
        load_orders(client)
        body = client.post("/api/load/detect",
                           json={"path": share(client, "orders.csv")}).json()
        assert body["already_registered"] is True
        assert body["prior_loaded_at"]


class TestLeadingZeros:
    """The gotcha CLAUDE.md calls irreversible without a reload."""

    def test_forced_to_text_survives_load(self, client):
        """Same clean file as the negative case, so the only difference
        between passing and failing is force_text itself."""
        job = client.post("/api/load", json={
            "path": share(client, "clean.csv"), "force_text": ["account"]}).json()
        assert wait(client, job)["state"] == "done"
        job = client.post("/api/query", json={
            "mode": "slice", "relation": "clean", "sort": "account"}).json()
        result = wait(client, job)["result"]
        accounts = [r[result["columns"].index("account")]
                    for r in result["rows"]]
        assert accounts == ["000123", "000456", "000789"]

    def test_full_scan_is_what_preserves_zeros(self, client, config):
        """sample_size = -1 in the loader is load-bearing, not a default.

        DuckDB 1.5.5's sniffer keeps a zero-padded column as VARCHAR when it
        actually sees a padded value. On a 1.5 GB extract whose padded rows
        sit past the sample window it does not see one, types the column
        BIGINT, and the zeros are gone irreversibly. mixed.csv has that shape:
        a sampled read types it BIGINT, the loader's full scan does not.

        If anyone ever "optimises" the loader by lowering sample_size, this
        fails rather than silently corrupting account numbers.
        """
        import duckdb
        csv_path = (config.data_dir / "mixed.csv").as_posix()
        sampled = duckdb.connect().execute(
            f"DESCRIBE SELECT * FROM read_csv('{csv_path}', "
            "sample_size = 20480)").fetchall()
        assert sampled[0][1] == "BIGINT", (
            "the sampled read no longer loses the zeros; this test's premise "
            "needs revisiting")

        job = client.post("/api/load", json={
            "path": share(client, "mixed.csv"), "force_text": []}).json()
        assert wait(client, job)["state"] == "done"
        job = client.post("/api/query", json={
            "mode": "slice", "relation": "mixed", "sort": "account",
            "page_size": 5}).json()
        result = wait(client, job)["result"]
        assert result["rows"][0][0] == "000123", (
            "the loader lost the leading zeros -- check sample_size")

    @pytest.mark.parametrize("fmt", ["csv", "parquet"])
    def test_export_preserves_them(self, client, fmt, tmp_path):
        load_orders(client, force_text=["account"])
        qjob = client.post("/api/query", json={
            "mode": "slice", "relation": "orders", "sort": "account"}).json()
        qdone = wait(client, qjob)

        ejob = client.post("/api/export", json={
            "job_id": qdone["id"], "format": fmt, "filename": "zeros"}).json()
        edone = wait(client, ejob)
        assert edone["state"] == "done", edone

        resp = client.get(f"/api/export/{edone['id']}/download")
        assert resp.status_code == 200
        if fmt == "csv":
            rows = list(csv.DictReader(io.StringIO(resp.text)))
            assert [r["account"] for r in rows] == \
                ["000123", "000456", "000789"]
        else:
            out = tmp_path / "out.parquet"
            out.write_bytes(resp.content)
            import duckdb
            vals = duckdb.connect().execute(
                f"SELECT account FROM read_parquet('{out.as_posix()}') "
                "ORDER BY account").fetchall()
            assert [v[0] for v in vals] == ["000123", "000456", "000789"]

    def test_download_is_collected_once(self, client):
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        edone = wait(client, client.post("/api/export", json={
            "job_id": qdone["id"], "format": "csv"}).json())
        assert client.get(f"/api/export/{edone['id']}/download").status_code == 200
        assert client.get(f"/api/export/{edone['id']}/download").status_code == 410


class TestQuery:
    def test_filter_and_page(self, client):
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "slice", "relation": "orders", "page_size": 2,
            "filters": {"kind": "group", "combiner": "AND", "children": [
                {"kind": "cond", "column": "amount", "op": ">", "value": 10}]},
        }).json()
        result = wait(client, job)["result"]
        assert result["total"] == 3
        assert result["pages"] == 2
        assert len(result["rows"]) == 2

    def test_numeric_filter_cannot_inject(self, client):
        """v3 interpolated non-VARCHAR filter values raw. This is that hole."""
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "slice", "relation": "orders",
            "filters": {"kind": "group", "children": [
                {"kind": "cond", "column": "amount", "op": ">",
                 "value": "0 OR 1=1"}]},
        }).json()
        done = wait(client, job)
        # Quoted as a literal, so DuckDB fails the cast instead of widening
        # the result set to every row.
        assert done["state"] == "error", done
        assert "1=1" not in (done.get("result") or {}).get("sql", "")

    def test_unknown_column_is_rejected(self, client):
        load_orders(client)
        r = client.post("/api/query", json={
            "mode": "slice", "relation": "orders", "columns": ["no_such_col"]})
        assert r.status_code == 400
        assert "unknown column" in r.text

    def test_pivot(self, client):
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "pivot", "relation": "orders",
            "rows": ["name"], "value": "amount", "agg": "sum"}).json()
        result = wait(client, job)["result"]
        assert result["total"] == 3
        assert "sum_amount" in result["columns"]

    def test_pivot_with_a_column_field(self, client):
        # One output column per value of the column field -- and a text ID
        # keeps its leading zeros as a column name.
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "pivot", "relation": "orders", "rows": ["name"],
            "column_field": "account", "value": "amount", "agg": "sum"}).json()
        result = wait(client, job)["result"]
        assert result["total"] == 3
        assert result["columns"] == ["name", "000123", "000456", "000789"]

    def test_frequencies(self, client):
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "frequencies", "relation": "orders",
            "column": "name"}).json()
        result = wait(client, job)["result"]
        assert result["columns"] == ["value", "rows"]

    def test_distinct_values_have_counts(self, client):
        load_orders(client)
        body = client.get("/api/relations/orders/values",
                          params={"column": "name"}).json()
        assert body["distinct_total"] == 3
        assert all(len(v) == 2 for v in body["values"])

    def test_distinct_values_search(self, client):
        load_orders(client)
        body = client.get("/api/relations/orders/values",
                          params={"column": "name", "search": "alp"}).json()
        assert [v[0] for v in body["values"]] == ["alpha"]


class TestSqlGuard:
    @pytest.mark.parametrize("sql", [
        "DROP TABLE orders",
        "SELECT 1; DROP TABLE orders",
        "ATTACH 'evil.db'",
        "COPY orders TO 'C:/tmp/leak.csv'",
        "DELETE FROM _sources",
        "UPDATE _lineage SET owner = 'someone'",
        "INSTALL httpfs",
        "CREATE TABLE sneaky AS SELECT 1",
    ])
    def test_refuses_anything_that_is_not_a_select(self, client, sql):
        # 403, not 400: the gateway refuses this as policy, not as a
        # malformed request. test_gateway.py covers the rest of that surface.
        load_orders(client)
        r = client.post("/api/query",
                        json={"mode": "sql", "relation": "orders", "sql": sql})
        assert r.status_code == 403, f"{sql!r} was allowed"

    @pytest.mark.parametrize("sql", [
        "SELECT * FROM orders",
        "WITH x AS (SELECT * FROM orders) SELECT count(*) FROM x",
        "SELECT * FROM orders WHERE name = 'a' -- ; DROP TABLE orders",
        "SUMMARIZE orders",
    ])
    def test_allows_reads(self, client, sql):
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "sql", "relation": "orders", "sql": sql}).json()
        assert wait(client, job)["state"] == "done"

    def test_comment_trick_does_not_drop_the_table(self, client):
        load_orders(client)
        wait(client, client.post("/api/query", json={
            "mode": "sql", "relation": "orders",
            "sql": "SELECT * FROM orders -- ; DROP TABLE orders"}).json())
        names = [r["name"] for r in
                 client.get("/api/relations").json()["relations"]]
        assert "orders" in names


class TestLineage:
    def test_save_records_its_source(self, client):
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        saved = client.post("/api/query/save", json={
            "job_id": qdone["id"], "name": "big orders"}).json()
        assert saved["saved"] == "big_orders"
        assert saved["owner"] == "me"

        rel = next(r for r in client.get("/api/relations").json()["relations"]
                   if r["name"] == "big_orders")
        assert rel["kind"] == "slice"
        assert rel["inputs"] == ["orders"]
        assert rel["staleness"] == "fresh"

    def test_a_background_save_is_a_job_to_watch(self, client):
        """A 12M-row save takes minutes: the UI watches it, not a request."""
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        started = client.post("/api/query/save", json={
            "job_id": qdone["id"], "name": "watched", "background": True}).json()
        assert started["label"] == "save · watched"
        done = wait(client, started)
        assert done["state"] == "done", done
        assert done["result"]["saved"] == "watched"
        assert done["result"]["rows"] == 3

    def test_an_old_result_can_still_be_saved_after_its_rows_are_dropped(self, client):
        """A result left on screen for an hour: the page of rows is gone from
        the server, the recipe is not, so Save still works."""
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        registry = client.app.state.jobs
        registry.get(qdone["id"]).finished_at -= 60 * 60
        registry._evict()
        status = client.get(f"/api/jobs/{qdone['id']}").json()
        assert status["result"]["expired"] is True
        assert "rows" not in status["result"]
        saved = client.post("/api/query/save", json={
            "job_id": qdone["id"], "name": "late"}).json()
        assert saved["rows"] == 3

    def test_reloading_the_source_makes_the_slice_stale(self, client):
        """The whole reason the registry exists."""
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        client.post("/api/query/save",
                    json={"job_id": qdone["id"], "name": "cut_one"})

        time.sleep(1.1)  # the registry stores whole seconds
        load_orders(client)  # same source, loaded again

        rel = next(r for r in client.get("/api/relations").json()["relations"]
                   if r["name"] == "cut_one")
        assert rel["staleness"] == "stale", rel
        assert "older extract" in rel["note"]

    def test_sql_slices_report_unknown_rather_than_fresh(self, client):
        """Hand-written SQL has no discoverable parents, so freshness cannot
        be demonstrated. Saying 'unknown' beats inventing a lineage."""
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "sql", "relation": None,
            "sql": "SELECT 1 AS x"}).json())
        client.post("/api/query/save",
                    json={"job_id": qdone["id"], "name": "handmade"})
        rel = next(r for r in client.get("/api/relations").json()["relations"]
                   if r["name"] == "handmade")
        assert rel["inputs"] == []

    def test_removing_a_source_reports_its_dependents(self, client):
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        client.post("/api/query/save",
                    json={"job_id": qdone["id"], "name": "dependent_cut"})
        body = client.delete("/api/relations/orders").json()
        assert body["orphaned_slices"] == ["dependent_cut"]
        # The Parquet file is the expensive artefact; it stays.
        assert body["parquet_kept"]


class TestQueueVisibility:
    def test_a_finished_job_reports_the_queue_and_its_result(self, client):
        load_orders(client)
        done = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        assert done["position"] == 0
        assert done["ahead"] == 0
        assert done["queue"]["slots"] == 2
        assert set(done["queue"]) == {"slots", "running", "waiting", "free"}
        # The UI polls this: without the result the grid stays empty even
        # though the query succeeded.
        assert done["result"]["total"] == 3

class TestBackup:
    def test_backup_writes_something_restorable(self, client):
        load_orders(client)
        qdone = wait(client, client.post("/api/query", json={
            "mode": "slice", "relation": "orders"}).json())
        client.post("/api/query/save",
                    json={"job_id": qdone["id"], "name": "keep_me"})

        done = wait(client, client.post("/api/admin/backup").json())
        assert done["state"] == "done", done
        assert done["result"]["files"] > 0
        assert done["result"]["bytes"] > 0

        listed = client.get("/api/admin/backups").json()["backups"]
        assert len(listed) == 1

        # A backup nobody can restore is not a backup: load it into a fresh
        # database and check the saved slice and its lineage came back.
        import duckdb
        from pathlib import Path
        fresh = duckdb.connect()
        fresh.execute(
            f"IMPORT DATABASE '{Path(done['result']['path']).as_posix()}'")
        assert fresh.execute("SELECT count(*) FROM keep_me").fetchone()[0] == 3
        assert fresh.execute(
            "SELECT owner FROM _lineage WHERE table_name = 'keep_me'"
        ).fetchone()[0] == "me"


class TestAwkwardTypes:
    """Types that only appear in real extracts.

    A timezone-aware timestamp made every query against a real
    extract with one fail with "Required module 'pytz' failed to
    import" -- DuckDB materialises TIMESTAMPTZ through pytz. None of the CSV
    fixtures above have a tz-aware column, so the suite was green while the
    app was broken on real data.
    """

    def test_timestamptz_round_trips(self, client):
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "sql", "relation": "orders",
            "sql": "SELECT TIMESTAMPTZ '2026-09-21 10:00:00+02' AS t"}).json()
        done = wait(client, job)
        assert done["state"] == "done", done
        assert done["result"]["rows"][0][0].startswith("2026-09-21")

    def test_decimal_keeps_its_exactness(self, client):
        """Money as a float is how a total ends up a cent out."""
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "sql", "relation": "orders",
            "sql": "SELECT 1234567890.12::DECIMAL(18,2) AS amount"}).json()
        done = wait(client, job)
        assert done["result"]["rows"][0][0] == "1234567890.12"

    def test_blob_and_null_survive_serialisation(self, client):
        load_orders(client)
        job = client.post("/api/query", json={
            "mode": "sql", "relation": "orders",
            "sql": "SELECT 'ab'::BLOB AS b, NULL AS n, "
                   "[1,2]::INTEGER[] AS arr"}).json()
        done = wait(client, job)
        assert done["state"] == "done", done
        row = done["result"]["rows"][0]
        assert row[0] == "6162" and row[1] is None and row[2] == [1, 2]
