"""Turning UI state into SQL, safely.

Column and table names cannot be SQL-parameterised, so every identifier that
reaches a query is checked against the relation's live schema before it is
quoted. That check is the injection guard, not a nicety -- `qi()` alone only
stops a stray quote character, it does not stop an attacker choosing which
column to read.

One deliberate departure from v3, the Streamlit predecessor: it interpolated
filter values for non-VARCHAR columns raw, unquoted (`{col} {op} {raw}`), so typing
`0 OR 1=1` into a numeric filter injected SQL. On a single-user laptop that was
harmless. On a shared server it is not, so every value goes through `lit()` and
DuckDB casts it.
"""

import re
from pathlib import Path

# Operators the filter compiler will emit. Anything not in here is rejected
# rather than passed through.
BINARY_OPS = {"=", "!=", "<>", ">", ">=", "<", "<="}
LIST_OPS = {"IN", "NOT IN"}
NULL_OPS = {"IS NULL", "IS NOT NULL"}
TEXT_OPS = {"ILIKE", "NOT ILIKE", "LIKE", "STARTS WITH", "CONTAINS"}
RANGE_OPS = {"BETWEEN", "NOT BETWEEN"}
ALL_OPS = BINARY_OPS | LIST_OPS | NULL_OPS | TEXT_OPS | RANGE_OPS

AGGREGATES = {"sum", "count", "avg", "min", "max", "median",
              "count_distinct", "stddev"}


class SqlError(ValueError):
    """Bad input from the client -- surfaces as a 400, not a 500."""


def slug(text):
    """Turn a filename or label into a safe, stable SQL identifier.

    'Monthly Export 2026-08.csv' -> 'monthly_export_2026_08'. Deterministic, so
    reloading the same file targets the same view and parquet file instead of
    quietly creating a second copy under a different name.
    """
    s = re.sub(r"[^0-9a-zA-Z]+", "_", Path(text).stem).strip("_").lower()
    s = re.sub(r"_+", "_", s)
    return ("s_" + s) if (not s or s[0].isdigit()) else s


def lit(v):
    """Render a Python value as a SQL literal, escaping single quotes."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def qi(name):
    """Quote an identifier. Only safe on a name already checked against a
    schema -- see `column()`."""
    return '"' + str(name).replace('"', '""') + '"'


def relation(name, known):
    if name not in known:
        raise SqlError(f"unknown relation: {name!r}")
    return qi(name)


def column(name, schema):
    """`schema` is {column_name: type}. Membership is the guard."""
    if name not in schema:
        raise SqlError(f"unknown column: {name!r}")
    return qi(name)


# ----------------------------------------------------------------------
# Filters
# ----------------------------------------------------------------------
def compile_filter(node, schema):
    """Compile a filter node to a SQL boolean expression, or '' if empty.

    A node is either a group:
        {"kind": "group", "combiner": "AND"|"OR", "children": [...],
         "negate": false}
    or a condition:
        {"kind": "cond", "column": str, "op": str, "value": ...}

    M1's UI only produces one flat group. The recursion is here so M3's nested
    groups need no change on the backend.
    """
    if not node:
        return ""
    kind = node.get("kind", "cond")

    if kind == "group":
        parts = [compile_filter(c, schema) for c in node.get("children", [])]
        parts = [p for p in parts if p]
        if not parts:
            return ""
        combiner = str(node.get("combiner", "AND")).upper()
        if combiner not in ("AND", "OR"):
            raise SqlError(f"bad combiner: {combiner!r}")
        joined = f" {combiner} ".join(parts)
        expr = f"({joined})" if len(parts) > 1 else parts[0]
        return f"NOT {expr}" if node.get("negate") else expr

    if kind != "cond":
        raise SqlError(f"bad filter node kind: {kind!r}")

    op = str(node.get("op", "")).upper().strip()
    if op not in ALL_OPS:
        raise SqlError(f"unsupported operator: {op!r}")
    col = column(node.get("column"), schema)
    val = node.get("value")

    if op in NULL_OPS:
        return f"{col} {op}"

    if op in LIST_OPS:
        if not isinstance(val, (list, tuple)) or not val:
            return ""  # an empty pick is not a filter
        return f"{col} {op} ({', '.join(lit(v) for v in val)})"

    if op in RANGE_OPS:
        if not isinstance(val, (list, tuple)) or len(val) != 2:
            raise SqlError(f"{op} needs two values")
        lo, hi = val
        if lo in (None, "") or hi in (None, ""):
            return ""
        return f"{col} {op} {lit(lo)} AND {lit(hi)}"

    if val in (None, ""):
        return ""

    if op == "CONTAINS":
        return f"{col} ILIKE {lit('%' + str(val) + '%')}"
    if op == "STARTS WITH":
        return f"{col} ILIKE {lit(str(val) + '%')}"
    if op in ("ILIKE", "NOT ILIKE", "LIKE"):
        # v3 wrapped every ILIKE in %...%; keep that, it is what analysts
        # expect from a search box.
        pattern = str(val)
        if "%" not in pattern and "_" not in pattern:
            pattern = f"%{pattern}%"
        return f"{col} {op} {lit(pattern)}"

    return f"{col} {op} {lit(val)}"


# ----------------------------------------------------------------------
# Statement builders
# ----------------------------------------------------------------------
def select_list(columns, schema):
    if not columns:
        return "*"
    return ", ".join(column(c, schema) for c in columns)


def order_clause(sort, schema, desc=False):
    if not sort:
        return ""
    return f" ORDER BY {column(sort, schema)}{' DESC' if desc else ''}"


def build_slice(rel, schema, *, columns=None, filters=None,
                sort=None, desc=False):
    where = compile_filter(filters, schema)
    return (f"SELECT {select_list(columns, schema)} FROM {qi(rel)}"
            f"{f' WHERE {where}' if where else ''}"
            f"{order_clause(sort, schema, desc)}")


def build_pivot(rel, schema, *, rows, value, agg, column_field=None,
                filters=None):
    if not rows:
        raise SqlError("a pivot needs at least one row field")
    agg = str(agg).lower()
    if agg not in AGGREGATES:
        raise SqlError(f"unsupported aggregate: {agg!r}")
    grp = ", ".join(column(r, schema) for r in rows)
    val = column(value, schema)
    where = compile_filter(filters, schema)
    filt = f" WHERE {where}" if where else ""
    expr = f"count(DISTINCT {val})" if agg == "count_distinct" else f"{agg}({val})"

    if not column_field:
        alias = qi(f"{agg}_{value}")
        return (f"SELECT {grp}, {expr} AS {alias} FROM {qi(rel)}{filt} "
                f"GROUP BY {grp} ORDER BY {grp}")
    return (f"WITH s AS (SELECT * FROM {qi(rel)}{filt}) "
            f"PIVOT s ON {column(column_field, schema)} USING {expr} "
            f"GROUP BY {grp} ORDER BY {grp}")


def build_frequencies(rel, schema, col):
    c = column(col, schema)
    return (f"SELECT {c} AS value, count(*) AS rows FROM {qi(rel)} "
            f"GROUP BY 1 ORDER BY rows DESC, value NULLS LAST")


# The newlines matter. Hand-written SQL may end in a `--` line comment, which
# would otherwise swallow the closing paren and make the wrapper unparseable.
def wrap_count(sql):
    return "SELECT count(*) FROM (\n" + sql + "\n) t"


def wrap_page(sql, limit, offset):
    return ("SELECT * FROM (\n" + sql + "\n) t "
            f"LIMIT {int(limit)} OFFSET {int(offset)}")


# ----------------------------------------------------------------------
# Joins
# ----------------------------------------------------------------------
JOIN_TYPES = {"inner": "INNER JOIN", "left": "LEFT JOIN",
              "full": "FULL OUTER JOIN", "anti": "ANTI JOIN"}
MAX_JOIN_INPUTS = 4
ALIAS_RE = re.compile(r"^[a-z][a-z0-9_]{0,15}$")

_TEXT = {"VARCHAR", "TEXT", "STRING", "CHAR", "BPCHAR"}
_NUMBER = {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT",
           "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT", "DECIMAL",
           "NUMERIC", "FLOAT", "REAL", "DOUBLE"}


def type_family(t):
    """Group DuckDB types that compare without changing a value.

    Joining across families makes DuckDB cast implicitly, and the dangerous
    case is exactly the common one: an ID forced to text at load ('000123')
    joined to a numeric copy of the same ID (123). A type outside the known
    families only joins to its own exact type.
    """
    base = str(t).upper().split("(")[0].strip()
    if base in _TEXT:
        return "text"
    if base in _NUMBER:
        return "number"
    if base.startswith(("DATE", "TIMESTAMP", "TIME")):
        return "temporal"
    if base in ("BOOLEAN", "BOOL"):
        return "boolean"
    return base


class JoinPlan:
    """A validated join: everything build_join and the key probe need.

    `steps` holds one dict per join: the alias and relation on each side, the
    join type and the key pairs. `outputs` is (alias, column, output_name).
    `schema` maps output name -> type, so the ordinary filter compiler runs
    over the joined result unchanged.
    """

    def __init__(self, aliases, steps, outputs, schema):
        self.aliases = aliases          # alias -> relation, in input order
        self.steps = steps
        self.outputs = outputs
        self.schema = schema

    @property
    def inputs(self):
        """Distinct relation names, in first-use order, for lineage."""
        return list(dict.fromkeys(self.aliases.values()))

    @property
    def base(self):
        return next(iter(self.aliases.values()))


def _join_keys(join, alias, schema, left_alias, left_schema):
    pairs = join.get("on") or []
    if not pairs:
        raise SqlError(f"joining {alias!r} needs at least one key pair")
    keys = []
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise SqlError("each key pair is [left column, right column]")
        lc, rc = pair
        column(lc, left_schema)
        column(rc, schema)
        lt, rt = left_schema[lc], schema[rc]
        if type_family(lt) != type_family(rt):
            raise SqlError(
                f"cannot join {left_alias}.{lc} ({lt}) to {alias}.{rc} ({rt}): "
                "The engine would convert one to the other, and an ID like "
                "'000123' would become 123. Reload both sides with this "
                "column forced to text so the values compare exactly.")
        keys.append((lc, rc))
    return keys


def plan_join(spec, schemas):
    """Validate a join spec against live schemas. Raises SqlError.

    `schemas` maps every relation the spec may name to {column: type}; a
    relation missing from it is unknown. Nothing here reaches DuckDB.
    """
    inputs = (spec or {}).get("inputs") or []
    if len(inputs) < 2:
        raise SqlError("a join needs at least two inputs")
    if len(inputs) > MAX_JOIN_INPUTS:
        raise SqlError(f"a join takes at most {MAX_JOIN_INPUTS} inputs")

    aliases, anti, steps, selected = {}, set(), [], []
    for i, inp in enumerate(inputs):
        rel = inp.get("relation")
        if rel not in schemas:
            raise SqlError(f"unknown relation: {rel!r}")
        alias = str(inp.get("alias") or "")
        if not ALIAS_RE.match(alias):
            raise SqlError(f"alias {alias!r} must be lowercase letters, digits "
                           "and _, start with a letter, and be at most 16 "
                           "characters")
        if alias in aliases:
            raise SqlError(f"alias {alias!r} is used twice")
        schema = schemas[rel]
        cols = inp.get("columns") or []
        for c in cols:
            column(c, schema)

        join = inp.get("join")
        if i == 0 and join:
            raise SqlError("the first input is the base and cannot itself be "
                           "joined")
        if i > 0:
            if not join:
                raise SqlError(f"input {alias!r} needs a join")
            kind = str(join.get("type", "")).lower()
            if kind not in JOIN_TYPES:
                raise SqlError(f"unsupported join type: {kind!r}")
            other = join.get("with")
            if other not in aliases:
                raise SqlError(f"{alias!r} must join onto an earlier input; "
                               f"{other!r} is not one")
            if other in anti:
                raise SqlError(f"{other!r} was anti-joined, so its columns are "
                               "not available to join onto")
            keys = _join_keys(join, alias, schema, other,
                              schemas[aliases[other]])
            if kind == "anti":
                if cols:
                    raise SqlError(f"an anti join keeps only rows with no "
                                   f"match, so {alias!r} contributes no "
                                   "columns")
                anti.add(alias)
            steps.append({"left_alias": other, "left_relation": aliases[other],
                          "right_alias": alias, "right_relation": rel,
                          "type": kind, "keys": keys})
        aliases[alias] = rel
        if alias not in anti:
            selected.extend((alias, c) for c in (cols or list(schema)))

    # Prefix only names selected from more than one input (decided
    # 2026-09-21). A prefixed name can still collide with a real column.
    counts = {}
    for _, c in selected:
        counts[c] = counts.get(c, 0) + 1
    outputs, out_schema = [], {}
    for alias, c in selected:
        name = c if counts[c] == 1 else f"{alias}_{c}"
        if name in out_schema:
            raise SqlError(f"output column {name!r} appears twice; choose a "
                           "different alias")
        out_schema[name] = schemas[aliases[alias]][c]
        outputs.append((alias, c, name))
    if not outputs:
        raise SqlError("the join selects no columns")
    return JoinPlan(aliases, steps, outputs, out_schema)


def build_join(plan, *, filters=None, sort=None, desc=False):
    """The joined SELECT, with filters and sort over the output names."""
    select = ", ".join(f"{qi(a)}.{qi(c)} AS {qi(n)}"
                       for a, c, n in plan.outputs)
    base_alias, base_rel = next(iter(plan.aliases.items()))
    sql = f"SELECT {select} FROM {qi(base_rel)} AS {qi(base_alias)}"
    for s in plan.steps:
        on = " AND ".join(
            f"{qi(s['left_alias'])}.{qi(lc)} = {qi(s['right_alias'])}.{qi(rc)}"
            for lc, rc in s["keys"])
        sql += (f" {JOIN_TYPES[s['type']]} {qi(s['right_relation'])} "
                f"AS {qi(s['right_alias'])} ON {on}")
    where = compile_filter(filters, plan.schema)
    order = order_clause(sort, plan.schema, desc)
    if not where and not order:
        return sql
    return (f"SELECT * FROM ({sql}) j"
            f"{f' WHERE {where}' if where else ''}{order}")


def build_join_probe(step):
    """One statement measuring a join step's keys, exactly.

    The planner cannot be asked: it under-predicts fan-out by orders of
    magnitude (see gateway). Grouping each side by its key and joining the
    groups gives the true output size at the cost of one scan per side, and
    `pairs` stays HUGEINT because a bad key can exceed BIGINT.
    """
    n = len(step["keys"])
    ks = [f"k{i}" for i in range(n)]
    lsel = ", ".join(f"{qi(lc)} AS k{i}"
                     for i, (lc, _) in enumerate(step["keys"]))
    rsel = ", ".join(f"{qi(rc)} AS k{i}"
                     for i, (_, rc) in enumerate(step["keys"]))
    present = " AND ".join(f"{k} IS NOT NULL" for k in ks)
    missing = " OR ".join(f"{k} IS NULL" for k in ks)
    match = " AND ".join(f"lg.{k} = rg.{k}" for k in ks)
    keys = ", ".join(ks)
    return (
        f"WITH l AS (SELECT {lsel} FROM {qi(step['left_relation'])}), "
        f"r AS (SELECT {rsel} FROM {qi(step['right_relation'])}), "
        f"lg AS (SELECT {keys}, count(*) AS n FROM l WHERE {present} "
        f"GROUP BY {keys}), "
        f"rg AS (SELECT {keys}, count(*) AS n FROM r WHERE {present} "
        f"GROUP BY {keys}), "
        f"m AS (SELECT lg.n AS ln, rg.n AS rn FROM lg JOIN rg ON {match}) "
        "SELECT (SELECT count(*) FROM l) AS left_rows, "
        "(SELECT count(*) FROM r) AS right_rows, "
        "(SELECT count(*) FROM lg) AS left_distinct, "
        "(SELECT count(*) FROM rg) AS right_distinct, "
        f"(SELECT count(*) FROM l WHERE {missing}) AS left_nulls, "
        f"(SELECT count(*) FROM r WHERE {missing}) AS right_nulls, "
        "(SELECT coalesce(max(n), 0) FROM rg) AS right_max_dup, "
        "(SELECT coalesce(sum(ln), 0) FROM m) AS matched_left, "
        "(SELECT coalesce(sum(rn), 0) FROM m) AS matched_right, "
        "(SELECT coalesce(max(rn), 0) FROM m) AS max_fanout, "
        "(SELECT coalesce(sum(ln::HUGEINT * rn), 0) FROM m) AS pairs")


# ----------------------------------------------------------------------
# Preview
# ----------------------------------------------------------------------
PREVIEW_KINDS = {"head", "sample"}


def build_preview(rel, kind, *, size, seed=1, parquet_path=None):
    """A look at some rows, keyed by each row's stored position.

    A source is read from its Parquet file with file_row_number; a saved
    table orders by rowid. "head" is the first rows *as stored* -- the load
    does not keep the CSV's order, so this is never called the start of the
    file. "sample" orders by hash(position, seed): the same seed returns the
    same rows whatever the thread count, a new seed new ones, and the result
    is exactly `size` rows (or all of them, when there are fewer).
    """
    if kind not in PREVIEW_KINDS:
        raise SqlError(f"unknown preview: {kind!r}")
    if parquet_path:
        src = (f"read_parquet({lit(Path(parquet_path).as_posix())}, "
               "file_row_number = true)")
        cols, key = "* EXCLUDE (file_row_number)", "file_row_number"
    else:
        src, cols, key = qi(rel), "*", "rowid"
    order = key if kind == "head" else f"hash({key}, {int(seed)})"
    return f"SELECT {cols} FROM {src} ORDER BY {order} LIMIT {int(size)}"


# ----------------------------------------------------------------------
# Outlier checks a slice filter cannot express
# ----------------------------------------------------------------------
CHECKS = {"duplicates", "mostly_blank"}
MOSTLY_BLANK = 0.5


def build_check(rel, schema, check, *, column_name=None):
    """Rows behind an Outliers finding, when no slice filter can say it.

    duplicates   -- rows whose value in `column_name` appears more than once
    mostly_blank -- rows blank in at least half of their columns
    Identifiers are checked against the schema like every other builder.
    """
    if check not in CHECKS:
        raise SqlError(f"unknown check: {check!r}")
    if check == "duplicates":
        c = column(column_name, schema)
        return (f"SELECT * FROM {qi(rel)} WHERE {c} IN ("
                f"SELECT {c} FROM {qi(rel)} WHERE {c} IS NOT NULL "
                f"GROUP BY 1 HAVING count(*) > 1) ORDER BY {c}")
    blanks = " + ".join(f"({qi(n)} IS NULL)::INTEGER" for n in schema)
    return (f"SELECT * FROM {qi(rel)} WHERE ({blanks}) >= "
            f"{MOSTLY_BLANK * len(schema)}")
