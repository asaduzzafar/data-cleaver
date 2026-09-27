import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api, errorText, formatCount } from "../api";
import { DataGrid, usePagedQuery } from "../DataGrid";
import { FieldWell } from "../fields/FieldWell";
import { GatewayNotice } from "../Gateway";
import { JobStatus, useJob } from "../jobs";
import { Button, Icon, RefChip, RunButton, runOnCtrlEnter } from "../ui";
import type { Column, GatewayReview, Job, QueryResult, Relation } from "../types";

/**
 * Joining relations, with the keys measured before the rows are trusted.
 *
 * The relation you are on is the base; up to three more join onto it (or
 * onto one another). Each step reads as a sentence -- join X onto Y keeping
 * only matches / all of Y / everything / Y with no match, on these keys --
 * and a live key check runs once the keys are complete: real counts, not
 * the planner's guess, because a key that repeats multiplies rows without
 * raising anything.
 */

type JoinType = "inner" | "left" | "full" | "anti";
type Input = {
  relation: string; alias: string; columns: string[];
  join?: { type: JoinType; with: string; on: [string, string][] };
};
type Step = {
  left: string; right: string; left_relation: string; right_relation: string;
  type: JoinType; left_rows: number; right_rows: number; left_distinct: number;
  right_distinct: number; left_nulls: number; right_nulls: number;
  matched_left: number; max_fanout: number; right_unique: boolean;
  estimated_rows: number;
};
type Probe = { steps: Step[]; review: GatewayReview };

const MAX_INPUTS = 4;
const KEEP: Record<JoinType, (base: string) => string> = {
  inner: () => "only rows that match",
  left: (b) => `all of ${b}`,
  full: () => "everything, matched or not",
  anti: (b) => `${b} rows with no match`,
};

/** A short alias the backend accepts: ^[a-z][a-z0-9_]{0,15}$, unique. */
function aliasFor(name: string, taken: string[]) {
  const stem = (name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "")
    || "t").slice(0, 12);
  let a = stem.slice(0, 1);
  for (let i = 2; taken.includes(a); i++) a = i <= stem.length ? stem.slice(0, i) : `${stem}${i}`;
  return a;
}

/** Mirrors the backend: a name selected from two or more inputs is prefixed. */
function outputNames(inputs: Input[], schemas: Record<string, Column[]>) {
  const chosen = inputs.filter((i) => i.join?.type !== "anti").flatMap((i) =>
    (i.columns.length ? i.columns : (schemas[i.relation] ?? []).map((c) => c.name))
      .map((c) => [i.alias, c] as const));
  const n: Record<string, number> = {};
  for (const [, c] of chosen) n[c] = (n[c] ?? 0) + 1;
  return { names: chosen.map(([a, c]) => (n[c] > 1 ? `${a}_${c}` : c)),
           prefixed: Object.values(n).some((k) => k > 1) };
}

const complete = (inputs: Input[]) => inputs.length >= 2 && inputs.slice(1).every(
  (i) => i.join && i.join.on.length > 0 && i.join.on.every(([l, r]) => l && r));

export function JoinTab({ relation, relations, onChanged }: {
  relation: Relation; relations: Relation[]; onChanged: () => void;
}) {
  const [inputs, setInputs] = useState<Input[]>(
    [{ relation: relation.name, alias: aliasFor(relation.name, []), columns: [] }]);
  const names = [...new Set(inputs.map((i) => i.relation))];
  const schemaQs = useQueries({ queries: names.map((n) => ({
    queryKey: ["schema", n],
    queryFn: () => api.get<{ columns: Column[] }>(`/relations/${encodeURIComponent(n)}/schema`),
  })) });
  const schemas: Record<string, Column[]> = Object.fromEntries(
    names.map((n, i) => [n, schemaQs[i]?.data?.columns ?? []]));

  const spec = { inputs };
  const ready = complete(inputs);
  const probe = useJob();
  const run = usePagedQuery(() => ({ mode: "join", join: spec }));
  const [probeError, setProbeError] = useState<string | null>(null);
  const specKey = JSON.stringify(spec);
  // Which join the last key check measured: a check for keys you have since
  // changed is never shown as if it were about the join on screen.
  const [probedKey, setProbedKey] = useState("");

  // Re-measure the keys whenever the join changes and is complete.
  const { start: startProbe } = probe;
  useEffect(() => {
    setProbeError(null);
    if (!ready) return;
    const t = window.setTimeout(() => {
      setProbedKey(specKey);
      void startProbe(() => api.post<Job>("/joins/probe", { join: spec })
        .catch((e) => { setProbeError(errorText(e)); throw e; }));
    }, 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, ready, startProbe]);

  const measured = probe.job?.state === "done" && probedKey === specKey
    ? (probe.job.result as unknown as Probe) : null;
  const result = run.shown
    ? (run.shown.result as QueryResult & { probe: Probe | null }) : null;

  const go = run.run;

  const update = (i: number, next: Input) =>
    setInputs(inputs.map((x, j) => (j === i ? next : x)));
  const addInput = (name: string) => {
    if (!name || inputs.length >= MAX_INPUTS) return;
    const alias = aliasFor(name, inputs.map((i) => i.alias));
    setInputs([...inputs, { relation: name, alias, columns: [],
      join: { type: "inner", with: inputs[inputs.length - 1].alias, on: [["", ""]] } }]);
  };
  const out = outputNames(inputs, schemas);

  return (
    <section aria-label="Join" className="flex flex-col gap-4"
             onKeyDown={runOnCtrlEnter(() => ready && void go(1))}>
      <ol className="flex flex-col gap-3">
        {inputs.map((inp, i) => (
          <InputCard key={inp.alias} index={i} input={inp} inputs={inputs}
                     columns={schemas[inp.relation] ?? []} schemas={schemas}
                     step={measured?.steps[i - 1]}
                     onChange={(n) => update(i, n)}
                     onRemove={i > 0 ? () => setInputs(inputs.filter((_, j) => j !== i)
                       // Anything that joined onto the removed input now joins the base.
                       .map((x) => x.join?.with === inp.alias
                         ? { ...x, join: { ...x.join, with: inputs[0].alias } } : x)) : undefined} />
        ))}
      </ol>

      {inputs.length < MAX_INPUTS && (
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <Icon name="plus" size={14} /> Join another relation
          <select value="" onChange={(e) => addInput(e.target.value)}
                  className="h-8 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-ink">
            <option value="">choose…</option>
            {relations.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </label>
      )}

      {inputs.length > 1 && (
        <p className="text-[13px] text-ink-2">
          <span className="font-semibold text-ink">Result columns · {out.names.length}</span>{" "}
          {out.names.join(", ")}
          {out.prefixed && (
            <span className="text-muted"> — a name chosen from two inputs gets its alias in front.</span>
          )}
        </p>
      )}

      {probeError && <p role="alert" className="text-[13px] text-stop">{probeError}</p>}
      {ready && !measured && !probeError && <JobStatus job={probe.job} />}
      {/* Once Run is refused, the refusal says it all: its findings are the
          key check's own, so the table stays and its notice steps aside. */}
      {measured && <KeyCheck probe={measured} compact={!!run.blocked} />}

      {inputs.length > 1 && (
        <div className="flex items-center gap-3">
          <RunButton onRun={() => void go(1)} busy={run.busy} disabled={!ready} action="Join" />
          {!ready && (
            <span className="text-[12px] text-ink-2">Choose the key columns for every join first.</span>
          )}
        </div>
      )}
      <GatewayNotice review={run.blocked} onDismiss={run.clearBlocked}
                     onConfirm={() => void go(run.page, true)} />
      <JobStatus job={run.job} onCancel={run.cancel} loud={run.loud} />
      {result?.probe && <KeyCheck probe={result.probe} compact />}
      <DataGrid result={result} job={run.shown} canSave onSaved={onChanged}
                onPage={(p) => void go(p, false, false)} />
    </section>
  );
}

function InputCard({ index, input, inputs, columns, schemas, step, onChange, onRemove }: {
  index: number; input: Input; inputs: Input[]; columns: Column[];
  schemas: Record<string, Column[]>; step?: Step;
  onChange: (i: Input) => void; onRemove?: () => void;
}) {
  const base = index === 0;
  const j = input.join;
  const earlier = inputs.slice(0, index).filter((x) => x.join?.type !== "anti");
  const onto = inputs.find((x) => x.alias === j?.with);
  const ontoCols = onto ? schemas[onto.relation] ?? [] : [];
  const setJoin = (patch: Partial<NonNullable<Input["join"]>>) =>
    j && onChange({ ...input, join: { ...j, ...patch } });

  return (
    <li className="overflow-hidden rounded-lg border border-line">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-casing px-3 py-1.5">
        <RefChip name={input.relation} />
        <span className="text-[12px] text-muted">as {input.alias}</span>
        {base ? <span className="text-[12px] text-ink-2">— the base</span> : (
          <>
            <span className="text-[13px] text-ink-2">joins onto</span>
            <select aria-label={`${input.relation} joins onto`} value={j?.with}
                    onChange={(e) => setJoin({ with: e.target.value })}
                    className="h-6 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-[12px]">
              {earlier.map((x) => <option key={x.alias} value={x.alias}>{x.relation} ({x.alias})</option>)}
            </select>
            <span className="text-[13px] text-ink-2">keeping</span>
            <select aria-label={`What ${input.relation}'s join keeps`} value={j?.type}
                    onChange={(e) => setJoin({ type: e.target.value as JoinType })}
                    className="h-6 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-[12px]">
              {(Object.keys(KEEP) as JoinType[]).map((t) => (
                <option key={t} value={t}>{KEEP[t](onto?.relation ?? "the left")}</option>
              ))}
            </select>
          </>
        )}
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${input.relation} from the join`}
                  className="ml-auto cursor-pointer p-0.5 text-muted hover:text-stop">
            <Icon name="close" size={14} />
          </button>
        )}
      </header>
      <div className="flex flex-col gap-3 p-3">
        {!base && j && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[12px] font-semibold text-ink-2">Match on</legend>
            {j.on.map(([l, r], k) => (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <select aria-label={`Key ${k + 1}: column of ${onto?.relation ?? "the left"}`}
                        value={l} onChange={(e) => setJoin({ on: j.on.map((p, x) =>
                          x === k ? [e.target.value, p[1]] : p) })}
                        className="h-8 min-w-40 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-2 text-[13px]">
                  <option value="">choose…</option>
                  {ontoCols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <span aria-hidden="true" className="text-ink-2">=</span>
                <select aria-label={`Key ${k + 1}: column of ${input.relation}`}
                        value={r} onChange={(e) => setJoin({ on: j.on.map((p, x) =>
                          x === k ? [p[0], e.target.value] : p) })}
                        className="h-8 min-w-40 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-2 text-[13px]">
                  <option value="">choose…</option>
                  {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                {j.on.length > 1 && (
                  <button type="button" aria-label={`Remove key ${k + 1}`}
                          onClick={() => setJoin({ on: j.on.filter((_, x) => x !== k) })}
                          className="cursor-pointer p-0.5 text-muted hover:text-stop">
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            ))}
            <div>
              <Button variant="ghost" onClick={() => setJoin({ on: [...j.on, ["", ""]] })}>
                <Icon name="plus" size={12} /> Another key column
              </Button>
            </div>
          </fieldset>
        )}
        {j?.type === "anti" ? (
          <p className="text-[12px] text-muted">
            Keeps only rows with no match here, so {input.relation} adds no columns.
          </p>
        ) : (
          <FieldWell label={`Columns from ${input.relation}`} columns={columns} zones={[{
            id: `cols-${input.alias}`, label: `Columns from ${input.relation}`,
            items: input.columns, onChange: (c) => onChange({ ...input, columns: c }),
            hint: input.columns.length ? "in this order" : "none chosen: all of them",
          }]} />
        )}
        {step && <StepLine step={step} />}
      </div>
    </li>
  );
}

/** One step's measured key quality, in words and numbers. */
function StepLine({ step: s }: { step: Step }) {
  const multiplies = s.type !== "anti" && s.max_fanout > 1;
  return (
    <p className="text-[12px] text-ink-2">
      {formatCount(s.matched_left)} of {formatCount(s.left_rows)} {s.left_relation} rows match
      {" · "}{s.right_unique ? `${s.right_relation}'s key is unique`
        : `${s.right_relation}'s key repeats`}
      {multiplies && <span className="font-semibold text-stop">
        {" · "}up to {s.max_fanout} matches for one key</span>}
      {" · "}about <span className="font-semibold text-ink">{formatCount(s.estimated_rows)}</span> rows out
    </p>
  );
}

/** The whole key check: every step as a row, then what it means. */
function KeyCheck({ probe, compact = false }: { probe: Probe; compact?: boolean }) {
  const cell = "px-2 py-1 text-right";
  return (
    <section aria-label="Key check" className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-[12px]">
          <caption className="border-b border-line bg-casing px-2 py-1 text-left font-semibold text-ink-2">
            Key check{compact ? " for these results" : ""} — counted, not estimated
          </caption>
          <thead>
            <tr className="text-ink-2">
              {["Join", "Rows (left · right)", "Distinct keys", "Blank keys",
                "Left rows matched", "Most matches per key", "Rows out"].map((h, i) => (
                <th key={h} scope="col" className={`${i ? "text-right" : "text-left"} border-b border-line px-2 py-1 font-semibold`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {probe.steps.map((s, i) => (
              <tr key={i}>
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  {s.left_relation} with {s.right_relation} <span className="text-muted">({s.type})</span>
                </th>
                <td className={cell}>{formatCount(s.left_rows)} · {formatCount(s.right_rows)}</td>
                <td className={cell}>{formatCount(s.left_distinct)} · {formatCount(s.right_distinct)}</td>
                <td className={cell}>{formatCount(s.left_nulls)} · {formatCount(s.right_nulls)}</td>
                <td className={cell}>{formatCount(s.matched_left)}</td>
                <td className={`${cell} ${s.max_fanout > 1 && s.type !== "anti" ? "font-semibold text-stop" : ""}`}>
                  {formatCount(s.max_fanout)}
                </td>
                <td className={`${cell} font-semibold`}>{formatCount(s.estimated_rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!compact && probe.review.findings.length > 0 && (
        <GatewayNotice review={probe.review} />
      )}
    </section>
  );
}
