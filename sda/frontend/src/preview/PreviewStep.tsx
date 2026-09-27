import { api } from "../api";
import { JobStatus, KeptNote, useKeptJob, useKeptState, versionKey } from "../jobs";
import { ResultGrid } from "../ResultGrid";
import { Button, Icon } from "../ui";
import type { Job, QueryResult, Relation } from "../types";

type Look = "head" | "sample";
type PreviewMeta = {
  kind: Look; size: number; of: number; seed: number | null;
  order: "stored" | "random";
};
const SIZES = [50, 200, 1000];

/**
 * Step 2 of the EDA path: look at some rows.
 *
 * Two honest looks. "First rows as stored" follows the stored order, which
 * is not the CSV's order -- the load does not keep it -- so it is never
 * called the start of the file. "Random sample" is repeatable: the same
 * seed brings back the same rows, and Another sample draws new ones.
 */
export function PreviewStep({ relation, onNext }: {
  relation: Relation; onNext: () => void;
}) {
  // Per relation: coming back shows the same rows the same way.
  const [look, setLook] = useKeptState<Look>(`preview:${relation.name}:look`, "head");
  const [size, setSize] = useKeptState(`preview:${relation.name}:size`, 200);
  const [seed, setSeed] = useKeptState(`preview:${relation.name}:seed`, 1);
  const run = useKeptJob(
    `preview:${versionKey(relation)}:${look}:${size}:${look === "sample" ? seed : ""}`,
    () => api.post<Job>("/query", {
      mode: "preview", relation: relation.name, preview: look,
      seed, page_size: size,
    }));

  const result = run.job?.state === "done"
    ? (run.job.result as QueryResult & { preview: PreviewMeta }) : null;
  const meta = result?.preview;

  return (
    <section aria-label="Preview" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Which rows"
             className="inline-flex overflow-hidden rounded-md border border-edge/80">
          {([["head", "First rows as stored"], ["sample", "Random sample"]] as const)
            .map(([id, text]) => (
              <button key={id} type="button" role="radio" aria-checked={look === id}
                      onClick={() => setLook(id)}
                      className={`h-7 cursor-pointer px-3 text-[13px] ${
                        look === id ? "bg-ink font-semibold text-panel"
                          : "bg-panel text-ink-2 hover:bg-well"}`}>
                {text}
              </button>
            ))}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          Rows
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}
                  className="h-8 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-ink">
            {SIZES.map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
          </select>
        </label>
        {look === "sample" && (
          <Button onClick={() => setSeed((s) => s + 1)} disabled={run.busy}>
            Another sample
          </Button>
        )}
      </div>


      {!result && <JobStatus job={run.job} onCancel={run.cancel} />}
      <KeptNote at={result && run.keptAt} busy={run.busy} onRefresh={run.refresh} verb="Read" />
      {result && (
        <ResultGrid columns={result.columns} rows={result.rows} sortable
                    types={result.types ?? result.columns.map(() => "")}
                    label={meta?.kind === "sample" ? "Random sample of rows"
                                                   : "First rows as stored"} />
      )}

      <div className="flex justify-end">
        <Button onClick={onNext}>
          Next: look for outliers <Icon name="right" size={14} />
        </Button>
      </div>
    </section>
  );
}
