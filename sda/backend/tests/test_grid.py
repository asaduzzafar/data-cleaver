"""F3: what the result grid needs from the backend -- each column's type,
so the header can say what a column is before anyone reads a cell."""

from fastapi.testclient import TestClient

from app.main import create_app
from test_m1 import make_config, share, wait


def test_query_results_carry_column_types(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "t.csv").write_text("id,amount,day\n001,2.5,2025-01-01\n",
                                encoding="utf-8")
    cfg = make_config(db_path=tmp_path / "x.duckdb", data_dir=data,
                      parquet_dir=tmp_path / "pq")
    with TestClient(create_app(cfg)) as c:
        wait(c, c.post("/api/load", json={"path": share(c, "t.csv"),
                                          "force_text": ["id"]}).json())
        res = wait(c, c.post("/api/query", json={
            "mode": "slice", "relation": "t"}).json())["result"]
        assert res["columns"] == ["id", "amount", "day"]
        assert res["types"] == ["VARCHAR", "DOUBLE", "DATE"]
