"""Process-wide DuckDB ownership.

DuckDB takes an exclusive lock on the database file: exactly one process may
hold it read-write, and no other process may open it at all while that lock is
held -- not even read-only. That is why this app runs a *single* uvicorn worker.

Concurrency lives inside that one process. `root.cursor()` hands out an
independent connection against the same database instance, and DuckDB releases
the GIL while a query executes, so cursors dispatched to the thread pool run
genuinely in parallel rather than taking turns.

What this module does NOT provide is a per-user memory budget. `memory_limit`,
`threads` and `temp_directory` are all GLOBAL scope in DuckDB (verified on
1.5.5), so they are set once here for the whole server. Bounding the *number*
of concurrent heavy queries is the only lever available; one pathological query
can still exhaust the box.
"""

import asyncio
import contextlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import duckdb
from fastapi import Request

from .registry import ensure_schema
from .slots import SlotQueue


@dataclass(frozen=True)
class Result:
    columns: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    # SQL type of each column, e.g. "DECIMAL(12,2)", aligned with columns.
    types: list = field(default_factory=list)

    def dicts(self):
        return [dict(zip(self.columns, r)) for r in self.rows]

    def scalar(self):
        return self.rows[0][0] if self.rows else None

    def one(self):
        return self.dicts()[0] if self.rows else None


class Session:
    """A cursor held for a sequence of statements.

    Multi-statement work has to share one cursor. DuckDB's `store_rejects`
    writes its `reject_errors` table into the connection's own temp schema, so
    a load that ran each statement on a fresh cursor would find it empty and
    silently record no rejected rows.
    """

    def __init__(self, engine, cur):
        self._engine = engine
        self.cur = cur

    async def run(self, sql, params=None):
        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(
            self._engine.pool, _execute, self.cur, sql, params)
        # Read the outcome even if nobody waits for it any more.
        fut.add_done_callback(lambda f: f.cancelled() or f.exception())
        try:
            # asyncio.wait, not shield: cancelling this waiter leaves the
            # statement running until it is interrupted, as shield would --
            # but shield (Python 3.12+) also logs "exception in shielded
            # future" whenever the statement then fails, which every
            # interrupted query does. Reproduced 3/3 on a job cancel.
            await asyncio.wait({fut})
        except asyncio.CancelledError:
            # The usual cause is a client that navigated away. Interrupt rather
            # than let the query finish into a response nobody will read while
            # still holding a slot.
            self.cur.interrupt()
            with contextlib.suppress(Exception):
                await asyncio.wait({fut})
            raise
        return fut.result()

    def interrupt(self):
        with contextlib.suppress(Exception):
            self.cur.interrupt()


def _execute(cur, sql, params):
    cur.execute(sql, params) if params else cur.execute(sql)
    if cur.description is None:
        return Result()
    return Result([d[0] for d in cur.description], cur.fetchall(),
                  [str(d[1]) for d in cur.description])


class Engine:
    """Owns the root connection, the slot queues and the thread pool."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.pool = None
        self.queries = None
        self.loads = None
        self._root = None

    # -- lifecycle ------------------------------------------------------
    def open(self):
        cfg = self.cfg
        for d in (cfg.db_path.parent, cfg.parquet_dir):
            d.mkdir(parents=True, exist_ok=True)

        self._root = duckdb.connect(str(cfg.db_path))
        self._root.execute("SET preserve_insertion_order = false")
        self._root.execute(f"SET memory_limit = '{cfg.memory_limit}'")
        self._root.execute(f"SET threads = {cfg.threads}")
        # DuckDB path literals must be forward-slashed, on every platform.
        self._root.execute(
            f"SET temp_directory = '{cfg.db_path.parent.as_posix()}'")
        if cfg.extension_dir is not None:
            # The packaged app's pre-installed extensions: INSTALL finds them
            # there and downloads nothing.
            self._root.execute(
                f"SET extension_directory = '{cfg.extension_dir.as_posix()}'")
        ensure_schema(self._root)

        self.queries = SlotQueue(cfg.query_slots)
        # One slot. A 1.5 GB CSV -> Parquet conversion runs alone rather than
        # competing with interactive queries for memory and threads.
        self.loads = SlotQueue(1)
        self.pool = ThreadPoolExecutor(
            max_workers=cfg.query_slots + 4, thread_name_prefix="duckdb")
        return self

    def close(self):
        if self.pool is not None:
            self.pool.shutdown(wait=True, cancel_futures=True)
        if self._root is not None:
            self._root.close()
        self._root = self.pool = None

    # -- execution ------------------------------------------------------
    @asynccontextmanager
    async def session(self, *, heavy=True, ticket=None, queue=None):
        """Borrow a cursor, optionally holding a concurrency slot.

        `heavy=False` skips the queue entirely -- for schema lookups and
        registry reads too cheap to be worth putting behind a pivot.
        """
        q = queue if queue is not None else (self.queries if heavy else None)
        cur = self._root.cursor()
        try:
            if q is None:
                yield Session(self, cur)
            else:
                async with q.hold(ticket):
                    yield Session(self, cur)
        finally:
            with contextlib.suppress(Exception):
                cur.close()

    async def fetch(self, sql, params=None, *, heavy=True, ticket=None):
        async with self.session(heavy=heavy, ticket=ticket) as s:
            return await s.run(sql, params)


def get_engine(request: Request) -> Engine:
    """FastAPI dependency: the engine stored on app state by the lifespan.

    The annotation is load-bearing -- without it FastAPI reads `request` as a
    query parameter and every endpoint using this dependency 422s.
    """
    return request.app.state.engine
