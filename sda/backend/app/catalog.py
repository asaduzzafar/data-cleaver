"""Reading the registry: what relations exist, and what they were cut from.

The staleness rule is the point of the whole registry, so it lives in one
place. A slice is stale when any source it was built from has been reloaded
since the slice was cut. If the cut time is unknown the answer is "unknown",
never "fresh" -- claiming freshness we cannot demonstrate is worse than
admitting the gap.
"""

from .serial import jsonable

SOURCES_SQL = "SELECT * FROM _sources ORDER BY view_name"
SLICES_SQL = "SELECT * FROM _lineage ORDER BY table_name"


async def _dicts(engine, sql, params=None):
    res = await engine.fetch(sql, params, heavy=False)
    return [{k: jsonable(v) for k, v in d.items()} for d in res.dicts()]


async def sources(engine):
    return await _dicts(engine, SOURCES_SQL)


async def slices(engine):
    return await _dicts(engine, SLICES_SQL)


async def inputs_of(engine, table):
    rows = await _dicts(
        engine, "SELECT source FROM _lineage_inputs WHERE table_name = ? "
                "ORDER BY source", [table])
    return [r["source"] for r in rows]


async def known_names(engine):
    src = await sources(engine)
    sl = await slices(engine)
    return {r["view_name"] for r in src} | {r["table_name"] for r in sl}


async def schema_of(engine, rel, known=None):
    """{column: type} for a relation, after checking the name is one of ours.

    DESCRIBE takes an identifier that cannot be parameterised, so the name is
    validated against the registry before it is interpolated.
    """
    known = known if known is not None else await known_names(engine)
    if rel not in known:
        raise KeyError(rel)
    res = await engine.fetch(f'DESCRIBE "{rel}"', heavy=False)
    return {r[0]: r[1] for r in res.rows}


def _staleness(name, cut_at, loaded_at, inputs, seen=()):
    """-> (state, explanation). state is fresh | stale | unknown.

    Recursive, because an input may itself be a slice. A slice is stale when
    any input is stale, or was reloaded or re-cut after this one was cut:
    save is CREATE OR REPLACE, so re-saving an input swaps out the rows this
    slice was built from. Stale outranks unknown, which outranks fresh.

    `cut_at` maps slice -> created_at, `loaded_at` maps source -> loaded_at,
    and `inputs` maps slice -> its input names. Timestamps are ISO strings,
    which order correctly as text.
    """
    cut = cut_at.get(name)
    if not cut:
        return "unknown", ("Adopted or migrated without a recorded cut time, "
                           "so staleness cannot be checked.")
    ins = inputs.get(name) or []
    if not ins:
        return "unknown", ("Saved from hand-written SQL, so the relations it "
                           "read are not recorded and staleness cannot be "
                           "checked.")
    if name in seen:
        return "unknown", "The registry records a lineage cycle here."

    stale, unknown = [], []
    for src in sorted(ins):
        if src in loaded_at:
            when, verb, older = loaded_at[src], "reloaded", "extract"
            state, why = "fresh", None
        elif src in cut_at:
            when, verb, older = cut_at[src], "re-cut", "cut"
            state, why = _staleness(src, cut_at, loaded_at, inputs,
                                    (*seen, name))
        else:
            unknown.append(f"{src} no longer exists, so what it held when "
                           "this was cut cannot be checked.")
            continue
        if state == "stale":
            stale.append(f"Reads {src}, which is stale: {why}")
        elif when and when > cut:
            stale.append(f"{src} was {verb} after this was cut. Its rows come "
                         f"from the older {older}. Re-cut it before comparing "
                         "against the source.")
        elif state == "unknown" or not when:
            unknown.append(f"Reads {src}, whose freshness is unknown."
                           + (f" {why}" if why else ""))
    if stale:
        return "stale", " ".join(stale)
    if unknown:
        return "unknown", " ".join(unknown)
    return "fresh", None


async def relations(engine):
    """Every source and saved slice, with lineage and staleness resolved."""
    src = await sources(engine)
    sl = await slices(engine)
    loaded_at = {r["view_name"]: r.get("loaded_at") for r in src}
    cut_at = {r["table_name"]: r.get("created_at") for r in sl}
    inputs = {}
    for r in sl:
        ins = await inputs_of(engine, r["table_name"])
        if not ins and r.get("source"):
            # Slices saved before multi-input lineage existed, and every
            # single-parent slice, still have exactly one input.
            ins = [r["source"]]
        inputs[r["table_name"]] = ins

    out = [{
        "name": r["view_name"],
        "kind": "source",
        "rows": r.get("n_rows"),
        "loaded_at": r.get("loaded_at"),
        "loaded_by": r.get("loaded_by"),
        "csv_path": r.get("csv_path"),
        "parquet_path": r.get("parquet_path"),
        "text_cols": r.get("text_cols"),
        "base": r["view_name"],
        "inputs": [],
        "staleness": "fresh",
        "note": None,
    } for r in src]

    for r in sl:
        name = r["table_name"]
        ins = inputs[name]
        state, note = _staleness(name, cut_at, loaded_at, inputs)
        out.append({
            "name": name,
            "kind": "slice",
            "rows": r.get("n_rows"),
            "created_at": r.get("created_at"),
            "owner": r.get("owner"),
            "source": r.get("source"),
            "source_csv": r.get("source_csv"),
            "sql": r.get("sql"),
            "base": r.get("source") or name,
            "inputs": ins,
            "staleness": state,
            "note": note,
        })
    return out


def dependents(name, rels):
    """Every relation that reads `name`, directly or through a chain of
    slices. `rels` maps name -> relation, as `relations()` returns them."""
    found, todo = [], [name]
    while todo:
        cur = todo.pop()
        for r in rels.values():
            if cur in (r.get("inputs") or []) and r["name"] not in found \
                    and r["name"] != name:
                found.append(r["name"])
                todo.append(r["name"])
    return found


async def drop(engine, rel):
    """Drop one relation and its registry rows. Sources are views and slices
    are tables: DuckDB's DROP VIEW IF EXISTS raises, rather than no-ops, when
    the name is a table."""
    name = rel["name"]
    kind = "VIEW" if rel["kind"] == "source" else "TABLE"
    async with engine.session(heavy=False) as s:
        await s.run(f'DROP {kind} IF EXISTS "{name}"')
        await s.run("DELETE FROM _sources WHERE view_name = ?", [name])
        await s.run("DELETE FROM _lineage WHERE table_name = ?", [name])
        await s.run("DELETE FROM _lineage_inputs WHERE table_name = ?", [name])
