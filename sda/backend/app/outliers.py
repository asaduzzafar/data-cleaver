"""The Outliers step: what does not fit, as an exceptions list.

Four checks, each returning findings with a count and a `show` query -- the
exact rows the count describes, as an ordinary query request. The rule every
finding obeys: its count equals the rows its `show` returns. A finding that
says 3 and opens 4 would be worse than none, so each count is computed from
the very predicate the show query uses.

Like the profile, the checks read the data, never column names: a key is a
column that behaves like one (nearly every value distinct), not one whose
name ends in "_id".
"""

from .profile import _histogram, fmt
from .sqlgen import MOSTLY_BLANK, qi, type_family

KEY_UNIQUE_RATIO = 0.95      # distinct/non-null at or above this: behaves like a key
RARE_MAX_DISTINCT = 1_000    # past this many categories, "rare" stops meaning much
RARE_LIST_LIMIT = 200        # values one finding opens (it says when there are more)
# MOSTLY_BLANK comes from sqlgen: the count and the rows it opens must agree.


async def _one(session, sql, params=None):
    return (await session.run(sql, params)).one()


def _num(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


async def _column_facts(session, rel, fams):
    """Non-null and exact distinct counts for every column, in one scan."""
    parts = ["count(*) AS \"*\""]
    for name, _ in fams:
        parts.append(f"count({qi(name)}) AS {qi('n:' + name)}")
        parts.append(f"count(DISTINCT {qi(name)}) AS {qi('d:' + name)}")
    return await _one(session, f"SELECT {', '.join(parts)} FROM {qi(rel)}")


async def _extremes(session, rel, fams, k):
    out = []
    for name, fam in fams:
        if fam != "number":
            continue
        c = qi(name)
        q = await _one(session, f"SELECT quantile_cont({c}, 0.25) AS q1, "
                                f"quantile_cont({c}, 0.75) AS q3 FROM {qi(rel)}")
        if q["q1"] is None:
            continue
        q1, q3 = float(q["q1"]), float(q["q3"])
        iqr = q3 - q1
        if iqr <= 0:
            continue    # no spread in the middle half: fences say nothing
        low, high = q1 - k * iqr, q3 + k * iqr
        n = await _one(session,
            f"SELECT count(*) FILTER ({c} < ?) AS below, "
            f"count(*) FILTER ({c} > ?) AS above FROM {qi(rel)}", [low, high])
        if not (n["below"] or n["above"]):
            continue
        bounds = await _one(session, f"SELECT min({c}) AS lo, max({c}) AS hi "
                                     f"FROM {qi(rel)}")
        out.append({
            "column": name, "count": n["below"] + n["above"],
            "below": n["below"], "above": n["above"],
            "q1": _num(q1), "q3": _num(q3), "k": k,
            "low": low, "high": high,
            # The distribution the fences are drawn on, as in the profile.
            "histogram": await _histogram(session, rel, name, "number",
                                          _num(bounds["lo"]), _num(bounds["hi"])),
            "summary": (f"{n['below'] + n['above']:,} value(s) of {name} "
                        f"outside {fmt(low)} to {fmt(high)} "
                        f"({k:g}× the middle half past its edges)"),
            "show": {"mode": "slice", "relation": rel, "filters": {
                "kind": "group", "combiner": "OR", "children": [
                    {"kind": "cond", "column": name, "op": "<", "value": low},
                    {"kind": "cond", "column": name, "op": ">", "value": high},
                ]}},
        })
    return out


async def _rare(session, rel, fams, facts, n):
    out = []
    for name, fam in fams:
        if fam != "text":
            continue
        nn, distinct = facts[f"n:{name}"], facts[f"d:{name}"]
        if not nn or not 1 < distinct <= RARE_MAX_DISTINCT \
                or distinct >= KEY_UNIQUE_RATIO * nn:
            continue
        res = await session.run(
            f"SELECT {qi(name)} AS value, count(*) AS n FROM {qi(rel)} "
            f"WHERE {qi(name)} IS NOT NULL GROUP BY 1 HAVING count(*) <= ? "
            f"ORDER BY n, 1", [n])
        values = [{"value": r[0], "count": r[1]} for r in res.rows]
        if not values:
            continue
        shown = values[:RARE_LIST_LIMIT]
        rows = sum(v["count"] for v in shown)
        more = len(values) - len(shown)
        out.append({
            "column": name, "count": rows, "values": shown,
            "total_values": len(values),
            "summary": (f"{len(values):,} value(s) of {name} seen {n} times "
                        f"or fewer" + (f"; showing the {len(shown)} rarest"
                                       if more else "")),
            "show": {"mode": "slice", "relation": rel, "filters": {
                "kind": "cond", "column": name, "op": "IN",
                "value": [v["value"] for v in shown]}},
        })
    return out


async def _missing(session, rel, fams, facts):
    total = facts["*"]
    columns = []
    for name, _ in fams:
        blank = total - facts[f"n:{name}"]
        if not blank:
            continue
        columns.append({
            "column": name, "count": blank,
            "pct": round(100 * blank / total, 2) if total else 0.0,
            "summary": f"{blank:,} blank value(s) in {name}",
            "show": {"mode": "slice", "relation": rel, "filters": {
                "kind": "cond", "column": name, "op": "IS NULL"}},
        })
    columns.sort(key=lambda c: -c["count"])
    mostly = 0
    if fams:
        blanks = " + ".join(f"({qi(n)} IS NULL)::INTEGER" for n, _ in fams)
        mostly = (await _one(session,
            f"SELECT count(*) AS n FROM {qi(rel)} "
            f"WHERE ({blanks}) >= ?", [MOSTLY_BLANK * len(fams)]))["n"]
    return {"columns": columns, "mostly_blank": {
        "column": None, "count": mostly,
        "summary": (f"{mostly:,} row(s) blank in at least "
                    f"{int(MOSTLY_BLANK * 100)}% of their columns"),
        "show": {"mode": "check", "relation": rel, "check": "mostly_blank"}}}


async def _duplicates(session, rel, fams, facts):
    out = []
    for name, fam in fams:
        if fam not in ("text", "number"):
            continue
        nn, distinct = facts[f"n:{name}"], facts[f"d:{name}"]
        if not nn or distinct < KEY_UNIQUE_RATIO * nn or distinct == nn:
            continue
        c = qi(name)
        d = await _one(session,
            f"SELECT count(*) AS values, sum(n) AS rows, "
            f"arg_max({c}, n) AS worst, max(n) AS worst_n FROM ("
            f"SELECT {c}, count(*) AS n FROM {qi(rel)} WHERE {c} IS NOT NULL "
            f"GROUP BY 1 HAVING count(*) > 1)")
        out.append({
            "column": name, "count": int(d["rows"]), "values": d["values"],
            "worst": {"value": d["worst"], "count": d["worst_n"]},
            "summary": (f"{d['values']:,} value(s) of {name} repeat, across "
                        f"{int(d['rows']):,} rows; {d['worst']!s} appears "
                        f"{d['worst_n']} times"),
            "show": {"mode": "check", "relation": rel, "check": "duplicates",
                     "column": name},
        })
    return out


async def check(session, rel, schema, *, k=1.5, n=5, job=None):
    """-> {"extremes", "rare", "missing", "duplicates"}. `schema` validated."""
    fams = [(name, type_family(t)) for name, t in schema.items()]
    if job:
        job.set_progress("counting values")
    facts = await _column_facts(session, rel, fams)
    if job:
        job.set_progress("numeric extremes")
    extremes = await _extremes(session, rel, fams, k)
    if job:
        job.set_progress("rare categories")
    rare = await _rare(session, rel, fams, facts, n)
    if job:
        job.set_progress("missing and blank")
    missing = await _missing(session, rel, fams, facts)
    if job:
        job.set_progress("duplicate keys")
    duplicates = await _duplicates(session, rel, fams, facts)
    return {"relation": rel, "rows": facts["*"], "k": k, "n": n,
            "extremes": extremes, "rare": rare, "missing": missing,
            "duplicates": duplicates}

