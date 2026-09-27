import { lazy, Suspense, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api, formatCount, formatWhen } from "./api";
import { QueryResults, usePagedQuery } from "./DataGrid";
import { FieldWell } from "./fields/FieldWell";
import { EMPTY_FILTERS, FilterBuilder, toFilters, type FilterGroup } from "./slice/Filters";
import { JoinTab } from "./joins/JoinTab";
import { FindingRows } from "./outliers/FindingRows";
import { OutliersStep } from "./outliers/OutliersStep";
import { PreviewStep } from "./preview/PreviewStep";
import { ProfileStep } from "./profile/ProfileStep";
import { versionKey } from "./jobs";
import {
  FreshnessMark, Notice, RefChip, RunButton, Tabs, runOnCtrlEnter,
} from "./ui";
import type {
  Column, Finding, OutlierCheck, Relation,
} from "./types";

// CodeMirror is a third of the bundle; load it when the SQL tab first opens.
const SqlEditor = lazy(() => import("./sql/SqlEditor").then((m) => ({ default: m.SqlEditor })));

// The EDA path, in the order a data scientist works. Any step opens at any
// time; the order is the suggestion.
const STEPS = ["Profile", "Preview", "Outliers", "Slice & dice"] as const;
type Step = (typeof STEPS)[number];
const DICE = ["Slice", "Pivot", "Join", "SQL"] as const;
type Dice = (typeof DICE)[number];


export function Workspace({ relation, relations, onChanged, onOpen }: {
  relation: Relation;
  relations: Relation[];
  onChanged: () => void;
  onOpen?: (name: string) => void;
}) {
  // Remembered per relation, so switching papers and back keeps your place.
  const [steps, setSteps] = useState<Record<string, Step>>({});
  const step = steps[relation.name] ?? "Profile";
  const go = (s: Step) => {
    setSteps((m) => ({ ...m, [relation.name]: s }));
    if (s === "Slice & dice") setDiced((m) => ({ ...m, [relation.name]: true }));
  };
  // Slice & dice mounts on a relation's first visit, then stays mounted
  // (hidden) while you look at other steps or other relations, so its
  // columns, filters, pivot, SQL and results survive for the session.
  const [diced, setDiced] = useState<Record<string, boolean>>({});
  const desks = relations.filter((r) =>
    diced[r.name] || (r.name === relation.name && step === "Slice & dice"));
  // Arriving at Outliers from a Profile lead brings its check into view.
  const [focus, setFocus] = useState<OutlierCheck | null>(null);
  // Rows opened from an Outliers finding, shown in Slice & dice.
  const [opened, setOpened] = useState<
    { relation: string; finding: Finding; check: OutlierCheck } | null>(null);
  const openedHere = opened?.relation === relation.name ? opened : null;
  return (
    <article aria-label={relation.name}
             className="flex flex-col overflow-hidden rounded-2xl border border-line
                        bg-panel shadow-(--shadow-plate)">
      <PaperHeading relation={relation} relations={relations} onOpen={onOpen} />
      <div className="border-y border-line bg-casing/60 px-5 py-2.5">
        <Tabs tabs={STEPS} active={step} onChange={go} numbered label="Steps" />
      </div>
      <div className="min-w-0 px-6 py-5">
        {step === "Profile" && (
          <ProfileStep relation={relation} onNext={() => go("Preview")}
                       onInvestigate={(check) => { setFocus(check); go("Outliers"); }} />
        )}
        {step === "Preview" && (
          <PreviewStep relation={relation} onNext={() => go("Outliers")} />
        )}
        {step === "Outliers" && (
          <OutliersStep relation={relation} focus={focus}
                        onNext={() => { setFocus(null); go("Slice & dice"); }}
                        onShow={(finding, check) => {
                          setOpened({ relation: relation.name, finding, check });
                          setFocus(null);
                          go("Slice & dice");
                        }} />
        )}
        {step === "Slice & dice" && openedHere && (
          <FindingRows relation={relation.name} finding={openedHere.finding}
                       check={openedHere.check} onChanged={onChanged}
                       onBack={() => { setFocus(openedHere.check); go("Outliers"); }}
                       onClear={() => setOpened(null)} />
        )}
        {/* Keyed by version: a reload or re-cut starts that desk fresh, so
            no result from the old data stays on screen. */}
        {desks.map((r) => (
          <DiceDesk key={versionKey(r)} relation={r} relations={relations}
                    onChanged={onChanged}
                    hidden={r.name !== relation.name || step !== "Slice & dice" || !!openedHere} />
        ))}
      </div>
      <SignOff relation={relation} relations={relations} />
    </article>
  );
}

const fileName = (path: string | null | undefined) =>
  path ? path.split(/[\\/]/).pop() : null;

function PaperHeading({ relation, relations, onOpen }: {
  relation: Relation; relations: Relation[]; onOpen?: (name: string) => void;
}) {
  const source = relation.kind === "source";
  const known = new Set(relations.map((r) => r.name));
  return (
    <header className="flex flex-col gap-3 px-6 pt-5 pb-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-(family-name:--font-display) text-[36px]
                         leading-[1.25] font-bold tracking-[-0.04em]">
            {relation.name}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
            {source ? (
              <>
                <span>Loaded from</span>
                <code className="rounded bg-well px-1.5 py-0.5 text-[12px]"
                      title={relation.csv_path ?? undefined}>
                  {fileName(relation.csv_path) ?? "an unrecorded file"}
                </code>
                {relation.text_cols && (
                  <span title="Forced to text at load, so leading zeros survived.">
                    · IDs kept as text: {relation.text_cols}
                  </span>
                )}
              </>
            ) : (
              <>
                <span>Cut from</span>
                {relation.inputs.length === 0 && (
                  <span className="text-muted">hand-written SQL (no recorded inputs)</span>
                )}
                {relation.inputs.map((name) => (
                  <RefChip key={name} name={name}
                           onClick={known.has(name) && onOpen ? () => onOpen(name) : undefined} />
                ))}
              </>
            )}
          </div>
        </div>
        <Readout relation={relation} />
      </div>
      {relation.staleness === "stale" && (
        <Notice tone="warn" title="This slice is out of date">{relation.note}</Notice>
      )}
      {relation.staleness === "unknown" && relation.kind === "slice" && (
        <Notice tone="info" title="Freshness cannot be checked">
          {relation.note ??
            "No recorded inputs, so there is nothing to compare against."}
        </Notice>
      )}
    </header>
  );
}

/**
 * The readout window: the row count in a recessed display, with the
 * relation's light and its word beside it. The one thing to read first.
 */
function Readout({ relation }: { relation: Relation }) {
  return (
    <div className="flex shrink-0 items-stretch gap-4 rounded-xl border border-brand bg-well px-4 py-2.5
                    shadow-(--shadow-window)">
      <div className="text-right">
        <p className="font-(family-name:--font-display) text-[28px] leading-none font-bold
                      tracking-[-0.02em] text-ink">
          {formatCount(relation.rows)}
        </p>
        <p className="mt-1 text-[12px] text-muted">rows</p>
      </div>
      <div className="w-px bg-line" aria-hidden="true" />
      <div className="flex flex-col justify-center">
        <FreshnessMark state={relation.staleness} />
      </div>
    </div>
  );
}

/** The foot of every panel: provenance stated as a fact. */
function SignOff({ relation, relations }: {
  relation: Relation; relations: Relation[];
}) {
  const dependents = relations.filter((r) => r.inputs.includes(relation.name));
  const source = relation.kind === "source";
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t
                       border-line bg-casing/60 px-6 py-2.5 text-[12px] text-ink-2">
      <FreshnessMark state={relation.staleness} />
      <span>
        {source ? "Loaded" : "Cut"}{" "}
        {formatWhen(source ? relation.loaded_at : relation.created_at)}
        {(source ? relation.loaded_by : relation.owner) &&
          ` by ${source ? relation.loaded_by : relation.owner}`}
      </span>
      {dependents.length > 0 && (
        <span title={dependents.map((d) => d.name).join(", ")}>
          · {dependents.length} {dependents.length === 1 ? "slice" : "slices"} cut from this
        </span>
      )}
      <span className="ml-auto text-muted">
        Rows the parser rejected are not counted here; see Rejected rows.
      </span>
    </footer>
  );
}

/** Slice, Pivot, Join and SQL for one relation. All four stay mounted, so
 *  switching tabs keeps your work. */
function DiceDesk({ relation, relations, onChanged, hidden }: {
  relation: Relation; relations: Relation[]; onChanged: () => void; hidden: boolean;
}) {
  const [dice, setDice] = useState<Dice>("Slice");
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const { data: schema } = useQuery({
    queryKey: ["schema", relation.name],
    queryFn: () => api.get<{ columns: Column[] }>(
      `/relations/${encodeURIComponent(relation.name)}/schema`),
  });
  const columns = schema?.columns ?? [];
  return (
    <div hidden={hidden}
         className="relative -mx-6 -my-5 flex flex-col gap-4 px-6 py-5
                    has-[[data-making-it-so]]:min-h-[600px]">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs tabs={DICE} active={dice} onChange={setDice} label="Slice and dice" size="sm" />
        {/* The active tab's tools sit on this line (Slice puts its filters here). */}
        <div ref={setTools} className="ml-auto" />
      </div>
      <div hidden={dice !== "Slice"}>
        <SliceTab relation={relation} columns={columns}
                  onChanged={onChanged} tools={dice === "Slice" ? tools : null} />
      </div>
      <div hidden={dice !== "Pivot"}>
        <PivotTab relation={relation} columns={columns} onChanged={onChanged} />
      </div>
      <div hidden={dice !== "Join"}>
        <JoinTab relation={relation} relations={relations} onChanged={onChanged} />
      </div>
      <div hidden={dice !== "SQL"}>
        <SqlTab relation={relation} relations={relations} onChanged={onChanged} />
      </div>
    </div>
  );
}

function SliceTab({ relation, columns, onChanged, tools }: {
  relation: Relation; columns: Column[]; onChanged: () => void;
  /** Where the filters render: the dice bar, while Slice is the active tab. */
  tools: HTMLElement | null;
}) {
  const [filters, setFilters] = useState<FilterGroup>(EMPTY_FILTERS);
  const [picked, setPicked] = useState<string[]>([]);
  const [sort, setSort] = useState("");
  const [desc, setDesc] = useState(false);
  // One desk per relation can be mounted at once: ids must not collide.
  const id = useId();
  const q = usePagedQuery(() => ({
    mode: "slice", relation: relation.name,
    columns: picked, sort: sort || null, desc, filters: toFilters(filters),
  }));
  const { run } = q;

  // Once, when the desk opens; the desk is new for each relation version.
  useEffect(() => { void run(1, false, false); /* eslint-disable-next-line */ }, []);

  return (
    <section className="flex flex-col gap-4"
             onKeyDown={runOnCtrlEnter(() => run(1))}>
      {tools && createPortal(
        <FilterBuilder relation={relation.name} columns={columns} group={filters}
                       onChange={setFilters}
                       error={q.job?.state === "error" ? q.job.error : null} />, tools)}

      {/* Laid out as Pivot is: the field list, zones filling its height,
          the action key underneath. Sort is a one-column zone. */}
      <FieldWell label="Slice fields" columns={columns} checks zones={[
        { id: "columns", label: "Columns", items: picked, onChange: setPicked,
          hint: picked.length ? "shown in this order" : "none chosen: every column is shown" },
        { id: "sort", label: "Sort by", max: 1, hint: "optional",
          items: sort ? [sort] : [], onChange: (it) => setSort(it[0] ?? ""),
          extra: (
            <>
              <label htmlFor={`${id}-order`} className="text-[12px] text-ink-2">order</label>
              <select id={`${id}-order`} value={desc ? "desc" : "asc"}
                      onChange={(e) => setDesc(e.target.value === "desc")}
                      className="h-6 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-[12px]">
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </select>
            </>
          ) },
      ]} />
      <div>
        <RunButton onRun={() => run(1)} busy={q.busy} />
      </div>
      <QueryResults q={q} onChanged={onChanged} />
    </section>
  );
}

// ----------------------------------------------------------------------
function PivotTab({ relation, columns, onChanged }: {
  relation: Relation; columns: Column[]; onChanged: () => void;
}) {
  const [rows, setRows] = useState<string[]>([]);
  const [columnField, setColumnField] = useState<string[]>([]);
  const [value, setValue] = useState<string[]>([]);
  const [agg, setAgg] = useState("sum");
  const id = useId();
  const q = usePagedQuery(() => ({
    mode: "pivot", relation: relation.name,
    rows, value: value[0] ?? null, agg, column_field: columnField[0] ?? null,
  }));
  const { run } = q;

  return (
    <section className="flex flex-col gap-4"
             onKeyDown={runOnCtrlEnter(() => run(1))}>
      <FieldWell label="Pivot fields" columns={columns} zones={[
        { id: "rows", label: "Rows", items: rows, onChange: setRows,
          hint: "one line per combination" },
        { id: "cols", label: "Columns", items: columnField, onChange: setColumnField,
          max: 1, hint: "optional: spread one column across" },
        { id: "values", label: "Values", items: value, onChange: setValue, max: 1,
          extra: (
            <>
              <label htmlFor={`${id}-agg`} className="text-[12px] text-ink-2">as</label>
              <select id={`${id}-agg`} value={agg} onChange={(e) => setAgg(e.target.value)}
                      className="h-6 rounded-md border border-edge/80 bg-field shadow-(--shadow-well) px-1 text-[12px]">
                {["sum", "count", "count_distinct", "avg", "min", "max", "median",
                  "stddev"].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </>
          ) },
      ]} />
      <div>
        <RunButton onRun={() => run(1)} busy={q.busy}
                   disabled={rows.length === 0 || value.length === 0} action="Pivot" />
        {(rows.length === 0 || value.length === 0) && (
          <span className="ml-3 text-[12px] text-ink-2">
            Put at least one column in Rows and one in Values.
          </span>
        )}
      </div>
      <QueryResults q={q} onChanged={onChanged} />
    </section>
  );
}

// ----------------------------------------------------------------------
function SqlTab({ relation, relations, onChanged }: {
  relation: Relation; relations: Relation[]; onChanged: () => void;
}) {
  const id = useId();
  const [sql, setSql] = useState(`SELECT * FROM "${relation.name}"`);
  const q = usePagedQuery(() => ({ mode: "sql", relation: relation.name, sql }));
  const { run } = q;

  return (
    <section className="flex flex-col gap-2">
      <h3 id={`${id}-label`} className="text-[12px] font-semibold text-ink-2">
        SQL query
      </h3>
      <p id={`${id}-about`} className="text-[12px] text-ink-2">
        Every source and saved slice can be queried by name, and names
        complete as you type. Reads only: writes, schema changes and
        multiple statements are refused.
      </p>
      {/* Ctrl+Enter is bound inside the editor, so no wrapper handler. */}
      <Suspense fallback={
        <p role="status" className="h-[7.5em] rounded-md border border-edge bg-panel px-3 py-2
                                    text-[12px] text-ink-2">Opening the editor…</p>}>
        <SqlEditor value={sql} onChange={setSql} onRun={() => void run(1)}
                   relations={relations} defaultTable={relation.name}
                   labelledBy={`${id}-label`}
                   describedBy={`${id}-about ${id}-keys`} />
      </Suspense>
      <p id={`${id}-keys`} className="text-[12px] text-muted">
        Tab indents. To leave the editor by keyboard, press Esc, then Tab.
      </p>
      <div className="mt-1">
        <RunButton onRun={() => run(1)} busy={q.busy} action="Run SQL" />
      </div>
      <QueryResults q={q} onChanged={onChanged} />
    </section>
  );
}
