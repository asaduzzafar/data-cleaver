"""The generated sample dataset, and installing it on first run.

The sample is the only data a stranger ever sees, so it is built to
demonstrate the product's claims rather than to look busy:

  * order and customer IDs are zero-padded, so a load that types them as
    numbers visibly ruins them;
  * a few lines in the orders file are malformed, so rejected rows appear;
  * some prices are blank, so NULLs appear;
  * a handful of customer IDs appear twice in the customers file, so joining
    orders to customers multiplies rows and trips the fan-out check;
  * later/ holds the same orders plus one more month, so reloading from it
    makes anything cut from the first load stale;
  * and for the Outliers step, one planted case per check: three orders with
    an absurd quantity (extremes), a product code that appears exactly three
    times (rare), and a promo_code column that is mostly blank (missing) --
    alongside the duplicated customer IDs above (duplicates).

Every value is arithmetic on the row number -- no random generator -- so the
files are byte-identical on every machine and every run. They are written
from Python rather than DuckDB's COPY because the engine runs with
preserve_insertion_order off, which lets a parallel writer reorder rows.
"""

import asyncio
import datetime as dt
from pathlib import Path

from . import folders

ORDERS = "sample_orders.csv"
CUSTOMERS = "sample_customers.csv"
LATER = "later"
SETTING = "sample_installed_at"

SEGMENTS = ("Consumer", "Business", "Public")
COUNTRIES = ("Norway", "Chile", "Kenya", "Japan", "Canada", "India",
             "Brazil", "Spain")
YEAR_START = dt.date(2025, 1, 1)
DECEMBER = dt.date(2025, 12, 1)


def _customers(n_customers):
    yield "customer_id,customer_name,segment,country\n"
    for k in range(1, n_customers + 1):
        cid = f"{k:06d}"
        yield (f"{cid},Customer {cid},{SEGMENTS[k % 3]},"
               f"{COUNTRIES[k % len(COUNTRIES)]}\n")
        if k % 997 == 1:
            # The same customer filed again under another segment: a
            # non-unique key, which is what the fan-out probe exists for.
            yield (f"{cid},Customer {cid},{SEGMENTS[(k + 1) % 3]},"
                   f"{COUNTRIES[k % len(COUNTRIES)]}\n")


def _order_line(i, n_customers, date, *, extreme=False, rare=False):
    cid = (i * 7919) % n_customers + 1
    qty = 4000 if extreme else (i * 13) % 9 + 1
    if i % 2500 == 0:
        price = amount = ""          # a blank field loads as NULL
    else:
        cents = 500 + (i * 97) % 9500
        price = f"{cents // 100}.{cents % 100:02d}"
        total = cents * qty
        amount = f"{total // 100}.{total % 100:02d}"
    product = "P999" if rare else f"P{(i * 31) % 120 + 1:03d}"
    # Mostly blank: set on one order in seven.
    promo = f"PROMO{i % 12 + 1:02d}" if i % 7 == 0 else ""
    return (f"{i:08d},{cid:06d},{date.isoformat()},{product},"
            f"{qty},{price},{amount},{promo}\n")


def _orders(rows, n_customers, extra_month=0):
    yield ("order_id,customer_id,order_date,product_code,quantity,"
           "unit_price,amount,promo_code\n")
    broken = {rows // 4, rows // 2, (3 * rows) // 4}
    # Positions derived from the row count, so every scale plants them.
    extremes = {rows // 7, (2 * rows) // 7, (5 * rows) // 7}
    rares = {rows // 5 + 1, (2 * rows) // 5 + 1, (4 * rows) // 5 + 1}
    for i in range(1, rows + 1):
        date = YEAR_START + dt.timedelta(days=(i * 37) % 334)
        yield _order_line(i, n_customers, date, extreme=i in extremes,
                          rare=i in rares)
        if i in broken:
            # One field too many: the parser rejects it, and it is recorded
            # rather than silently dropped.
            yield (f"{i:08d}X,{1:06d},2025-06-01,P001,1,9.99,9.99,"
                   "PROMO01,EXTRA\n")
    for i in range(rows + 1, rows + extra_month + 1):
        date = DECEMBER + dt.timedelta(days=(i * 37) % 31)
        yield _order_line(i, n_customers, date)


def _write(path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    # newline="\n" keeps the bytes identical on Windows and elsewhere.
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.writelines(lines)
    tmp.replace(path)


def generate(dest, rows):
    """Write the sample files into `dest`, skipping any already there."""
    dest = Path(dest)
    n_customers = max(60, rows // 50)
    plan = [
        (dest / CUSTOMERS, lambda: _customers(n_customers)),
        (dest / ORDERS, lambda: _orders(rows, n_customers)),
        (dest / LATER / ORDERS,
         lambda: _orders(rows, n_customers, extra_month=max(1, rows // 11))),
    ]
    for path, lines in plan:
        if not path.is_file():
            _write(path, lines())


def sample_dir(cfg):
    # In the app's own folder when there is one, so the sample stays put
    # when the user moves the database elsewhere.
    return (cfg.app_dir or cfg.db_path.parent) / "sample"


# ----------------------------------------------------------------------
# Installing: generate, add the folder, load both sources.
# ----------------------------------------------------------------------
class Installer:
    """Tracks one install at a time. State is in memory; the fact that an
    install completed is kept in _settings so a restart does not redo it."""

    def __init__(self):
        self.state = None        # None | "installing" | "failed"
        self.error = None
        self.task = None

    async def status(self, engine):
        if self.state == "installing":
            state = "installing"
        elif await _installed_at(engine):
            state = "installed"
        elif self.state == "failed":
            state = "failed"
        else:
            state = "not_installed"
        return {"state": state, "error": self.error,
                "folder": sample_dir(engine.cfg).resolve().as_posix()}

    def start(self, engine, registry):
        if self.state == "installing":
            return False
        self.state, self.error = "installing", None
        self.task = asyncio.create_task(self._run(engine, registry))
        return True

    async def _run(self, engine, registry):
        try:
            await install(engine, registry)
            self.state = None
        except asyncio.CancelledError:
            self.state = None
            raise
        except Exception as exc:
            self.state, self.error = "failed", f"{type(exc).__name__}: {exc}"

    async def stop(self):
        if self.task is not None and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass


SOURCES = ("sample_orders", "sample_customers")


async def plan_removal(engine):
    """What turning the demo data off removes: the sample sources that are
    loaded, and every slice cut from them however many steps back."""
    from . import catalog
    rels = {r["name"]: r for r in await catalog.relations(engine)}
    sources = [n for n in SOURCES if n in rels]
    slices = []
    for n in sources:
        slices += [d for d in catalog.dependents(n, rels) if d not in slices]
    return rels, sources, slices


async def remove(engine):
    """Turn the demo data off: drop the sample sources and everything cut
    from them, delete their Parquet copies, their rejected rows and the
    generated files, and forget the sample folder. The user's own sources are
    never touched."""
    import shutil
    from . import catalog

    rels, sources, slices = await plan_removal(engine)
    parquets = [rels[n].get("parquet_path") for n in sources]
    for name in slices + sources:
        await catalog.drop(engine, rels[name])
    for name in sources:
        await engine.fetch("DELETE FROM _rejects WHERE source = ?", [name],
                           heavy=False)
    for pq in parquets:
        if pq:
            Path(pq).unlink(missing_ok=True)

    dest = sample_dir(engine.cfg)
    current = await folders.paths(engine)
    keep = [p for p in current if p != folders.normalise(dest)]
    if keep != current:
        await folders.save(engine, keep)
    await engine.fetch("DELETE FROM _settings WHERE k = ?", [SETTING],
                       heavy=False)
    shutil.rmtree(dest, ignore_errors=True)
    return {"removed_sources": sources, "removed_slices": slices}


async def _installed_at(engine):
    res = await engine.fetch("SELECT v FROM _settings WHERE k = ?", [SETTING],
                             heavy=False)
    return res.scalar()


async def _wait(job):
    await job._task
    if job.state != "done":
        raise RuntimeError(f"{job.label}: {job.error or job.state}")


async def install(engine, registry):
    # Deferred import: routers.load imports from this package's modules.
    from .routers.load import submit_load

    cfg = engine.cfg
    dest = sample_dir(cfg)
    owner = cfg.dev_user

    async def gen_runner(job, sess):
        job.set_progress("writing sample files")
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, generate, dest, cfg.sample_rows)
        return {"folder": dest.resolve().as_posix()}

    await _wait(registry.submit(engine, kind="load",
                                label="generate sample data",
                                runner=gen_runner, queue=engine.loads))

    current = await folders.paths(engine)
    path = folders.normalise(dest)
    if not folders.covering(path, current):
        await folders.save(engine, current + [path])

    # Load only what is not already registered: re-running the install must
    # never reload a source, because a reload makes the user's cuts stale.
    registered = {r[0] for r in (await engine.fetch(
        "SELECT view_name FROM _sources", heavy=False)).rows}
    loads = [(dest / ORDERS, "sample_orders", ["order_id", "customer_id"]),
             (dest / CUSTOMERS, "sample_customers", ["customer_id"])]
    jobs = [submit_load(engine, registry, owner, target, view,
                        force_text=text, label=f"load {target.name}")
            for target, view, text in loads if view not in registered]
    for job in jobs:
        await _wait(job)

    await engine.fetch("INSERT OR REPLACE INTO _settings VALUES (?, ?)",
                       [SETTING, dt.datetime.now().isoformat(
                           timespec="seconds")], heavy=False)
