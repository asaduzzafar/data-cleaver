"""Joins: resolving a spec against the catalog, and probing its keys.

The probe is the reason joins get their own module. A join whose right-hand
key is not unique multiplies left rows, raises nothing, and produces a result
that looks exactly as trustworthy as a correct one. The planner's estimate is
no help (the gateway docstring has the measurement), so the probe counts the
real key groups instead and turns what it finds into ordinary gateway
findings: a fan-out is a cost block the analyst may confirm, never a silent
default.
"""

from . import catalog, gateway, sqlgen
from .gateway import Finding, Review, _fmt


async def resolve(engine, spec):
    """-> JoinPlan, checked against live schemas. Raises SqlError."""
    names = {i.get("relation") for i in (spec or {}).get("inputs") or []}
    known = await catalog.known_names(engine)
    schemas = {n: await catalog.schema_of(engine, n, known)
               for n in names if n in known}
    return sqlgen.plan_join(spec, schemas)


def _measure(step, row):
    """Add the derived numbers to one step's raw probe counts."""
    row = {k: int(v or 0) for k, v in row.items()}
    unmatched_left = row["left_rows"] - row["matched_left"]
    unmatched_right = row["right_rows"] - row["matched_right"]
    estimated = {
        "inner": row["pairs"],
        "left": row["pairs"] + unmatched_left,
        "full": row["pairs"] + unmatched_left + unmatched_right,
        "anti": unmatched_left,
    }[step["type"]]
    return {
        "left": step["left_alias"], "right": step["right_alias"],
        "left_relation": step["left_relation"],
        "right_relation": step["right_relation"],
        "type": step["type"],
        "keys": [list(k) for k in step["keys"]],
        **{k: v for k, v in row.items() if k != "right_max_dup"},
        "right_unique": row["right_max_dup"] <= 1,
        "estimated_rows": estimated,
    }


def _findings(s):
    out = []
    # Say relations, not the aliases the SQL uses: "s" and "sa" mean nothing
    # to the reader. A self-join keeps its aliases to tell the sides apart.
    left, right = s["left_relation"], s["right_relation"]
    if left == right:
        left, right = f"{left} ({s['left']})", f"{right} ({s['right']})"
    # Left rows are multiplied only when a *matched* key repeats on the right.
    # A non-unique right key that matches nothing multiplies nothing.
    if s["type"] != "anti" and s["pairs"] > s["matched_left"]:
        out.append(Finding(
            rule="fanout",
            severity="block",
            title=f"{right} matches some {left} rows more than once",
            detail=(f"The key is not unique in {s['right_relation']}: one "
                    f"key matches up to {_fmt(s['max_fanout'])} rows, so "
                    f"{_fmt(s['matched_left'])} matched {left} rows become "
                    f"{_fmt(s['pairs'])}. Expect about "
                    f"{_fmt(s['estimated_rows'])} rows in total. Sums over "
                    f"{left} columns will be inflated by the duplicates."),
            suggestions=[
                "Add another key column so each match is unique",
                f"Save a slice of {s['right_relation']} with one row per key, "
                "and join to that",
                "Confirm and run anyway if one row per match is what you "
                "want",
            ]))
    if s["matched_left"] == 0 and s["left_rows"] > s["left_nulls"]:
        out.append(Finding(
            rule="no_matches",
            severity="warn",
            title=f"No {left} row matches {right}",
            detail=("Every key compared unequal. That is usually the wrong "
                    "key column, or the same ID written two ways: leading "
                    "zeros, padding, or different case."),
            suggestions=["Compare a few key values from each side in the "
                         "Profile step before running"]))
    if s["left_nulls"] or s["right_nulls"]:
        out.append(Finding(
            rule="null_keys",
            severity="warn",
            title="Some keys are empty and will never match",
            detail=(f"{_fmt(s['left_nulls'])} {left} rows and "
                    f"{_fmt(s['right_nulls'])} {right} rows have an empty "
                    "key. An empty key matches nothing, including another "
                    "empty key."
                    + (" In an anti join they are all kept."
                       if s["type"] == "anti" else "")),
            suggestions=[]))
    if (s["type"] == "inner" and 0 < s["matched_left"]
            and s["matched_left"] * 2 < s["left_rows"]):
        out.append(Finding(
            rule="low_match_rate",
            severity="warn",
            title=(f"Only {_fmt(s['matched_left'])} of "
                   f"{_fmt(s['left_rows'])} {left} rows match"),
            detail=("An inner join drops every row without a match, so most "
                    f"of {left} is missing from the result."),
            suggestions=["Use a left join to keep unmatched rows"]))
    return out


async def probe(session, plan, job=None):
    """Measure every step. -> {"steps": [...], "review": Review}."""
    steps, findings = [], []
    for i, step in enumerate(plan.steps, 1):
        if job is not None:
            job.set_progress(f"checking join keys ({i} of {len(plan.steps)})")
        row = (await session.run(sqlgen.build_join_probe(step))).one()
        s = _measure(step, row)
        steps.append(s)
        findings += _findings(s)
    review = Review(gateway._verdict(findings), findings,
                    estimated_rows=max(s["estimated_rows"] for s in steps))
    return {"steps": steps, "review": review}
