import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadExport, errorText, formatBytes, formatCount } from "./api";
import { GatewayNotice } from "./Gateway";
import { JobStatus, useJob } from "./jobs";
import { ResultGrid } from "./ResultGrid";
import { useDesktop } from "./desktop";
import { Button, Icon, Input, Notice, Select } from "./ui";
import type { ExportResult, Job, QueryResult, SaveResult } from "./types";

/**
 * Result table, paging, then what to do with the result: export it as a file
 * or save it as a data slice. Those come last, once the rows have been read.
 */
export function DataGrid({
  result, job, onPage, onSaved, canSave, unit = ["row", "rows"],
}: {
  result: QueryResult | null;
  job: Job | null;
  onPage: (page: number) => void;
  onSaved?: () => void;
  canSave?: boolean;
  /** What one line of the result is, singular and plural. */
  unit?: [string, string];
}) {
  if (!result) return null;
  const { columns, rows, total, page, pages } = result;

  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p><span className="font-semibold">{formatCount(total)}</span>{" "}
          <span className="text-muted">{total === 1 ? unit[0] : unit[1]}</span></p>
        <Pager page={page} pages={pages} onPage={onPage} />
      </div>

      <ResultGrid columns={columns} rows={rows}
                  types={result.types ?? columns.map(() => "")}
                  label={`Result, page ${page} of ${pages}`} />

      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted hover:text-ink">SQL</summary>
        <pre className="mt-2 overflow-auto rounded-lg border border-line
                        bg-well p-3 font-mono text-[12px] whitespace-pre-wrap">
          {result.sql}
        </pre>
      </details>

      <section aria-label="Keep this result"
               className="mt-1 flex flex-col divide-y divide-line rounded-2xl border border-line
                          bg-casing/60">
        <ExportControls job={job} total={total} />
        {canSave && <SaveControl job={job} onSaved={onSaved} />}
      </section>
    </div>
  );
}

/**
 * A paged query as a job: `run(page, confirm, asked)` posts `body()` with
 * the page and the confirmation, and remembers the page so a gateway
 * confirmation re-runs the same one.
 */
export function usePagedQuery(body: () => Record<string, unknown>) {
  const q = useJob();
  const [page, setPage] = useState(1);
  const run = (p = 1, confirm = false, asked = true) => {
    setPage(p);
    return q.start(() => api.post<Job>("/query", {
      ...body(), page: p, page_size: 500, confirm_expensive: confirm,
    }), asked);
  };
  const result = q.shown ? (q.shown.result as QueryResult) : null;
  return { ...q, page, run, result };
}

/** Under a query's controls: its refusal, its status, its rows. */
export function QueryResults({ q, onChanged }: {
  q: ReturnType<typeof usePagedQuery>; onChanged: () => void;
}) {
  return (
    <>
      <GatewayNotice review={q.blocked} onDismiss={q.clearBlocked}
                     onConfirm={() => q.run(q.page, true)} />
      <JobStatus job={q.job} onCancel={q.cancel} loud={q.loud} />
      <GatewayNotice review={q.result?.gateway ?? null} />
      <DataGrid result={q.result} job={q.shown} canSave onSaved={onChanged}
                onPage={(p) => q.run(p, false, false)} />
    </>
  );
}

/** One stacked row of the output panel: an icon, a title and what it does,
 *  then its fields and key. */
function OutputRow({ icon, title, note, children }: {
  icon: "down" | "plus"; title: string; note: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3 px-5 py-4">
      <div className="flex min-w-56 flex-1 items-start gap-3 self-center">
        <span aria-hidden="true"
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                         border border-brand bg-panel text-ink">
          <Icon name={icon} size={16} />
        </span>
        <div>
          <h4 className="font-(family-name:--font-display) text-[15px] font-bold">{title}</h4>
          <p className="text-[12.5px] text-muted">{note}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Pager({ page, pages, onPage }: {
  page: number; pages: number; onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted">
      <Button variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}
              title="Previous page">
        <Icon name="left" size={14} /><span className="sr-only">Previous page</span>
      </Button>
      <span>page {page.toLocaleString()} of {pages.toLocaleString()}</span>
      <Button variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}
              title="Next page">
        <Icon name="right" size={14} /><span className="sr-only">Next page</span>
      </Button>
    </div>
  );
}

const EXCEL_LIMIT = 1_048_576;

/** Paths as Windows writes them, whichever slash the server used. */
const windows = (path: string) => path.replace(/\//g, "\\");

/** A path's folder, either slash. */
const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

function ExportControls({ job, total }: { job: Job | null; total: number }) {
  const tooBigForExcel = total > EXCEL_LIMIT;
  // A result too big for one sheet starts on parquet, rather than on a
  // format that cannot take it.
  const [format, setFormat] = useState(tooBigForExcel ? "parquet" : "xlsx");
  const [name, setName] = useState("export");
  const exporter = useJob();
  const where = useQuery({
    queryKey: ["export-folder"],
    queryFn: () => api.get<{ folder: string | null; changeable: boolean }>("/export/folder"),
  });
  const qc = useQueryClient();
  const [revealError, setRevealError] = useState<string | null>(null);

  const startExport = (confirm = false) => exporter.start(() =>
    api.post<Job>("/export", {
      job_id: job!.id, format, filename: name, confirm_expensive: confirm,
    }));

  const tooManyForExcel = format === "xlsx" && tooBigForExcel;
  const done = exporter.job?.state === "done";
  const result = done ? (exporter.job?.result as ExportResult) : null;

  const id = useId();
  return (
    <OutputRow icon="down" title="Export a file"
               note="Write these rows to a file to open in Excel or another tool.">
      {/* Width lives on a wrapper, not on the control. The base class carries
          w-full, and two competing width utilities resolve by stylesheet
          order rather than by the order they are written here. */}
      <div className="w-52">
        <label htmlFor={`${id}-name`} className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
          File name
        </label>
        <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="w-32">
        <label htmlFor={`${id}-format`} className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
          Format
        </label>
        <Select id={`${id}-format`} value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="xlsx">xlsx</option>
          <option value="parquet">parquet</option>
          <option value="csv">csv</option>
        </Select>
      </div>
      <Button
        disabled={!job || job.state !== "done" || exporter.busy || tooManyForExcel}
        aria-describedby={tooManyForExcel ? `${id}-limit` : undefined}
        onClick={() => startExport()}
      >
        {exporter.busy ? "Exporting…" : "Export"}
      </Button>

      {where.data?.folder && (
        <ExportFolder folder={where.data.folder}
                      onChange={async (folder) => {
                        await api.post("/export/folder", { folder });
                        await qc.invalidateQueries({ queryKey: ["export-folder"] });
                      }} />
      )}

      {tooManyForExcel && (
        <div id={`${id}-limit`} className="basis-full">
          <Notice tone="warn" title="Too many rows for Excel">
            <p>
              This result has {formatCount(total)} rows, and one Excel sheet holds
              at most {formatCount(EXCEL_LIMIT)}. Export it as parquet or csv
              instead, or filter it down to fewer rows first.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => setFormat("parquet")}>Use parquet</Button>
              <Button variant="ghost" onClick={() => setFormat("csv")}>Use csv</Button>
            </div>
          </Notice>
        </div>
      )}
      {format === "csv" && (
        <span className="basis-full text-[12px] text-muted" title="Leading zeros you protected at load time are lost again on the way out.">
          CSV carries no types; Excel re-guesses every column.
        </span>
      )}
      {exporter.busy && (
        <div className="basis-full"><JobStatus job={exporter.job} onCancel={exporter.cancel} /></div>
      )}
      {result?.saved && (
        <div role="status" className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2
                                      rounded-xl border border-line bg-panel px-4 py-3">
          <Icon name="tick" size={16} className="shrink-0 text-go" />
          <p className="min-w-0 flex-1">
            Saved <strong>{result.filename}</strong> ({formatBytes(result.bytes)}) to{" "}
            <span className="font-mono text-[12.5px] break-all">{windows(folderOf(result.path))}</span>
          </p>
          <Button onClick={async () => {
            setRevealError(null);
            try { await api.post(`/export/${exporter.job!.id}/reveal`, {}); }
            catch (e) { setRevealError(errorText(e)); }
          }}>
            Show in folder
          </Button>
          {revealError && <p role="alert" className="basis-full text-[12px] text-stop">{revealError}</p>}
        </div>
      )}
      {result && !result.saved && (
        <Button variant="primary"
                onClick={() => downloadExport(exporter.job!.id)}>
          Download {result.filename} ({formatBytes(result.bytes)})
        </Button>
      )}
      {exporter.job?.state === "error" && (
        <div className="basis-full">
          <Notice tone="warn" title="The export did not finish">{exporter.job.error}</Notice>
        </div>
      )}
      {exporter.blocked && (
        <div className="w-full">
          <GatewayNotice review={exporter.blocked}
                         onConfirm={() => startExport(true)}
                         onDismiss={exporter.clearBlocked} />
        </div>
      )}
      {result?.gateway && (
        <div className="w-full">
          <GatewayNotice review={result.gateway} />
        </div>
      )}
    </OutputRow>
  );
}

/** Where exports go, and changing it: the Windows folder picker in the
 *  desktop app, a typed path elsewhere. Remembered for next time. */
function ExportFolder({ folder, onChange }: {
  folder: string; onChange: (folder: string) => Promise<void>;
}) {
  const desktop = useDesktop();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const apply = async (path: string) => {
    setError(null);
    try {
      await onChange(path);
      setTyping(false);
      setDraft("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex basis-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="font-medium text-ink-2">Save to</span>
        <span className="min-w-0 font-mono text-[12.5px] break-all text-ink">{windows(folder)}</span>
        <Button variant="ghost" aria-label="Change the export folder"
                onClick={async () => {
                  if (!desktop) { setTyping(true); return; }
                  const picked = await desktop.pick_folder();
                  if (picked) await apply(picked);
                }}>
          Change…
        </Button>
      </div>
      {typing && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void apply(draft); }}>
          <Input aria-label="New export folder (full path)" value={draft}
                 placeholder="C:/Users/you/Documents/Exports"
                 onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!draft.trim()}>Use this folder</Button>
          <Button variant="ghost" onClick={() => setTyping(false)}>Cancel</Button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-stop">{error}</p>}
    </div>
  );
}

function SaveControl({ job, onSaved }: {
  job: Job | null; onSaved?: () => void;
}) {
  const [name, setName] = useState("");
  // A 12M-row slice takes minutes to write: it runs as a job, so the wait
  // shows its progress and the key stays down until it is done.
  const saver = useJob();
  const saved = saver.job?.state === "done"
    ? (saver.job.result as SaveResult) : null;
  const savedId = saved ? saver.job!.id : null;
  useEffect(() => {
    if (!savedId) return;
    setName("");
    onSaved?.();
    // Once per finished save, not on every new onSaved from the parent.
  }, [savedId]);

  const save = () => saver.start(() =>
    api.post<Job>("/query/save", { job_id: job!.id, name, background: true }));

  const id = useId();
  return (
    <OutputRow icon="plus" title="Save as data slice"
               note="Keep it in Your Data Sources, with its lineage: it turns stale if a source is reloaded.">
      <div className="w-[21rem] max-w-full">
        <label htmlFor={`${id}-slice`} className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
          Slice name
        </label>
        <Input id={`${id}-slice`} value={name} onChange={(e) => setName(e.target.value)}
               placeholder="e.g. large_orders" />
      </div>
      <Button variant="primary"
              disabled={!name.trim() || !job || job.state !== "done" || saver.busy}
              onClick={() => void save()}>
        {saver.busy ? "Saving…" : "Save slice"}
      </Button>
      {saver.busy && (
        <div className="basis-full"><JobStatus job={saver.job} onCancel={saver.cancel} /></div>
      )}
      {saved && (
        <span role="status" className="basis-full text-[12px] text-go">
          Saved as {saved.saved} ({formatCount(saved.rows)} rows)
        </span>
      )}
      {saver.job?.state === "error" && (
        <span role="alert" className="basis-full text-[12px] text-stop">{saver.job.error}</span>
      )}
    </OutputRow>
  );
}
