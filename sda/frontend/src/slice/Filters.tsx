import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, formatCount } from "../api";
import { Button, Icon } from "../ui";
import { typeFamily, type Column, type FilterNode } from "../types";

/**
 * The Slice filter builder.
 *
 * Its state is the filter tree the backend compiles: a group of up to five
 * conditions.
 * One level is exposed today; nested groups (M3) can be added to the same
 * shape without rewriting this. Each condition reads as a sentence --
 * column, operator, value -- with operators in words ("more than", not ">")
 * and offered by the column's type.
 */

type Cond = { kind: "cond"; column: string; op: string; value: unknown };
export type FilterGroup = { kind: "group"; combiner: "AND" | "OR"; children: Cond[] };
export const EMPTY_FILTERS: FilterGroup = { kind: "group", combiner: "AND", children: [] };

// [backend operator, words]. The backend's operator set is the contract.
const OPS: Record<string, [string, string][]> = {
  text: [["=", "is"], ["!=", "is not"], ["CONTAINS", "contains"],
         ["STARTS WITH", "starts with"], ["IN", "is one of"], ["NOT IN", "is not one of"],
         ["IS NULL", "is blank"], ["IS NOT NULL", "is not blank"]],
  number: [["=", "equals"], ["!=", "is not"], [">", "more than"], [">=", "at least"],
           ["<", "less than"], ["<=", "at most"], ["BETWEEN", "between"],
           ["IN", "is one of"], ["NOT IN", "is not one of"],
           ["IS NULL", "is blank"], ["IS NOT NULL", "is not blank"]],
  temporal: [["=", "on"], ["<", "before"], [">", "after"], ["BETWEEN", "between"],
             ["IS NULL", "is blank"], ["IS NOT NULL", "is not blank"]],
  boolean: [["=", "is"], ["IS NULL", "is blank"], ["IS NOT NULL", "is not blank"]],
};
const opsFor = (type: string) => OPS[typeFamily(type)] ?? OPS.text;

/** The tree to send, or null when there is nothing to filter on. */
export function toFilters(group: FilterGroup): FilterNode | null {
  return group.children.length ? group : null;
}

/** The most filters a slice takes: past five, a question wants SQL. */
export const MAX_FILTERS = 5;

/** A condition as the sentence it means: "quantity more than 5". */
function sentence(c: Cond, type: string) {
  const words = opsFor(type).find(([op]) => op === c.op)?.[1] ?? c.op;
  if (c.op === "IS NULL" || c.op === "IS NOT NULL") return { words, value: "" };
  const v = Array.isArray(c.value)
    ? c.op === "BETWEEN" ? (c.value as string[]).join(" and ") : (c.value as string[]).join(", ")
    : String(c.value ?? "");
  return { words, value: v };
}

/**
 * The Slice filters, as one control: an "Add a filter" key that opens a
 * pop-up to build a condition, and the applied filters shown above it on
 * hover or keyboard focus, each editable and removable. Up to five.
 */
export function FilterBuilder({ relation, columns, group, onChange, error }: {
  relation: string;
  columns: Column[];
  group: FilterGroup;
  onChange: (g: FilterGroup) => void;
  /** A server refusal; marks the filter whose column it names. */
  error?: string | null;
}) {
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.type ?? "VARCHAR";
  const blank = (): Cond => {
    const col = columns[0];
    return { kind: "cond", column: col?.name ?? "", op: opsFor(col?.type ?? "VARCHAR")[0][0], value: "" };
  };
  // The pop-up edits a draft: a new filter (index = count) or an applied one.
  const [editing, setEditing] = useState<{ index: number; cond: Cond } | null>(null);
  const [peek, setPeek] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const count = group.children.length;
  const full = count >= MAX_FILTERS;
  const blamed = (c: Cond) => !!error && error.includes(`'${c.column}'`);

  const close = () => { setEditing(null); button.current?.focus(); };
  const apply = () => {
    if (!editing) return;
    const children = editing.index < count
      ? group.children.map((c, j) => (j === editing.index ? editing.cond : c))
      : [...group.children, editing.cond];
    onChange({ ...group, children });
    close();
  };
  const remove = (i: number) =>
    onChange({ ...group, children: group.children.filter((_, j) => j !== i) });

  // A click outside the control dismisses the pop-up, as Escape does.
  useEffect(() => {
    if (!editing) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setEditing(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [editing]);

  return (
    <div ref={wrap} className="relative flex items-center gap-2.5"
         onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}
         onFocus={() => setPeek(true)}
         onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPeek(false); }}
         onKeyDown={(e) => { if (e.key === "Escape") { setPeek(false); if (editing) close(); } }}>
      <span className="text-[12.5px] font-medium text-ink-2">Filters</span>
      <button ref={button} type="button" aria-expanded={!!editing} aria-haspopup="dialog"
              aria-label={count ? `Add a filter, ${count} applied` : "Add a filter"}
              disabled={!columns.length}
              onClick={() => setEditing(editing ? null : { index: count, cond: blank() })}
              className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border bg-panel px-4
                text-[13.5px] font-medium text-ink transition-[border-color,box-shadow] duration-150
                hover:border-brand disabled:cursor-not-allowed disabled:opacity-40 ${
                editing || peek ? "border-brand" : "border-line"} ${
                error ? "border-stop" : ""}`}>
        <Icon name="plus" size={14} /> Add a filter
        {count > 0 && (
          <span aria-hidden="true"
                className="rounded-full bg-primary px-1.5 text-[11px] leading-5 font-semibold text-primary-ink">
            {count}
          </span>
        )}
      </button>

      {/* The applied filters, above the key, on hover or focus. */}
      {peek && !editing && count > 0 && (
        <div className="absolute right-0 bottom-full z-30 pb-2">
          <section aria-label="Applied filters"
                   className="w-[360px] rounded-2xl border border-line bg-panel p-3.5 shadow-(--shadow-pop)">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="font-(family-name:--font-display) text-[15px] font-bold">Applied filters</h4>
              {count > 1 && (
                <div role="radiogroup" aria-label="How filters combine"
                     className="ml-auto inline-flex overflow-hidden rounded-full border border-line p-0.5">
                  {([["AND", "Match all"], ["OR", "Match any"]] as const).map(([v, text]) => (
                    <button key={v} type="button" role="radio" aria-checked={group.combiner === v}
                            onClick={() => onChange({ ...group, combiner: v })}
                            className={`h-6 cursor-pointer rounded-full px-2.5 text-[12px] ${
                              group.combiner === v ? "bg-primary font-semibold text-primary-ink"
                                : "text-ink-2 hover:bg-well"}`}>
                      {text}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ol className="flex flex-col gap-1.5">
              {group.children.map((c, i) => {
                const s = sentence(c, typeOf(c.column));
                return (
                  <li key={i} className={`flex items-center gap-1 rounded-lg ${
                    blamed(c) ? "bg-stop-wash ring-1 ring-stop/40" : "bg-well"}`}>
                    <button type="button" onClick={() => setEditing({ index: i, cond: c })}
                            aria-label={`Edit filter ${i + 1}: ${c.column} ${s.words} ${s.value}`.trim()}
                            className="min-w-0 flex-1 cursor-pointer truncate px-2.5 py-1.5 text-left text-[13px]">
                      {c.column} <b className="font-semibold">{s.words}</b> {s.value}
                    </button>
                    <button type="button" onClick={() => remove(i)} aria-label={`Remove filter ${i + 1}`}
                            className="cursor-pointer p-1.5 text-muted hover:text-stop">
                      <Icon name="close" size={13} />
                    </button>
                  </li>
                );
              })}
            </ol>
            {error && <p className="mt-2 text-[12px] text-stop">{error}</p>}
          </section>
        </div>
      )}

      {editing && (
        <FilterPopover relation={relation} columns={columns} index={editing.index}
                       cond={editing.cond} type={typeOf(editing.cond.column)}
                       full={full && editing.index >= count} used={count}
                       error={blamed(editing.cond) ? error : null}
                       onChange={(cond) => setEditing({ ...editing, cond })}
                       onApply={apply} onCancel={close} />
      )}
    </div>
  );
}

function FilterPopover({ relation, columns, index, cond, type, full, used, error,
  onChange, onApply, onCancel }: {
  relation: string; columns: Column[]; index: number; cond: Cond; type: string;
  full: boolean; used: number; error?: string | null;
  onChange: (c: Cond) => void; onApply: () => void; onCancel: () => void;
}) {
  const n = index + 1;
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const editingApplied = index < used;
  return (
    <div role="dialog" aria-label={editingApplied ? `Edit filter ${n}` : "Add a filter"}
         className="absolute top-full right-0 z-40 mt-2 w-[380px] rounded-2xl border border-line
                    bg-panel p-4 shadow-(--shadow-pop)">
      <h4 className="mb-3 font-(family-name:--font-display) text-[15px] font-bold">
        {editingApplied ? `Edit filter ${n}` : "Add a filter"}
      </h4>
      {full ? (
        <p className="text-[13px] text-ink-2">
          Five filters is the most a slice takes. Remove one to add another, or
          write the query in SQL.
        </p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); onApply(); }} className="flex flex-col gap-2">
          <ConditionFields n={n} cond={cond} columns={columns} relation={relation} type={type}
                           onChange={onChange} error={error} firstRef={first} />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[12px] text-muted">
              {editingApplied ? `${used} of ${MAX_FILTERS} filters` : `${used + 1} of ${MAX_FILTERS} filters`}
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button type="submit" variant="primary">{editingApplied ? "Update" : "Apply"}</Button>
            </div>
          </div>
        </form>
      )}
      {full && <div className="mt-3 flex justify-end"><Button onClick={onCancel}>Close</Button></div>}
    </div>
  );
}

function ConditionFields({ n, cond, columns, relation, type, onChange, error, firstRef }: {
  n: number; cond: Cond; columns: Column[]; relation: string; type: string;
  onChange: (c: Cond) => void; error?: string | null;
  firstRef: React.RefObject<HTMLSelectElement | null>;
}) {
  const ops = opsFor(type);
  const fam = typeFamily(type);
  const errId = useId();
  const field = "h-9 w-full rounded-[10px] border bg-field px-3 text-[13.5px] text-ink";
  const border = error ? "border-stop" : "border-edge/70";
  const list = cond.op === "IN" || cond.op === "NOT IN";
  const two = cond.op === "BETWEEN";
  const none = cond.op === "IS NULL" || cond.op === "IS NOT NULL";
  const pair = Array.isArray(cond.value) ? (cond.value as string[]) : ["", ""];
  const inputType = fam === "temporal" ? "date" : "text";

  return (
    <>
      <select ref={firstRef} aria-label={`Column for filter ${n}`} value={cond.column}
              aria-invalid={!!error || undefined}
              aria-describedby={error ? errId : undefined}
              className={`${field} ${border}`}
              onChange={(e) => {
                const next = columns.find((c) => c.name === e.target.value);
                onChange({ kind: "cond", column: e.target.value,
                           op: opsFor(next?.type ?? "VARCHAR")[0][0], value: "" });
              }}>
        {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
      <select aria-label={`Condition for filter ${n}`} value={cond.op}
              className={`${field} border-edge/70`}
              onChange={(e) => {
                const op = e.target.value;
                const nowList = op === "IN" || op === "NOT IN";
                onChange({ ...cond, op, value: nowList ? [] : op === "BETWEEN" ? ["", ""] : "" });
              }}>
        {ops.map(([op, words]) => <option key={op} value={op}>{words}</option>)}
      </select>
      {none ? null : list ? (
        <ValuePicker relation={relation} column={cond.column} n={n}
                     selected={Array.isArray(cond.value) ? (cond.value as string[]) : []}
                     onChange={(v) => onChange({ ...cond, value: v })} />
      ) : two ? (
        <span className="flex items-center gap-2">
          <input aria-label={`From, filter ${n}`} type={inputType} value={pair[0] ?? ""}
                 className={`${field} ${border}`}
                 onChange={(e) => onChange({ ...cond, value: [e.target.value, pair[1] ?? ""] })} />
          <span className="text-ink-2">and</span>
          <input aria-label={`To, filter ${n}`} type={inputType} value={pair[1] ?? ""}
                 className={`${field} ${border}`}
                 onChange={(e) => onChange({ ...cond, value: [pair[0] ?? "", e.target.value] })} />
        </span>
      ) : fam === "boolean" ? (
        <select aria-label={`Value for filter ${n}`} value={String(cond.value ?? "")}
                className={`${field} ${border}`}
                onChange={(e) => onChange({ ...cond, value: e.target.value })}>
          <option value="">choose…</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input aria-label={`Value for filter ${n}`} type={inputType}
               inputMode={fam === "number" ? "decimal" : undefined}
               value={String(cond.value ?? "")}
               className={`${field} ${border}`}
               onChange={(e) => onChange({ ...cond, value: e.target.value })} />
      )}
      {error && <p id={errId} className="text-[12px] text-stop">{error}</p>}
    </>
  );
}

/**
 * Pick values with their counts, searched on the server. The truncation is
 * stated, never silent: in a column with thousands of values, the one you
 * want is often past the first page.
 */
function ValuePicker({ relation, column, selected, onChange, n }: {
  relation: string; column: string; selected: string[];
  onChange: (v: string[]) => void; n: number;
}) {
  const [search, setSearch] = useState("");
  const { data } = useQuery({
    queryKey: ["values", relation, column, search],
    queryFn: () => api.get<{
      values: [unknown, number][]; distinct_total: number; truncated: boolean;
    }>(`/relations/${encodeURIComponent(relation)}/values?column=` +
       `${encodeURIComponent(column)}&search=${encodeURIComponent(search)}`),
    enabled: Boolean(column),
  });
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div className="w-72 overflow-hidden rounded-lg border border-edge/80 bg-field shadow-(--shadow-well)">
      <input aria-label={`Search values of ${column}, filter ${n}`} value={search}
             placeholder={`Search ${column}…`} onChange={(e) => setSearch(e.target.value)}
             className="h-7 w-full border-b border-line bg-panel px-2 text-[13px]
                        outline-none placeholder:text-muted" />
      <ul aria-label={`Values of ${column}`} className="max-h-40 overflow-auto py-0.5">
        {(data?.values ?? []).map(([value, count]) => {
          const v = String(value);
          return (
            <li key={v}>
              <label className="flex cursor-pointer items-center gap-2 px-2 py-0.5
                                text-[13px] hover:bg-well">
                <input type="checkbox" checked={selected.includes(v)} onChange={() => toggle(v)} />
                <span className="min-w-0 flex-1 truncate">{v}</span>
                <span className="text-[12px] text-ink-2">{count.toLocaleString()}</span>
              </label>
            </li>
          );
        })}
        {data && data.values.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-muted">Nothing matches.</li>
        )}
      </ul>
      {data && (
        <p className="border-t border-line px-2 py-1 text-[12px] text-ink-2">
          {selected.length} chosen · {formatCount(data.distinct_total)} values
          {data.truncated && " · showing the most frequent; search for others"}
        </p>
      )}
    </div>
  );
}
