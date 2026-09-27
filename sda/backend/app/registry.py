"""The lineage registry.

These tables are why the app exists in the shape it does: a saved slice can be
traced back to the CSV it was cut from, and flagged stale when that source is
reloaded afterwards. The rule that makes it work is that an unknown timestamp
stays NULL -- a plausible-looking back-filled value silently defeats the
staleness check.

Carried over from v3, the Streamlit predecessor, with these additions:

  _sources.loaded_by     who loaded it (from the server design; one user now,
                         but harmless and still shown)
  _lineage.owner         same
  _lineage_inputs        a join has more than one parent; _lineage.source stays
                         as the primary parent so the existing staleness
                         comparison keeps working unchanged
  _saved_queries         re-runnable specs, distinct from saved *tables*

v3's legacy handling (the _rejects pre-migration rename, and the whole adopt
panel) is deliberately absent: the app starts from an empty database, so
there is nothing from an earlier version to adopt.
"""

DDL = (
    # What the user sets from the UI.
    """CREATE TABLE IF NOT EXISTS _settings (
         k VARCHAR PRIMARY KEY, v VARCHAR)""",
    # One row per loaded CSV -> the view and parquet file it owns.
    """CREATE TABLE IF NOT EXISTS _sources (
         view_name VARCHAR PRIMARY KEY, csv_path VARCHAR,
         parquet_path VARCHAR, loaded_at TIMESTAMP, n_rows BIGINT,
         text_cols VARCHAR, loaded_by VARCHAR)""",
    # One row per saved slice -> what it was cut from, and when.
    """CREATE TABLE IF NOT EXISTS _lineage (
         table_name VARCHAR PRIMARY KEY, source VARCHAR, source_csv VARCHAR,
         created_at TIMESTAMP, n_rows BIGINT, sql VARCHAR, owner VARCHAR)""",
    # Every input a slice was built from, including each side of a join.
    """CREATE TABLE IF NOT EXISTS _lineage_inputs (
         table_name VARCHAR, source VARCHAR,
         PRIMARY KEY (table_name, source))""",
    # Named, re-runnable query specs. Unlike _lineage these materialise nothing.
    """CREATE TABLE IF NOT EXISTS _saved_queries (
         id VARCHAR PRIMARY KEY, name VARCHAR, owner VARCHAR,
         created_at TIMESTAMP, updated_at TIMESTAMP, spec JSON, sql VARCHAR,
         shared BOOLEAN, last_run_at TIMESTAMP)""",
    # Parser-rejected rows, tagged by source. These are absent from every row
    # count the UI shows -- do not reconcile totals without checking here.
    """CREATE TABLE IF NOT EXISTS _rejects (
         source VARCHAR, line BIGINT, column_name VARCHAR, error_type VARCHAR,
         csv_line VARCHAR, error_message VARCHAR)""",
)


# Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS
# leaves an existing table alone, so older databases gain them here. Each is
# nullable: a value the old database never recorded stays unknown.
MIGRATIONS = (
    # The last *successful* run of a saved query; NULL means never.
    "ALTER TABLE _saved_queries ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMP",
)


def ensure_schema(con):
    for stmt in DDL + MIGRATIONS:
        con.execute(stmt)


# Changes whenever the catalog does: a count moves on add or remove, and the
# latest time moves on a reload or re-save, which changes no count but does
# change staleness. The UI polls health and refetches the catalog when this
# changes, so work that finished in the background still shows up.
CATALOG_VERSION_SQL = """
SELECT concat_ws('|',
         (SELECT count(*) FROM _sources), (SELECT count(*) FROM _lineage),
         (SELECT max(loaded_at) FROM _sources),
         (SELECT max(created_at) FROM _lineage))
"""

# Registry sizes in one round trip, for the health check.
COUNTS_SQL = """
SELECT (SELECT count(*) FROM _sources)       AS sources,
       (SELECT count(*) FROM _lineage)       AS slices,
       (SELECT count(*) FROM _saved_queries) AS saved_queries,
       (SELECT count(*) FROM _rejects)       AS rejects
"""
