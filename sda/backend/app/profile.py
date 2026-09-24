"""Profiling a relation: the first step of the EDA path.

What is in it, column by column -- type, how full, how many distinct values,
range and quartiles, a small distribution -- and a short list of leads worth
a look, each naming the Outliers check that investigates it.

Exact where it is cheap, labelled where it is not. SUMMARIZE's distinct
counts and quartiles are sketches (measured here: 110 "unique" values in a
column holding exactly 100), so up to EXACT_LIMIT rows they are recomputed
exactly; above it they are returned with `approx` set, and the UI says so.
Presenting a sketch as a count is the kind of plausible-looking number this
product exists to refuse.

Leads come from the data, never from a column's name: a column called
"customer_id" is not assumed to be a key, and one called "notes" is not
assumed to be optional.
"""

from .sqlgen import qi, type_family

EXACT_LIMIT = 200_000       # rows; above this, distincts and quartiles are sketches
HIST_BINS = 24
TOP_VALUES = 5
# Top values describe a categorical column; for one with thousands of values
# every share rounds to 0% and says nothing (seen on a 19,582-value ID column).
TOP_DISTINCT_LIMIT = 1_000

# Lead thresholds, in one place so they are tested and tuned together.
MISSING_PCT = 5.0            # blank in at least this share of rows
KEY_UNIQUE_RATIO = 0.95      # distinct/non-null at or above this: behaves like a key
EXTREME_IQR = 3.0            # a value past Q3 + 3·IQR (or below Q1 − 3·IQR)
RARE_COUNT = 5               # a category seen at most this many times...
RARE_MAX_DISTINCT = 1_000    # ...in a column with at most this many categories


def fmt(v):
    """A number for a sentence: 4,000 / 388 / 91.51 -- never 91.51029303267038."""
    if v is None:
        return "unknown"
    v = float(v)
    if v.is_integer() or abs(v) >= 1000:
        return f"{v:,.0f}"
    return f"{v:.4g}"


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f.is_integer() else f


async def _one(session, sql, params=None):
    return (await session.run(sql, params)).one()


async def _summary(session, rel):
    res = await session.run(f"SUMMARIZE {qi(rel)}")
    return {r["column_name"]: r for r in res.dicts()}


async def _exact_stats(session, rel, cols):
    """Exact distinct counts, and exact quartiles for numeric columns."""
    parts = []
    for name, fam in cols:
        c = qi(name)
        parts.append(f"count(DISTINCT {c}) AS {qi('d:' + name)}")
        if fam == "number":
            parts.append(
                f"quantile_cont({c}, [0.25, 0.5, 0.75]) AS {qi('q:' + name)}")
    return await _one(session, f"SELECT {', '.join(parts)} FROM {qi(rel)}")


def _as_number(name, fam):
    """SQL giving a column as a DOUBLE, so dates bin like numbers."""
    c = qi(name)
    return f"epoch({c})" if fam == "temporal" else f"CAST({c} AS DOUBLE)"


async def _histogram(session, rel, name, fam, lo, hi):
    """Equal-width bins over [lo, hi]. Dates bin on epoch seconds."""
    x = _as_number(name, fam)
    bounds = await _one(session, f"SELECT min({x}) AS lo, max({x}) AS hi "
                                 f"FROM {qi(rel)}")
    a, b = bounds["lo"], bounds["hi"]
    if a is None:
        return []
    if a == b:
        n = (await _one(session, f"SELECT count({qi(name)}) AS n "
                                 f"FROM {qi(rel)}"))["n"]
        return [{"lo": lo, "hi": hi, "count": n}]
    width = (b - a) / HIST_BINS
    res = await session.run(
        f"SELECT least(CAST(floor(({x} - ?) / ?) AS INTEGER), ?) AS bin, "
        f"count(*) AS n FROM {qi(rel)} WHERE {qi(name)} IS NOT NULL "
        f"GROUP BY 1", [a, width, HIST_BINS - 1])
    counts = {r[0]: r[1] for r in res.rows}
    bins = []
    for i in range(HIST_BINS):
        blo, bhi = a + i * width, a + (i + 1) * width
        bins.append({"lo": blo, "hi": bhi, "count": counts.get(i, 0)})
    # The outer edges are the real extremes, in the column's own terms.
    bins[0]["lo"], bins[-1]["hi"] = lo, hi
    if fam == "number":
        for b_ in bins[1:-1]:
            b_["lo"], b_["hi"] = _num(b_["lo"]), _num(b_["hi"])
        bins[0]["hi"], bins[-1]["lo"] = _num(bins[0]["hi"]), _num(bins[-1]["lo"])
    return bins


async def _top(session, rel, name):
    res = await session.run(
        f"SELECT {qi(name)} AS value, count(*) AS n FROM {qi(rel)} "
        f"WHERE {qi(name)} IS NOT NULL GROUP BY 1 "
        f"ORDER BY n DESC, 1 LIMIT {TOP_VALUES}")
    return [{"value": r[0], "count": r[1]} for r in res.rows]


async def _rarest(session, rel, name):
    """How many categories appear at most RARE_COUNT times."""
    return (await _one(session,
        f"SELECT count(*) AS rare FROM (SELECT count(*) AS n FROM {qi(rel)} "
        f"WHERE {qi(name)} IS NOT NULL GROUP BY {qi(name)}) "
        f"WHERE n <= ?", [RARE_COUNT]))["rare"]


async def _repeats(session, rel, name):
    return (await _one(session,
        f"SELECT count(*) - count(DISTINCT {qi(name)}) AS extra "
        f"FROM {qi(rel)} WHERE {qi(name)} IS NOT NULL"))["extra"]


def _pct(x):
    return round(float(x), 2)


async def profile(session, rel, schema, *, rejected=0, job=None):
    """-> the profile dict. `schema` is {column: type}, already validated."""
    if job:
        job.set_progress("summarising columns")
    summary = await _summary(session, rel)
    fams = [(name, type_family(t)) for name, t in schema.items()]
    # Row count and every column's non-null count in one scan.
    counts = await _one(session, "SELECT count(*) AS \"*\", " + ", ".join(
        f"count({qi(n)}) AS {qi('n:' + n)}" for n, _ in fams) + f" FROM {qi(rel)}")
    rows = counts["*"]
    exact = rows <= EXACT_LIMIT
    stats = await _exact_stats(session, rel, fams) if exact and fams else {}

    columns, leads = [], []
    for i, (name, fam) in enumerate(fams, 1):
        if job:
            job.set_progress(f"profiling {name} ({i} of {len(fams)})")
        s = summary[name]
        non_null = counts[f"n:{name}"]
        null_pct = _pct(100 * (rows - non_null) / rows) if rows else 0.0
        distinct = stats.get(f"d:{name}") if exact else s["approx_unique"]
        col = {
            "name": name, "type": schema[name], "family": fam,
            "non_null": non_null, "null_pct": null_pct,
            "distinct": distinct, "distinct_approx": not exact,
            "min": None, "max": None, "q1": None, "median": None, "q3": None,
            "mean": None, "quartiles_approx": False,
            "histogram": None, "top": None,
        }
        if fam == "number":
            col["min"], col["max"] = _num(s["min"]), _num(s["max"])
            col["mean"] = _num(s["avg"])
            if exact:
                q = stats.get(f"q:{name}") or [None, None, None]
            else:
                q = [s["q25"], s["q50"], s["q75"]]
                col["quartiles_approx"] = True
            col["q1"], col["median"], col["q3"] = (_num(v) for v in q)
        elif fam == "temporal":
            col["min"], col["max"] = s["min"], s["max"]
        if fam in ("number", "temporal") and non_null:
            col["histogram"] = await _histogram(
                session, rel, name, fam, col["min"], col["max"])
        if fam == "text" and non_null and (distinct or 0) <= TOP_DISTINCT_LIMIT:
            col["top"] = await _top(session, rel, name)
        columns.append(col)
        leads += await _leads_for(session, rel, col, rows)

    return {"relation": rel, "rows": rows, "rejected": rejected,
            "approx": not exact, "columns": columns, "leads": leads}


async def _leads_for(session, rel, col, rows):
    name, out = col["name"], []
    if col["null_pct"] >= MISSING_PCT:
        out.append({
            "column": name, "check": "missing",
            "summary": f"{col['null_pct']:g}% of rows are blank in {name}"})
    nn = col["non_null"]
    if nn and col["family"] == "text" and col["distinct"] is not None \
            and col["distinct"] >= KEY_UNIQUE_RATIO * nn:
        extra = await _repeats(session, rel, name)
        if extra:
            out.append({
                "column": name, "check": "duplicates",
                "summary": f"{name} is almost unique, but {extra:,} "
                           f"value{'s repeat' if extra != 1 else ' repeats'}"})
    if col["family"] == "number" and None not in (col["q1"], col["q3"]):
        iqr = col["q3"] - col["q1"]
        hi, lo = col["q3"] + EXTREME_IQR * iqr, col["q1"] - EXTREME_IQR * iqr
        if iqr > 0 and (col["max"] > hi or col["min"] < lo):
            out.append({
                "column": name, "check": "extremes",
                "summary": f"{name} reaches {fmt(col['max'] if col['max'] > hi else col['min'])}, "
                           f"far past its middle half ({fmt(col['q1'])}–{fmt(col['q3'])})"})
    if col["family"] == "text" and col["distinct"] \
            and 1 < col["distinct"] <= RARE_MAX_DISTINCT \
            and col["distinct"] < KEY_UNIQUE_RATIO * nn:
        rare = await _rarest(session, rel, name)
        if rare:
            out.append({
                "column": name, "check": "rare",
                "summary": f"{rare:,} value{'s' if rare != 1 else ''} of {name} "
                           f"appear{'' if rare != 1 else 's'} {RARE_COUNT} times or fewer"})
    return out
