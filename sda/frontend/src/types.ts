export type Health = {
  status: string;
  user: string;
  duckdb: string;
  database: string;
  folders: Folder[];
  parquet_dir: string;
  memory_limit: string;
  threads: number;
  query_slots: number;
  queries: QueueSnapshot;
  loads: QueueSnapshot;
  registry: Record<string, number>;
  /** Changes whenever the catalog does, including reloads. */
  catalog_version: string;
};

type QueueSnapshot = {
  slots: number;
  running: number;
  waiting: number;
  free: number;
};

type JobState = "queued" | "running" | "done" | "error" | "cancelled";

export type Job = {
  id: string;
  kind: "query" | "load";
  label: string;
  state: JobState;
  progress: string | null;
  error: string | null;
  /** 1 = next to run. 0 = not waiting. */
  position: number;
  ahead: number;
  queued_ms: number;
  elapsed_ms: number;
  queue?: QueueSnapshot;
  result?: QueryResult | LoadResult | ExportResult | BackupResult | SaveResult;
  /** Structured reason for a refusal inside the job, e.g. a join's fan-out. */
  detail?: (GatewayReview & { error: "gateway" }) | null;
};

export type GatewayFinding = {
  rule: string;
  /** deny = safety, never overridable. block = cost, confirmable. warn = advisory. */
  severity: "deny" | "block" | "warn";
  title: string;
  detail: string;
  suggestions: string[];
};

export type GatewayReview = {
  verdict: "allow" | "warn" | "block" | "deny";
  overridable: boolean;
  findings: GatewayFinding[];
  estimated_rows: number;
  scanned_rows: number;
  operators: string[];
};

export type QueryResult = {
  gateway: GatewayReview | null;
  sql: string;
  base: string | null;
  inputs: string[];
  mode: string;
  total: number;
  page: number;
  pages: number;
  page_size: number;
  columns: string[];
  /** SQL type per column, aligned with columns (e.g. "DECIMAL(12,2)"). */
  types?: string[];
  rows: unknown[][];
};

export type LoadResult = {
  view_name: string;
  rows: number;
  rejected: number;
  parquet_path: string;
  csv_path: string;
  forced_to_text: string[];
};

export type ExportResult = {
  gateway: GatewayReview | null;
  filename: string;
  /** Where the file is. In the desktop app it was saved there directly. */
  path: string;
  saved?: boolean;
  format: string;
  rows: number;
  bytes: number;
};

export type SaveResult = {
  saved: string;
  rows: number;
  source: string | null;
  inputs: string[];
  owner: string;
};

export type BackupResult = {
  name: string;
  path: string;
  files: number;
  bytes: number;
  note: string;
};

export type Relation = {
  name: string;
  kind: "source" | "slice";
  rows: number | null;
  base: string;
  inputs: string[];
  staleness: "fresh" | "stale" | "unknown";
  note: string | null;
  loaded_at?: string | null;
  loaded_by?: string | null;
  csv_path?: string | null;
  parquet_path?: string | null;
  text_cols?: string | null;
  created_at?: string | null;
  owner?: string | null;
  source?: string | null;
  source_csv?: string | null;
  sql?: string | null;
};

export type Column = { name: string; type: string };

type DirEntry = { name: string; path: string; present?: boolean };

/** A folder the user added: the only places the app may read files. */
type Folder = { path: string; name: string; present: boolean };
type FileEntry = DirEntry & {
  bytes: number;
  modified: string;
  loadable: boolean;
};

export type Listing = {
  /** null at the top level, which lists the added folders. */
  root: string | null;
  path: string;
  parent: string | null;
  directories: DirEntry[];
  files: FileEntry[];
};

export type Detection = {
  path: string;
  bytes: number;
  view_name: string;
  parquet_name: string;
  columns: { name: string; type: string; suggest_text: boolean }[];
  suggested_text: string[];
  already_registered: boolean;
  prior_csv_path: string | null;
  prior_loaded_at: string | null;
};

/** A filter node. Groups nest; M1's UI only builds one flat group. */
export type FilterNode =
  | { kind: "group"; combiner: "AND" | "OR"; children: FilterNode[] }
  | { kind: "cond"; column: string; op: string; value: unknown };

/** E1: the Profile step. Approximate figures say so (`*_approx`). */
export type HistogramBin = { lo: number | string; hi: number | string; count: number };
export type ProfileColumn = {
  name: string;
  type: string;
  family: "text" | "number" | "temporal" | "boolean" | string;
  non_null: number;
  null_pct: number;
  distinct: number | null;
  distinct_approx: boolean;
  min: number | string | null;
  max: number | string | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  mean: number | null;
  quartiles_approx: boolean;
  histogram: HistogramBin[] | null;
  top: { value: unknown; count: number }[] | null;
};
export type OutlierCheck = "extremes" | "rare" | "missing" | "duplicates";
type Lead = { column: string; check: OutlierCheck; summary: string };
export type Profile = {
  relation: string;
  rows: number;
  rejected: number;
  approx: boolean;
  columns: ProfileColumn[];
  leads: Lead[];
};

/** The same families the backend uses (sqlgen.type_family). */
export function typeFamily(type: string): "text" | "number" | "temporal" | "boolean" | "other" {
  const base = type.toUpperCase().split("(")[0].trim();
  if (["VARCHAR", "TEXT", "STRING", "CHAR", "BPCHAR"].includes(base)) return "text";
  if (["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT",
       "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT", "DECIMAL", "NUMERIC",
       "FLOAT", "REAL", "DOUBLE"].includes(base)) return "number";
  if (/^(DATE|TIMESTAMP|TIME)/.test(base)) return "temporal";
  if (base === "BOOLEAN" || base === "BOOL") return "boolean";
  return "other";
}

/** E3: the Outliers step. Every finding's `count` equals the rows `show` opens. */
type ShowSpec = Record<string, unknown> & { mode: string; relation: string };
export type Finding = {
  column: string | null; count: number; summary: string; show: ShowSpec;
  // extremes
  below?: number; above?: number; low?: number; high?: number; k?: number;
  histogram?: HistogramBin[];
  // rare
  values?: { value: unknown; count: number }[] | number; total_values?: number;
  // missing
  pct?: number;
  // duplicates
  worst?: { value: unknown; count: number };
};
export type Outliers = {
  relation: string; rows: number; k: number; n: number;
  extremes: Finding[]; rare: Finding[]; duplicates: Finding[];
  missing: { columns: Finding[]; mostly_blank: Finding };
};
