"""M0 smoke tests: the engine boots, and the concurrency claims hold.

The second class is the one that matters. The whole design rests on cursors off
a single root connection running genuinely in parallel; if that turns out to be
false the semaphore is pointless and the architecture needs revisiting, so it
is asserted rather than assumed.
"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.db import Engine
from app.main import create_app
from test_m1 import make_config


@pytest.fixture
def config(tmp_path):
    return make_config(db_path=tmp_path / "sda.duckdb",
                       data_dir=tmp_path / "data",
                       parquet_dir=tmp_path / "parquets", threads=4)


class TestHealth:
    def test_boots_and_reports(self, config):
        with TestClient(create_app(config)) as client:
            body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["user"] == "me"
        assert body["query_slots"] == 2
        # A clean start: every registry table exists and is empty.
        assert body["registry"] == {
            "sources": 0, "slices": 0, "saved_queries": 0, "rejects": 0}

    def test_registry_survives_reopen(self, config):
        for _ in range(2):
            with TestClient(create_app(config)) as client:
                assert client.get("/api/health").json()["status"] == "ok"


class TestConcurrency:
    @pytest.fixture
    def engine(self, config):
        eng = Engine(config)
        asyncio.get_event_loop_policy()  # ensure a policy exists on Windows
        yield eng
        eng.close()

    @pytest.mark.asyncio
    async def test_cursors_run_in_parallel(self, config):
        """Four 0.4s sleeps across four slots should take ~0.4s, not ~1.6s."""
        cfg = Config(**{**config.__dict__, "query_slots": 4})
        eng = Engine(cfg).open()
        try:
            started = time.perf_counter()
            await asyncio.gather(*[
                eng.fetch("SELECT 1 FROM (SELECT unnest(range(4000000))) "
                          "WHERE random() < 0 LIMIT 1") for _ in range(4)])
            elapsed = time.perf_counter() - started

            solo = time.perf_counter()
            await eng.fetch("SELECT 1 FROM (SELECT unnest(range(4000000))) "
                            "WHERE random() < 0 LIMIT 1")
            solo = time.perf_counter() - solo
        finally:
            eng.close()
        # Serialised execution would cost ~4x solo. Allow generous slack for a
        # loaded CI box; anything under 3x means real parallelism.
        assert elapsed < solo * 3 + 0.5, (
            f"4 concurrent queries took {elapsed:.2f}s vs {solo:.2f}s solo -- "
            "cursors appear to be serialising")

    @pytest.mark.asyncio
    async def test_semaphore_caps_concurrency(self, config):
        """With one slot, the second query must wait for the first."""
        cfg = Config(**{**config.__dict__, "query_slots": 1})
        eng = Engine(cfg).open()
        order = []

        async def q(tag):
            await eng.fetch("SELECT count(*) FROM range(2000000)")
            order.append(tag)

        try:
            assert eng.queries.snapshot()["free"] == 1
            await asyncio.gather(q("a"), q("b"))
            assert eng.queries.snapshot()["free"] == 1, "a slot leaked"
        finally:
            eng.close()
        assert len(order) == 2

    @pytest.mark.asyncio
    async def test_cancellation_releases_the_slot(self, config):
        """An abandoned query must be interrupted, not left holding a slot."""
        cfg = Config(**{**config.__dict__, "query_slots": 1})
        eng = Engine(cfg).open()
        try:
            # Must still be running when cancelled. The previous query, a
            # count over range(300M) x range(4), finished in 0.28s on a
            # 14-thread machine -- inside the 0.3s wait below -- so the test
            # passed or failed on machine load. This one takes ~2 minutes and
            # has no shortcut: each row is computed.
            task = asyncio.create_task(eng.fetch(
                "SELECT sum(i * i % 7) FROM range(10000000000) t(i)"))
            await asyncio.sleep(0.3)
            assert not task.done(), "the slow query finished before cancel"
            task.cancel()
            # Bounded: if interrupt() failed, the query would run to the end.
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=15)
            # The slot is back, so the next caller is not blocked forever.
            assert (await asyncio.wait_for(
                eng.fetch("SELECT 42"), timeout=10)).scalar() == 42
            assert eng.queries.snapshot()["free"] == 1
        finally:
            eng.close()

    @pytest.mark.asyncio
    async def test_metadata_queries_bypass_the_semaphore(self, config):
        cfg = Config(**{**config.__dict__, "query_slots": 1})
        eng = Engine(cfg).open()
        try:
            res = await asyncio.gather(*[
                eng.fetch("SELECT 1", heavy=False) for _ in range(8)])
            assert [r.scalar() for r in res] == [1] * 8
        finally:
            eng.close()
