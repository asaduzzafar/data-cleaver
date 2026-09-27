import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, formatCount } from "../api";
import { JobStatus, KeptNote, useKeptJob, useKeptState, versionKey } from "../jobs";
import { Histogram, formatValue } from "../profile/Distribution";
import { Button, Collapsible, Icon } from "../ui";
import type { Finding, Job, OutlierCheck, Outliers, Relation } from "../types";

export const CHECK_TITLE: Record<OutlierCheck, string> = {
  extremes: "Numeric extremes",
  rare: "Rare categories",
  missing: "Missing and blank",
  duplicates: "Duplicate keys",
};

const WHY: Record<OutlierCheck, string> = {
  extremes: "Values outside fences set a multiple of the middle half (the IQR) past its edges.",
  rare: "Values of a category column seen only a few times: often typos or one-off codes.",
  missing: "Blank values per column, and rows that are mostly blank.",
  duplicates: "Columns that behave like keys, yet repeat a value.",
};

/**
 * Step 3 of the EDA path: what does not fit, as an auditor's exceptions
 * list. Each finding's count is exactly the rows its "Show these rows"
 * opens -- the backend computes both from the same predicate.
 */
export function OutliersStep({ relation, focus, onShow, onNext }: {
  relation: Relation;
  /** A check to bring into view, when arriving from a Profile lead. */
  focus: OutlierCheck | null;
  onShow: (finding: Finding, check: OutlierCheck) => void;
  onNext: () => void;
}) {
  const [k, setK] = useKeptState(`outliers:${relation.name}:k`, 1.5);
  const [n, setN] = useKeptState(`outliers:${relation.name}:n`, 5);
  const run = useKeptJob(`outliers:${versionKey(relation)}:${k}:${n}`, () => api.post<Job>(
    `/relations/${encodeURIComponent(relation.name)}/outliers`, { k, n }));
  const result = run.job?.state === "done" ? (run.job.result as unknown as Outliers) : null;

  const sections: [OutlierCheck, Finding[]][] = result ? [
    ["extremes", result.extremes],
    ["rare", result.rare],
    ["missing", [...result.missing.columns,
                 ...(result.missing.mostly_blank.count ? [result.missing.mostly_blank] : [])]],
    ["duplicates", result.duplicates],
  ] : [];

  return (
    <section aria-label="Outliers" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4 text-[13px] text-ink-2">
        <label className="flex items-center gap-2">
          Fence width
          <select value={k} onChange={(e) => setK(Number(e.target.value))}
                  className="h-8 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-ink">
            <option value={1.5}>1.5 × IQR (the usual)</option>
            <option value={2}>2 × IQR</option>
            <option value={3}>3 × IQR (far out only)</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Rare means seen at most
          <select value={n} onChange={(e) => setN(Number(e.target.value))}
                  className="h-8 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-ink">
            {[1, 2, 5, 10, 25].map((v) => <option key={v} value={v}>{v} {v === 1 ? "time" : "times"}</option>)}
          </select>
        </label>
      </div>

      {!result && <JobStatus job={run.job} onCancel={run.cancel} />}
      <KeptNote at={result && run.keptAt} busy={run.busy} onRefresh={run.refresh} verb="Checked" />
      {sections.map(([check, findings]) => (
        <CheckSection key={check} check={check} findings={findings} focused={focus === check}>
          {findings.map((f, i) => (
            <FindingRow key={`${f.column}-${i}`} finding={f} check={check}
                        onShow={() => onShow(f, check)} />
          ))}
        </CheckSection>
      ))}

      {result && (
        <div className="flex justify-end">
          <Button onClick={onNext}>
            Next: slice and dice <Icon name="right" size={14} />
          </Button>
        </div>
      )}
    </section>
  );
}

function CheckSection({ check, findings, focused, children }: {
  check: OutlierCheck; findings: Finding[]; focused: boolean; children: ReactNode;
}) {
  // Every box opens folded to its header line, so the four checks and
  // their counts read at a glance; the one you were sent to opens.
  const [open, setOpen] = useState(focused);
  const head = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused && head.current) {
      setOpen(true);
      head.current.scrollIntoView({ block: "start", behavior: "smooth" });
      head.current.focus({ preventScroll: true });
    }
  }, [focused]);
  return (
    <Collapsible title={CHECK_TITLE[check]} about={WHY[check]} headRef={head}
                 tone={focused ? "focus" : "plain"}
                 meta={findings.length === 0 ? "nothing found"
                   : `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`}
                 open={open} onToggle={() => setOpen(!open)}>
      {findings.length === 0 ? (
        <p className="flex items-center gap-2 px-3 py-2 text-[12px] text-go">
          <Icon name="tick" size={14} /> Checked: nothing here.
        </p>
      ) : <ul>{children}</ul>}
    </Collapsible>
  );
}

function FindingRow({ finding: f, check, onShow }: {
  finding: Finding; check: OutlierCheck; onShow: () => void;
}) {
  return (
    <li className="grid items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2
                   last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto_auto]">
      <div className="min-w-0">
        <p>{f.summary}</p>
        <Detail finding={f} check={check} />
      </div>
      {check === "extremes" && f.histogram && f.low !== undefined && f.high !== undefined ? (
        <Histogram bins={f.histogram} label={f.column ?? ""} width={220}
                   fences={{ low: f.low, high: f.high }} />
      ) : <span />}
      <div className="flex items-center gap-3 justify-self-end">
        <span className="text-ink-2">
          <strong className="text-ink">{formatCount(f.count)}</strong> {f.count === 1 ? "row" : "rows"}
        </span>
        <Button onClick={onShow} disabled={f.count === 0}>
          Show these rows <Icon name="right" size={14} />
        </Button>
      </div>
    </li>
  );
}

function Detail({ finding: f, check }: { finding: Finding; check: OutlierCheck }) {
  const cls = "text-[12px] text-ink-2";
  if (check === "extremes" && f.low !== undefined && f.high !== undefined) {
    return (
      <p className={cls}>
        {formatCount(f.below)} below {formatValue(f.low)} · {formatCount(f.above)} above{" "}
        {formatValue(f.high)}
      </p>
    );
  }
  if (check === "rare" && Array.isArray(f.values)) {
    const shown = f.values.slice(0, 6);
    return (
      <p className={cls}>
        {shown.map((v) => `${formatValue(v.value)} ×${v.count}`).join(" · ")}
        {(f.total_values ?? 0) > shown.length && ` · and ${formatCount((f.total_values ?? 0) - shown.length)} more`}
      </p>
    );
  }
  if (check === "duplicates" && f.worst) {
    return (
      <p className={cls}>
        Most repeated: {formatValue(f.worst.value)} ({f.worst.count} times)
      </p>
    );
  }
  if (check === "missing" && f.pct !== undefined) {
    return <p className={cls}>{f.pct.toLocaleString()}% of rows</p>;
  }
  return null;
}
