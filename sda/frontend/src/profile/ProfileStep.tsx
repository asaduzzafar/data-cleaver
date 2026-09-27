import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, formatCount } from "../api";
import { DataGrid } from "../DataGrid";
import { GatewayNotice } from "../Gateway";
import { JobStatus, KeptNote, useKeptJob, useKeptState, versionKey } from "../jobs";
import { Button, Collapsible, Empty, Icon, Select } from "../ui";
import type {
  Job, OutlierCheck, Profile, ProfileColumn, QueryResult, Relation,
} from "../types";
import { Histogram, TopValues, formatValue } from "./Distribution";

const CHECK_NAME: Record<OutlierCheck, string> = {
  extremes: "Numeric extremes",
  rare: "Rare categories",
  missing: "Missing and blank",
  duplicates: "Duplicate keys",
};

/**
 * Step 1 of the EDA path: what is in this relation.
 *
 * Profile finds leads; Outliers investigates them. The profile runs on its
 * own when a relation opens (0.4s on a million rows), and again whenever the
 * relation is reloaded or re-cut. Coming back to it shows the kept profile.
 */
export function ProfileStep({ relation, onInvestigate, onNext }: {
  relation: Relation;
  onInvestigate: (check: OutlierCheck, column: string) => void;
  onNext: () => void;
}) {
  const run = useKeptJob(`profile:${versionKey(relation)}`, () => api.post<Job>(
    `/relations/${encodeURIComponent(relation.name)}/profile`));

  const profile = run.job?.state === "done" ? (run.job.result as unknown as Profile) : null;
  // The column whose distinct values are listed, per relation.
  const [valuesFor, setValuesFor] = useKeptState(`profile:${relation.name}:values`, "");

  return (
    <section aria-label="Profile" className="flex flex-col gap-4">
      {!profile && <JobStatus job={run.job} onCancel={run.cancel} />}
      {profile && (
        <>
          <KeptNote at={run.keptAt} busy={run.busy} onRefresh={run.refresh} verb="Profiled" />
          <Overview profile={profile} />
          {profile.leads.length > 0 && (
            <Leads profile={profile} onInvestigate={onInvestigate} />
          )}
          <ColumnLedger profile={profile} onValues={setValuesFor} />
          <DistinctValues relation={relation} column={valuesFor} onColumn={setValuesFor}
                          columns={profile.columns.map((c) => c.name)} />
          {profile.rejected > 0 && <Rejected relation={relation} count={profile.rejected} />}
          <div className="flex justify-end">
            <Button onClick={onNext}>
              Next: preview rows <Icon name="right" size={14} />
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function Overview({ profile }: { profile: Profile }) {
  return (
    <p className="text-ink-2">
      <span className="font-semibold text-ink">{formatCount(profile.rows)}</span> rows
      {" · "}
      <span className="font-semibold text-ink">{profile.columns.length}</span> columns
      {" · "}
      {profile.rejected > 0 ? (
        <a href="#rejected">
          {formatCount(profile.rejected)} {profile.rejected === 1 ? "row" : "rows"} rejected
          by the parser
        </a>
      ) : "no rows rejected by the parser"}
    </p>
  );
}

/** Worth a look: each lead names the Outliers check that investigates it. */
function Leads({ profile, onInvestigate }: {
  profile: Profile; onInvestigate: (check: OutlierCheck, column: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible title="Worth a look" meta={`${profile.leads.length} ${
                   profile.leads.length === 1 ? "finding" : "findings"}`}
                 open={open} onToggle={() => setOpen(!open)}>
      <ul>
        {profile.leads.map((l) => (
          <li key={`${l.check}:${l.column}`}
              className="flex items-center gap-3 border-b border-line px-3 py-1.5
                         last:border-b-0">
            <Icon name="alert" size={14} className="shrink-0 text-ink-2" />
            <span className="min-w-0 flex-1">{l.summary}</span>
            <button type="button" onClick={() => onInvestigate(l.check, l.column)}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1
                               text-ref hover:underline">
              {CHECK_NAME[l.check]} <Icon name="right" size={12} />
            </button>
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}

function approx(on: boolean) {
  // The legend line was cut, so the mark carries its own meaning.
  return on ? <span title="estimated, not counted">≈<span className="sr-only"> (estimated)</span></span> : null;
}

/** One ruled line per column: what it is, how full, how varied, its shape. */
function ColumnLedger({ profile, onValues }: {
  profile: Profile; onValues: (column: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="grid-rows w-full border-collapse">
        <caption className="sr-only">Columns of {profile.relation}</caption>
        <thead>
          <tr className="text-left text-[12px] text-ink-2">
            {["Column", "Type", "Filled", "Distinct", "Range", "Distribution"].map((h, i) => (
              <th key={h} scope="col"
                  className={`border-b border-line px-3 py-1.5
                              font-semibold whitespace-nowrap ${
                              i === 2 || i === 3 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profile.columns.map((c) => (
            <ColumnRow key={c.name} c={c} rows={profile.rows} onValues={() => onValues(c.name)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnRow({ c, rows, onValues }: {
  c: ProfileColumn; rows: number; onValues: () => void;
}) {
  const filled = rows ? 100 - c.null_pct : 0;
  return (
    <tr className="align-middle">
      <th scope="row" className="px-3 py-1.5 text-left font-semibold whitespace-nowrap">
        {c.name}
      </th>
      <td className="px-3 py-1.5">
        <code className="text-[12px] text-ink-2">{c.type}</code>
      </td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">
        {filled.toLocaleString(undefined, { maximumFractionDigits: 2 })}%
        {c.null_pct > 0 && (
          <span className="block text-[12px] text-muted">
            {formatCount(rows - c.non_null)} blank
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">
        <button type="button" onClick={onValues}
                aria-label={`${formatCount(c.distinct)}${c.distinct_approx ? " (estimated)" : ""} distinct: list the values of ${c.name}`}
                className="cursor-pointer text-ref underline decoration-ref/30 underline-offset-2
                           hover:decoration-ref">
          {approx(c.distinct_approx)}{formatCount(c.distinct)}
        </button>
      </td>
      <td className="px-3 py-1.5 text-[12px] whitespace-nowrap text-ink-2">
        <Range c={c} />
      </td>
      <td className="px-3 py-1.5">
        {c.histogram && c.histogram.length > 0 && (
          <Histogram bins={c.histogram} label={c.name} />
        )}
        {c.top && c.top.length > 0 && (
          <TopValues top={c.top} total={c.non_null} label={c.name} />
        )}
        {!c.histogram?.length && !c.top?.length && (
          <span className="text-[12px] text-muted">
            {c.non_null === 0 ? "every value blank" : "too varied to summarise"}
          </span>
        )}
      </td>
    </tr>
  );
}

function Range({ c }: { c: ProfileColumn }) {
  if (c.min === null && c.max === null) return <span className="text-muted">—</span>;
  if (c.family === "number") {
    return (
      <span>
        {formatValue(c.min)}
        <span className="text-muted"> · median </span>
        {approx(c.quartiles_approx)}{formatValue(c.median)}
        <span className="text-muted"> · </span>
        {formatValue(c.max)}
      </span>
    );
  }
  return <span>{formatValue(c.min)} <span className="text-muted">to</span> {formatValue(c.max)}</span>;
}

/** Rows the parser rejected, folded into the profile as data quality. */
function Rejected({ relation, count }: { relation: Relation; count: number }) {
  const [open, setOpen] = useState(false);
  const base = relation.kind === "source" ? relation.name : relation.base;
  const { data, isPending } = useQuery({
    enabled: open,
    queryKey: ["rejects", base],
    queryFn: () => api.get<{
      columns: string[]; rows: unknown[][]; total: number; truncated: boolean;
    }>(`/relations/${encodeURIComponent(base)}/rejects`),
  });
  return (
    <section id="rejected" aria-labelledby="rejected-h" className="overflow-hidden rounded-lg border border-line">
      <h3 id="rejected-h">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
                className="flex w-full cursor-pointer items-center gap-2 bg-casing px-3
                           py-1.5 text-left text-[12px] font-semibold text-ink-2">
          <Icon name={open ? "up" : "right"} size={12} />
          Rejected rows · {formatCount(count)}
          <span className="font-normal text-muted">
            — not counted in any total here; the source file had them
          </span>
        </button>
      </h3>
      {open && isPending && <Empty>Loading…</Empty>}
      {open && data && (
        <div className="max-h-72 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>{data.columns.map((h) => (
                <th key={h} scope="col"
                    className="border-b border-line px-3 py-1 text-left font-semibold text-ink-2">
                  {h}
                </th>))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="border-b border-line px-3 py-1 font-mono">
                      {cell === null ? "—" : String(cell)}
                    </td>))}
                </tr>))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Every distinct value of one column, most frequent first, with how many
 * rows hold it: the whole list, paged, not only the top three the ledger
 * draws. Exportable; not saved as a slice, since it is a view of the
 * profile rather than a cut of the data.
 */
function DistinctValues({ relation, columns, column, onColumn }: {
  relation: Relation; columns: string[];
  column: string; onColumn: (name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [page, setPage] = useKeptState(`profile:${relation.name}:values:${column}:page`, 1);
  const post = (confirm: boolean) => () => api.post<Job>("/query", {
    mode: "frequencies", relation: relation.name, column, page, page_size: 500,
    confirm_expensive: confirm,
  });
  // Kept like the profile. Export still works on an old one: the server
  // keeps a query's recipe for hours after it drops the rows.
  const run = useKeptJob(
    column ? `values:${versionKey(relation)}:${column}:${page}` : null, post(false));
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  // A column chosen in the ledger above opens this box, whatever state the
  // reader left it in, and brings it into view: otherwise the click on a
  // Distinct figure looks like nothing happened. Not on the way back to a
  // column already open.
  const shownFor = useRef(column);
  useEffect(() => {
    if (!column || shownFor.current === column) return;
    shownFor.current = column;
    setOpen(true);
    box.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [column]);
  const result = column && run.shown ? (run.shown.result as QueryResult) : null;

  return (
    <Collapsible ref={box} title="Distinct values" open={open} onToggle={() => setOpen(!open)}
                 meta={column ? `of ${column}` : undefined}
                 about="Each value in a column, and how many rows hold it.">
      <div className="flex flex-col gap-3 p-3">
        <div className="w-64">
          <label htmlFor={`${id}-col`} className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
            Column
          </label>
          <Select id={`${id}-col`} value={column} onChange={(e) => onColumn(e.target.value)}>
            <option value="">choose a column…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <GatewayNotice review={run.blocked} onDismiss={run.clearBlocked}
                       onConfirm={() => void run.refresh(post(true))} />
        {run.job?.state !== "done" && <JobStatus job={run.job} onCancel={run.cancel} />}
        <GatewayNotice review={result?.gateway ?? null} />
        {result && (
          <DataGrid result={result} job={run.shown} onPage={setPage}
                    unit={["distinct value", "distinct values"]} />
        )}
        {!column && (
          <p className="text-[13px] text-muted">
            Choose a column, or a figure in the Distinct column above.
          </p>
        )}
      </div>
    </Collapsible>
  );
}
