"""E3: the Outliers step -- what does not fit.

Every anomaly in the fixture is planted and counted by hand, and the rule
that matters most is checked for every finding: its count equals exactly the
rows its "show these rows" query returns. A finding that says 3 and opens 4
is worse than no finding at all.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_m1 import make_config, share, wait

# 100 ordinary rows, then the plants:
#   amount   1..100, plus 9999 and -500              -> 2 extremes
#   kind     a/b/c, plus "zz" once and "yy" twice      -> 2 rare values, 3 rows
#   memo     filled on every third ordinary row        -> blanks
#   ref      unique, plus "d1" x3 and "d2" x2          -> 2 repeated keys, 5 rows
#   two rows blank in every column but ref             -> mostly blank
lines = []
for i in range(1, 101):
    memo = f"m{i}" if i % 3 == 0 else ""
    lines.append(f"r{i:03d},{i},{'abc'[i % 3]},{memo}")
lines += ["d1,50,a,", "d1,51,b,", "d1,52,c,", "d2,53,a,", "d2,54,b,",
          "x1,9999,a,", "x2,-500,b,",
          "y1,20,zz,", "y2,21,yy,", "y3,22,yy,",
          "e1,,,", "e2,,,"]
CSV = "ref,amount,kind,memo\n" + "\n".join(lines) + "\n"
TOTAL = 112


@pytest.fixture
def client(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "odd.csv").write_text(CSV, encoding="utf-8")
    cfg = make_config(db_path=tmp_path / "x.duckdb", data_dir=data,
                      parquet_dir=tmp_path / "pq")
    with TestClient(create_app(cfg)) as c:
        job = c.post("/api/load", json={"path": share(c, "odd.csv"),
                                        "force_text": ["ref"]}).json()
        assert wait(c, job)["state"] == "done"
        yield c


def outliers(client, **params):
    r = client.post("/api/relations/odd/outliers", json=params)
    assert r.status_code == 200, r.text
    done = wait(client, r.json())
    assert done["state"] == "done", done
    return done["result"]


def rows_opened(client, show):
    done = wait(client, client.post("/api/query", json={
        **show, "page_size": 5000}).json())
    assert done["state"] == "done", done
    return done["result"]["total"]


def find(findings, column):
    return next(f for f in findings if f["column"] == column)


class TestExtremes:
    def test_beyond_the_iqr_fences(self, client):
        f = find(outliers(client)["extremes"], "amount")
        assert f["count"] == 2
        assert f["low"] < 1 and f["high"] > 100
        assert (f["below"], f["above"]) == (1, 1)

    def test_k_widens_the_fences(self, client):
        narrow = find(outliers(client, k=1.5)["extremes"], "amount")
        wide = find(outliers(client, k=3)["extremes"], "amount")
        assert wide["high"] > narrow["high"] and wide["low"] < narrow["low"]

    def test_carries_the_distribution_the_fences_sit_on(self, client):
        f = find(outliers(client)["extremes"], "amount")
        bins = f["histogram"]
        assert sum(b["count"] for b in bins) == TOTAL - 2   # two blank amounts
        assert bins[0]["lo"] == -500 and bins[-1]["hi"] == 9999

    def test_k_is_bounded(self, client):
        r = client.post("/api/relations/odd/outliers", json={"k": 10})
        assert r.status_code == 422


class TestRare:
    def test_values_seen_at_most_n_times(self, client):
        f = find(outliers(client, n=2)["rare"], "kind")
        assert {v["value"]: v["count"] for v in f["values"]} == {"zz": 1, "yy": 2}
        assert f["count"] == 3          # rows carrying a rare value

    def test_keys_are_not_rare_categories(self, client):
        """ref is nearly all-unique: every value is 'rare', which says
        nothing. It belongs to the duplicates check instead."""
        assert not [f for f in outliers(client)["rare"] if f["column"] == "ref"]


class TestMissing:
    def test_blank_counts_per_column(self, client):
        m = outliers(client)["missing"]
        memo = find(m["columns"], "memo")
        assert memo["count"] == TOTAL - 33      # 33 ordinary rows have a memo
        assert find(m["columns"], "amount")["count"] == 2

    def test_mostly_blank_rows(self, client):
        assert outliers(client)["missing"]["mostly_blank"]["count"] == 2


class TestDuplicates:
    def test_repeated_keys(self, client):
        f = find(outliers(client)["duplicates"], "ref")
        assert f["values"] == 2          # d1 and d2
        assert f["count"] == 5           # rows carrying a repeated key
        assert f["worst"] == {"value": "d1", "count": 3}

    def test_non_keys_are_not_duplicate_findings(self, client):
        assert not [f for f in outliers(client)["duplicates"]
                    if f["column"] == "kind"]


class TestShowTheseRows:
    def test_every_count_equals_the_rows_it_opens(self, client):
        o = outliers(client, n=2)
        findings = (o["extremes"] + o["rare"] + o["duplicates"]
                    + o["missing"]["columns"] + [o["missing"]["mostly_blank"]])
        assert len(findings) >= 6
        for f in findings:
            assert rows_opened(client, f["show"]) == f["count"], f

    def test_unknown_relation_is_a_404(self, client):
        assert client.post("/api/relations/nope/outliers",
                           json={}).status_code == 404
