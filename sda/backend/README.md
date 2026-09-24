# Data Cleaver -- backend

FastAPI over DuckDB. It replaced a Streamlit app ("v3" in code comments), which
is not part of this repository.

## Run

```
pip install -r requirements.txt
uvicorn app.main:app --workers 1 --port 8000 --reload
```

**One worker, always.** DuckDB takes an exclusive lock on the database file, so
a second worker cannot open it at all. Concurrency happens inside the single
process: each request gets its own `cursor()` off the root connection, and a
semaphore caps how many heavy queries run at once.

## Configuration

All deployment-level, read from the environment at startup. Anything an analyst
changes from the UI belongs in the `_settings` table inside the database file.

| Variable | Default | Notes |
|---|---|---|
| `SDA_ROOT` | `~/sda` | Base for the defaults below |
| `SDA_DB` | `$SDA_ROOT/sda.duckdb` | Registry and saved slices |
| `SDA_DATA_DIR` | `$SDA_ROOT/data` | The mounted share analysts drop CSVs on; browsing is confined to this tree |
| `SDA_PARQUET_DIR` | `$SDA_ROOT/parquets` | Converted sources |
| `SDA_MEMORY_LIMIT` | `12GB` | GLOBAL scope in DuckDB -- the whole server's budget, not per user |
| `SDA_THREADS` | cpu count | Also GLOBAL |
| `SDA_QUERY_SLOTS` | `4` | Concurrent heavy queries; the rest queue |
| `SDA_DEV_USER` | `dev` | Recorded as the author of loads and saves |

## Endpoints

| | |
|---|---|
| `GET /api/health` | server facts, registry counts, live slot occupancy |
| `GET /api/relations` | catalog with lineage and staleness resolved |
| `GET /api/relations/{n}/schema` `/values` `/rejects` | columns; distinct values with counts; parser rejects |
| `DELETE /api/relations/{n}` | drop a relation (the Parquet file is kept) |
| `GET /api/files` | browse the added folders (absolute paths; the top level lists the folders) |
| `POST /api/load/detect` `/api/load` | sample column types; convert to Parquet and register |
| `POST /api/query` `/api/query/save` | run slice/pivot/sql/frequencies/join; materialise with lineage (`background: true` returns a job to watch) |
| `GET/POST /api/saved` `GET/PUT/DELETE /api/saved/{id}` `POST /api/saved/{id}/run` | saved queries: specs re-validated against current data on every run |
| `GET/POST/DELETE /api/folders` | the folders the app may read |
| `GET/POST /api/sample` | sample dataset status; install what is missing |
| `POST /api/joins/probe` | measure a join's keys: matches, NULL keys, fan-out, exact output rows |
| `GET /api/jobs/{id}` `DELETE /api/jobs/{id}` | status with queue position; cancel |
| `POST /api/export` `GET /api/export/{id}/download` | write a result, then collect it once |
| `GET /api/admin/backups` `POST /api/admin/backup` | list backups; EXPORT DATABASE |

## Two things that are easy to get wrong

**Queue position is in every job payload.** A waiting query and a hung one
look identical without it, and people respond by pressing Run again. The
client polls `GET /api/jobs/{id}`, whose "done" status carries the result.

**Back up from inside the app.** Nothing outside this process can read the
database while it runs, so a file-level snapshot taken mid-write can produce
an unopenable copy at a plausible size. `POST /api/admin/backup` runs
EXPORT DATABASE, which knows when that is safe. It covers the registry and
saved slices -- the lineage -- not the source Parquet, which is reloadable.
