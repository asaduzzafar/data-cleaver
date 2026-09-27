"""E1: the Profile step's backend -- what is in a relation.

The fixture is small enough that every answer is known in advance, and each
column carries exactly one thing a lead should notice (or nothing, as a
control). Leads must come from the data, never from a column's name.
"""

import pytest
from fastapi.testclient import TestClient

from app import profile
from app.main import create_app
from test_m1 import make_config, share, wait

# 40 good rows plus one malformed line (the parser rejects it).
#   ref      text ID, unique except "r007" appears twice          -> duplicates
#   amount   1..39 plus one 5000                                   -> extremes
#   kind     "a"/"b" throughout, "zz" once                         -> rare
#   memo     blank in 30 of 40 rows                                -> missing
#   day      dates in January 2025                                 -> (control)
ROWS = []
for i in range(1, 41):
    ref = "r007" if i == 8 else f"r{i:03d}"
    amount = 5000 if i == 40 else i
    kind = "zz" if i == 20 else ("a" if i % 2 else "b")
    memo = "" if i <= 30 else f"note {i}"
    day = f"2025-01-{(i % 28) + 1:02d}"
    ROWS.append(f"{ref},{amount},{kind},{memo},{day}")
CSV = ("ref,amount,kind,memo,day\n" + "\n".join(ROWS[:20])
       + "\nBROKEN,1,a,x,2025-01-01,EXTRA\n" + "\n".join(ROWS[20:]) + "\n")


@pytest.fixture
def client(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "things.csv").write_text(CSV, encoding="utf-8")
    cfg = make_config(db_path=tmp_path / "x.duckdb", data_dir=data,
                      parquet_dir=tmp_path / "pq")
    with TestClient(create_app(cfg)) as c:
        job = c.post("/api/load", json={"path": share(c, "things.csv"),
                                        "force_text": ["ref"]}).json()
        assert wait(c, job)["state"] == "done"
        yield c


def run_profile(client, name="things"):
    r = client.post(f"/api/relations/{name}/profile")
    assert r.status_code == 200, r.text
    done = wait(client, r.json())
    assert done["state"] == "done", done
    return done["result"]


def col(result, name):
    return next(c for c in result["columns"] if c["name"] == name)


class TestTheWholeRelation:
    def test_rows_columns_and_rejects(self, client):
        p = run_profile(client)
        assert p["rows"] == 40
        assert p["rejected"] == 1
        assert [c["name"] for c in p["columns"]] == [
            "ref", "amount", "kind", "memo", "day"]
        # Small enough to be exact: nothing is labelled approximate.
        assert p["approx"] is False

    def test_unknown_relation_is_a_404(self, client):
        assert client.post("/api/relations/nope/profile").status_code == 404


class TestPerColumn:
    def test_fill_and_distinct_are_exact_on_small_tables(self, client):
        p = run_profile(client)
        memo = col(p, "memo")
        assert (memo["non_null"], memo["null_pct"]) == (10, 75.0)
        assert col(p, "ref")["distinct"] == 39      # r007 twice
        assert col(p, "kind")["distinct"] == 3

    def test_numbers_get_range_quartiles_and_a_histogram(self, client):
        a = col(p := run_profile(client), "amount")
        assert a["family"] == "number"
        assert (a["min"], a["max"]) == (1, 5000)
        assert a["q1"] < a["median"] < a["q3"]
        bins = a["histogram"]
        assert sum(b["count"] for b in bins) == 40
        assert bins[0]["lo"] == 1 and bins[-1]["hi"] == 5000
        # The one extreme value sits alone in the top bin.
        assert bins[-1]["count"] == 1

    def test_dates_get_a_histogram_too(self, client):
        d = col(run_profile(client), "day")
        assert d["family"] == "temporal"
        assert d["min"].startswith("2025-01-01") or d["min"] == "2025-01-02"
        assert sum(b["count"] for b in d["histogram"]) == 40

    def test_text_gets_top_values(self, client):
        k = col(run_profile(client), "kind")
        assert k["family"] == "text"
        assert k["top"][0]["value"] in ("a", "b")
        assert sum(t["count"] for t in k["top"]) == 40
        assert k["histogram"] is None


class TestLeads:
    def test_each_planted_oddity_becomes_a_lead(self, client):
        leads = {(l["column"], l["check"]) for l in run_profile(client)["leads"]}
        assert ("memo", "missing") in leads
        assert ("ref", "duplicates") in leads
        assert ("amount", "extremes") in leads
        assert ("kind", "rare") in leads

    def test_the_control_column_raises_nothing(self, client):
        leads = run_profile(client)["leads"]
        assert not [l for l in leads if l["column"] == "day"]

    def test_leads_explain_themselves(self, client):
        lead = next(l for l in run_profile(client)["leads"]
                    if l["check"] == "missing")
        assert "75" in lead["summary"]          # says how many are blank


class TestApproximateAboveTheExactLimit:
    def test_large_relations_are_labelled_approximate(self, client,
                                                      monkeypatch):
        monkeypatch.setattr(profile, "EXACT_LIMIT", 10)
        p = run_profile(client)
        assert p["approx"] is True
        assert col(p, "ref")["distinct_approx"] is True
