"""One gateway in front of every user-supplied statement, with two passes.

**Safety** decides what a statement may reach. **Cost** decides whether it is
worth running. They are separate because their answers differ in kind: a cost
block is "are you sure?", which an analyst who knows what they are doing may
override; a safety denial is "no", which nobody overrides from the UI.

What this is *not* is a pattern matcher for "malicious SQL". The SQL tab is an
authorised console, not an injection surface -- someone typing DROP TABLE
there is using the feature, and it is already refused. Injection means
untrusted input reaching SQL the *app* builds, which is the filter and pivot
builders, and those are guarded structurally in sqlgen: identifiers are
checked against the relation's live schema before quoting, and values go
through lit(). Scanning text for `' OR 1=1` or `--` would add nothing there
and would reject `O'Brien` and legitimate UNION ALL between two extracts.

So the safety pass closes the two holes that are actually reachable:

  1. File-reading functions. `SELECT * FROM read_csv('C:/anything')` is a
     perfectly valid SELECT, and external access cannot be disabled globally
     because every source view is itself a read_parquet(). Paths are now
     required to resolve inside the configured data or parquet directories.
  2. The registry tables. `SELECT * FROM _sources` exposes every analyst's
     file paths, and `_lineage` exposes who cut what from where. Those have
     dedicated endpoints; direct reads are denied.

The cost rules come from measurement, and they are not what intuition
suggests:

  * `SELECT * FROM big_table` is already harmless -- the app wraps every
    query for paging, DuckDB pushes that LIMIT down, and count(*) comes from
    Parquet metadata. ~0.02s on 20M rows.
  * An unbounded `ORDER BY` is harmless for the same reason: the outer LIMIT
    turns the sort into a TOP_N. 0.04s on 20M rows.
  * A cartesian product is catastrophic and the estimator sees it exactly:
    400 trillion rows for a self-cross-join of a 20M-row view.
  * A self-join on a 1,000-value key was estimated at 20M rows against a true
    ~400 billion. **The planner under-predicts join fan-out badly**, so no
    threshold on estimated rows catches it. That one is flagged structurally.
"""

import json
import os
from dataclasses import asdict, dataclass, field

# --- plan operators -----------------------------------------------------
LIMITING = {"LIMIT", "STREAMING_LIMIT", "TOP_N"}
CARTESIAN = {"CROSS_PRODUCT", "BLOCKWISE_NL_JOIN", "NESTED_LOOP_JOIN"}
JOINS = {"HASH_JOIN", "PIECEWISE_MERGE_JOIN", "IE_JOIN", "ASOF_JOIN"}
SCANS = {"SEQ_SCAN", "READ_PARQUET", "READ_CSV", "TABLE_SCAN", "PARQUET_SCAN"}

# --- safety -------------------------------------------------------------
# Functions that reach the filesystem. The explicit set is the documented
# ones; anything else named read_* or *_scan is treated the same way, so a
# function added by a future DuckDB release is denied rather than missed.
FILE_FUNCTIONS = {
    "read_csv", "read_csv_auto", "read_parquet", "parquet_scan", "read_json",
    "read_json_auto", "read_ndjson", "read_ndjson_auto", "read_text",
    "read_blob", "glob", "sniff_csv", "read_xlsx", "delta_scan",
    "iceberg_scan", "read_json_objects",
}


def _is_file_function(name):
    n = (name or "").lower()
    return n in FILE_FUNCTIONS or n.startswith("read_") or n.endswith("_scan")


@dataclass
class Finding:
    rule: str
    severity: str          # "deny" | "block" | "warn"
    title: str
    detail: str
    suggestions: list = field(default_factory=list)


@dataclass
class Review:
    verdict: str           # "allow" | "warn" | "block" | "deny"
    findings: list
    estimated_rows: int = 0
    scanned_rows: int = 0
    operators: list = field(default_factory=list)

    @property
    def overridable(self):
        """A cost block can be confirmed by the caller. A denial cannot."""
        return self.verdict == "block"

    def as_dict(self):
        return {
            "verdict": self.verdict,
            "overridable": self.overridable,
            "findings": [asdict(f) for f in self.findings],
            "estimated_rows": self.estimated_rows,
            "scanned_rows": self.scanned_rows,
            "operators": sorted(set(self.operators)),
        }


@dataclass(frozen=True)
class Limits:
    """Tuned against measurement, not intuition. See the module docstring."""
    absurd_rows: int = 1_000_000_000
    heavy_scan_rows: int = 20_000_000
    export_warn_rows: int = 5_000_000
    export_block_rows: int = 100_000_000


def _verdict(findings):
    for level in ("deny", "block", "warn"):
        if any(f.severity == level for f in findings):
            return level
    return "allow"


def _fmt(n):
    return f"{n:,}"


# ----------------------------------------------------------------------
# Pass 1: safety -- what may this statement reach?
# ----------------------------------------------------------------------
def _collect(obj, key, acc):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                acc.append(v)
            _collect(v, key, acc)
    elif isinstance(obj, list):
        for v in obj:
            _collect(v, key, acc)
    return acc


def _string_literals(ast):
    out = []
    for node in _collect(ast, "value", []):
        if isinstance(node, dict) and isinstance(node.get("value"), str):
            out.append(node["value"])
        elif isinstance(node, str):
            out.append(node)
    return out


def _within(path, roots):
    """True if `path` resolves inside one of `roots`.

    Resolution happens before the comparison, so `..` segments and symlinks
    pointing out of the tree both fail the test rather than slipping past it.
    """
    try:
        target = os.path.realpath(os.path.abspath(str(path)))
    except (OSError, ValueError):
        return False
    for root in roots:
        try:
            r = os.path.realpath(os.path.abspath(str(root)))
        except (OSError, ValueError):
            continue
        if target == r or target.startswith(r + os.sep):
            return True
    return False


def safety_findings(ast, allowed_roots):
    findings = []

    tables = [t for t in _collect(ast, "table_name", []) if isinstance(t, str)]
    internal = sorted({t for t in tables if t.startswith("_")})
    if internal:
        findings.append(Finding(
            rule="registry_table_access",
            severity="deny",
            title=f"{', '.join(internal)} is internal",
            detail=("The registry tables hold every analyst's source paths, "
                    "who cut which slice from where, and the server's "
                    "settings. They are not readable from the SQL tab."),
            suggestions=[
                "Lineage and row counts are on the relation list",
                "Rejected rows are on the Rejected rows tab",
            ]))

    functions = [f for f in _collect(ast, "function_name", [])
                 if isinstance(f, str)]
    file_funcs = sorted({f for f in functions if _is_file_function(f)})
    if file_funcs:
        literals = _string_literals(ast)
        # Only treat a literal as a path if it looks like one; a bare filter
        # value that happens to sit in the same statement is not an argument
        # to the reader.
        candidates = [s for s in literals
                      if ("/" in s or "\\" in s or "." in s)]
        outside = [s for s in candidates if not _within(s, allowed_roots)]
        if outside or not candidates:
            findings.append(Finding(
                rule="file_access_outside_share",
                severity="deny",
                title=f"{', '.join(file_funcs)} may only read the share",
                detail=(
                    "Reading files directly is allowed, but only inside the "
                    "configured data and parquet directories. "
                    + (f"Refused: {', '.join(sorted(set(outside))[:3])}"
                       if outside else
                       "No readable path could be identified in the call.")),
                suggestions=[
                    "Load the file properly instead: it gets a Parquet copy, "
                    "a registered view, and lineage",
                    "Query an already-loaded source by name",
                ]))
    return findings


# ----------------------------------------------------------------------
# Pass 2: cost -- is this worth running?
# ----------------------------------------------------------------------
def _walk(node, nodes):
    info = node.get("extra_info") or {}
    raw = info.get("Estimated Cardinality")
    try:
        card = int(str(raw).replace(",", "")) if raw is not None else None
    except (TypeError, ValueError):
        card = None
    nodes.append((node.get("name", "?"), card))
    for child in node.get("children") or []:
        _walk(child, nodes)
    return nodes


def cost_findings(plan_json, limits=Limits()):
    nodes = []
    for root in plan_json:
        _walk(root, nodes)
    ops = [n for n, _ in nodes]
    cards = [c for _, c in nodes if c is not None]
    estimated = max(cards or [0])
    scanned = max([c for n, c in nodes if n in SCANS and c is not None] or [0])
    bounded = any(o in LIMITING for o in ops)
    findings = []

    if any(o in CARTESIAN for o in ops):
        findings.append(Finding(
            rule="cartesian_join",
            severity="block",
            title="Every row joined to every row",
            detail=(f"The plan has a cross product and expects about "
                    f"{_fmt(estimated)} rows. Listing two relations separated "
                    "by a comma, or joining without a condition, pairs each "
                    "row on the left with every row on the right."),
            suggestions=[
                "Add a join condition: FROM a JOIN b ON a.key = b.key",
                "To stack rows rather than combine columns, use UNION ALL",
            ]))
    elif estimated >= limits.absurd_rows:
        findings.append(Finding(
            rule="absurd_cardinality",
            severity="block",
            title=f"About {_fmt(estimated)} rows",
            detail=("That is more than can be displayed, exported or usefully "
                    "read, and it holds a query slot while everyone else "
                    "waits."),
            suggestions=[
                "Filter first with a WHERE clause",
                "Aggregate instead of listing rows: GROUP BY with count/sum",
                "Add LIMIT if you only wanted a sample",
            ]))

    if any(o in JOINS for o in ops):
        findings.append(Finding(
            rule="join_fanout_unknown",
            severity="warn",
            title="Join row counts are an estimate, and an unreliable one",
            detail=("If the key is not unique on one side, every match "
                    "multiplies. The query planner under-predicts this badly: "
                    "measured here, a self-join on a 1,000-value key was "
                    "estimated at 20 million rows against a true ~400 "
                    "billion. Check the count against what you expected."),
            suggestions=[
                "Confirm the key is unique on one side: SELECT key, count(*) "
                "FROM rel GROUP BY key HAVING count(*) > 1",
                "Aggregate the many-side first, or use SELECT DISTINCT",
            ]))

    if not bounded and scanned >= limits.heavy_scan_rows:
        if "ORDER_BY" in ops:
            findings.append(Finding(
                rule="unbounded_sort",
                severity="warn",
                title=f"Sorting about {_fmt(scanned)} rows with no limit",
                detail=("A full sort holds the whole relation and spills to "
                        "the temp folder when it will not fit. The paging "
                        "wrapper usually turns this into a bounded TOP_N; "
                        "here it could not, so the sort is real."),
                suggestions=[
                    "Add LIMIT to the query itself, not just the page",
                    "Filter before sorting",
                    "Save the subset with Save as table, then sort that",
                ]))
        if "HASH_GROUP_BY" in ops:
            findings.append(Finding(
                rule="high_cardinality_group",
                severity="warn",
                title=f"Grouping about {_fmt(scanned)} rows into many groups",
                detail=("The engine chose a hash aggregate, meaning it expects "
                        "too many distinct groups for the cheap path. That "
                        "hash table is held in memory, and the memory limit is "
                        "shared with everything else running."),
                suggestions=[
                    "Filter before grouping",
                    "For a distinct count only, approx_count_distinct(col) is "
                    "far cheaper",
                ]))

    return findings, estimated, scanned, ops


# ----------------------------------------------------------------------
# Entry points
# ----------------------------------------------------------------------
class Rejected(Exception):
    """Carries a Review so the router can return it to the client intact."""

    def __init__(self, review):
        super().__init__(review.findings[0].title if review.findings
                         else "rejected")
        self.review = review

    @property
    def detail(self):
        """The same body an HTTP refusal carries, for a job that refused."""
        return {"error": "gateway", **self.review.as_dict()}


async def review_sql(engine, sql, *, allowed_roots, limits=Limits()):
    """Parse, judge and return a Review. Never executes the statement.

    The read-only check is here too, so there is exactly one place that
    decides whether a user's SQL may run.
    """
    parsed = await engine.fetch("SELECT json_serialize_sql(?)", [sql],
                                heavy=False)
    try:
        ast = json.loads(parsed.scalar())
    except (TypeError, ValueError):
        ast = None
    if not ast or ast.get("error") or len(ast.get("statements", [])) != 1:
        return Review("deny", [Finding(
            rule="not_a_single_select",
            severity="deny",
            title="Only a single read-only SELECT runs here",
            detail=("Only SELECT statements can run here, so writes, "
                    "DDL, ATTACH, INSTALL, COPY ... TO and multiple "
                    "statements all fail this check."),
            suggestions=[
                "To keep a result, run the SELECT and use Save as table",
                "To bring in a new file, use Load a CSV",
            ])])

    findings = safety_findings(ast, allowed_roots)
    if findings:
        # Do not plan a statement that is not allowed to run; EXPLAIN on a
        # denied file read would still resolve the path.
        return Review(_verdict(findings), findings)

    estimated = scanned = 0
    ops = []
    try:
        res = await engine.fetch(f"EXPLAIN (FORMAT json) {sql}", heavy=False)
        plan = json.loads(res.rows[0][1])
    except Exception:
        # An unplannable statement is about to fail with a better message of
        # its own; turning that into a gateway error would only confuse.
        plan = None
    if plan is not None:
        findings, estimated, scanned, ops = cost_findings(plan, limits)
    return Review(_verdict(findings), findings, estimated, scanned, ops)


async def review_generated(engine, sql, *, limits=Limits()):
    """Cost pass only, for SQL this app built itself.

    The safety pass is skipped deliberately: the statement came from sqlgen
    with every identifier already checked against the relation's schema, so
    there is nothing untrusted left to police. Skipping it is also necessary
    -- json_serialize_sql only round-trips SELECT, and the pivot builder
    emits PIVOT, which would be denied as "not a single SELECT".

    Fails open. EXPLAIN cannot plan PIVOT either, and a cost warning is worth
    less than a working pivot tab.
    """
    try:
        res = await engine.fetch(f"EXPLAIN (FORMAT json) {sql}", heavy=False)
        plan = json.loads(res.rows[0][1])
    except Exception:
        return Review("allow", [])
    findings, estimated, scanned, ops = cost_findings(plan, limits)
    return Review(_verdict(findings), findings, estimated, scanned, ops)


def review_export(total_rows, fmt, limits=Limits()):
    """Exports are judged on the exact count, since one is already known.

    An export materialises every row to the server's disk before it is
    streamed, so no paging saves it.
    """
    findings = []
    if total_rows >= limits.export_block_rows:
        findings.append(Finding(
            rule="export_too_large",
            severity="block",
            title=f"{_fmt(total_rows)} rows is a very large export",
            detail=("The entire result is written to the server's disk before "
                    "it is sent to you."),
            suggestions=[
                "Narrow the query and export the part you need",
                "Save it as a table instead and query it in place",
            ]))
    elif total_rows >= limits.export_warn_rows:
        findings.append(Finding(
            rule="export_large",
            severity="warn",
            title=f"{_fmt(total_rows)} rows is a large export",
            detail=("It will take a while, hold a query slot throughout, and "
                    "be written to the server's disk in full first."
                    + (" CSV also carries no type information, so the leading "
                       "zeros you protected at load are lost on the way out."
                       if fmt == "csv" else "")),
            suggestions=(
                ["Use parquet: smaller, faster, and it keeps column types"]
                if fmt != "parquet" else [])
            + ["Filter further if you do not need every row"],
        ))
    return Review(_verdict(findings), findings, total_rows, total_rows)
