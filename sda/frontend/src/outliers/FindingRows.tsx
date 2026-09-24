import { useEffect } from "react";
import { formatCount } from "../api";
import { DataGrid, usePagedQuery } from "../DataGrid";
import { GatewayNotice } from "../Gateway";
import { JobStatus } from "../jobs";
import { Button, Icon } from "../ui";
import type { Finding, OutlierCheck } from "../types";
import { CHECK_TITLE } from "./OutliersStep";

/**
 * The rows behind one Outliers finding, opened in Slice & dice.
 *
 * It runs the finding's own query -- the one its count was computed from --
 * rather than translating it into editable filters, so the rows always
 * match the count. The banner cites the check it came from, and the result
 * can be saved as a table like any other cut.
 */
export function FindingRows({ relation, finding, check, onBack, onClear, onChanged }: {
  relation: string;
  finding: Finding;
  check: OutlierCheck;
  onBack: () => void;
  onClear: () => void;
  onChanged: () => void;
}) {
  const { job, cancel, blocked, clearBlocked, shown, page, run: go, result } =
    usePagedQuery(() => ({ ...finding.show, relation }));
  // Never the loud panel: these rows open on their own, not from the key.
  const run = (p = 1, confirm = false) => go(p, confirm, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(1); }, [finding, relation]);

  return (
    <section aria-label="Rows from Outliers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ref/25 bg-ref-wash px-3.5 py-2.5">
        <Icon name="ref" size={16} className="shrink-0 text-ref" />
        <p className="min-w-0 flex-1">
          <span className="font-semibold text-ref">
            From Outliers · {CHECK_TITLE[check]}{finding.column ? ` · ${finding.column}` : ""}
          </span>
          <span className="block text-ink-2">
            {finding.summary} — {formatCount(finding.count)} {finding.count === 1 ? "row" : "rows"}.
          </span>
        </p>
        <Button onClick={onBack}><Icon name="left" size={14} /> Back to Outliers</Button>
        <Button variant="ghost" onClick={onClear}>Slice from scratch</Button>
      </div>
      <GatewayNotice review={blocked} onDismiss={clearBlocked}
                     onConfirm={() => run(page, true)} />
      <JobStatus job={job} onCancel={cancel} />
      <DataGrid result={result} job={shown} canSave onSaved={onChanged}
                onPage={(p) => run(p)} />
    </section>
  );
}
