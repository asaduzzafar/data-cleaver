import {
  useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { typeFamily } from "./types";
import { Icon } from "./ui";

/**
 * The result grid: an ARIA grid over a virtualised page of rows.
 *
 * One tab stop. Focus stays on the grid and moves between cells through
 * aria-activedescendant; the active row is scrolled into view before it is
 * referenced, so the element always exists. Arrows move a cell, Home/End go
 * to the row's ends, Ctrl+Home/End to the first and last cell, PgUp/PgDn by
 * a screenful.
 *
 * Column widths come from each column's type and header, never from the
 * page's contents, so they hold still when you page. A column can be made
 * wider or narrower: drag its header's right edge, double-click the edge to
 * fit what is shown, or press Alt with the left or right arrow on a cell. Numbers right-align by
 * type: a zero-padded ID is text, and stays left. NULL and an empty string
 * look different, because they are different.
 */

const ROW = 26;
const HEADER = 40;
const MIN_W = 56;
const MAX_W = 900;
const clampW = (w: number) => Math.round(Math.max(MIN_W, Math.min(MAX_W, w)));

function widthFor(name: string, type: string) {
  const fam = typeFamily(type);
  const byType = fam === "number" ? 104 : fam === "temporal"
    ? (/TIMESTAMP/i.test(type) ? 168 : 104) : fam === "boolean" ? 80 : 132;
  const byHeader = Math.min(280, name.length * 7.5 + 28);
  return Math.round(Math.max(byType, byHeader));
}

/** A binary float carries ~15-17 significant digits; anything past 15 is
 *  noise from arithmetic (a sum shows 1733821.7999999998 for 1733821.8).
 *  DECIMAL arrives as an exact string and is never touched. */
const FLOAT = /^(DOUBLE|FLOAT|REAL)/i;
function display(v: unknown, type: string) {
  if (typeof v === "number" && FLOAT.test(type) && !Number.isInteger(v)) {
    return String(Number(v.toPrecision(15)));
  }
  return String(v);
}

function Value({ v, type }: { v: unknown; type: string }) {
  if (v === null || v === undefined) {
    return <span className="text-muted italic">null</span>;
  }
  if (v === "") {
    return <span className="text-muted" title="empty text">""</span>;
  }
  return <>{display(v, type)}</>;
}

type Sort = { col: number; dir: "ascending" | "descending" } | null;

/** Order two cells: numbers numerically (DECIMAL arrives as a string),
 *  everything else as text; blanks always last, whichever direction. */
function compare(a: unknown, b: unknown, numeric: boolean) {
  const blank = (v: unknown) => v === null || v === undefined;
  if (blank(a) || blank(b)) return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1;
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function ResultGrid({ columns, types, rows: given, label, sortable = false }: {
  columns: string[]; types: string[]; rows: unknown[][]; label: string;
  /** Sort by clicking a column head -- the rows shown only, client-side. */
  sortable?: boolean;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const rows = useMemo(() => {
    if (!sort) return given;
    const num = typeFamily(types[sort.col] ?? "") === "number";
    const out = [...given].sort((x, y) => compare(x[sort.col], y[sort.col], num));
    if (sort.dir === "descending") {
      // Reverse the non-blank run only: blanks stay last.
      const firstBlank = out.findIndex((r) => r[sort.col] === null || r[sort.col] === undefined);
      const cut = firstBlank === -1 ? out.length : firstBlank;
      return [...out.slice(0, cut).reverse(), ...out.slice(cut)];
    }
    return out;
  }, [given, sort, types]);
  const cycle = (col: number) => setSort((s) =>
    !s || s.col !== col ? { col, dir: "ascending" }
      : s.dir === "ascending" ? { col, dir: "descending" } : null);
  const scroller = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  const id = useId();
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  // Widths the user set by hand, by column name; kept across pages and
  // re-runs of the same columns, forgotten when the columns change.
  const [custom, setCustom] = useState<Record<string, number>>({});
  const columnsKey = columns.join("\u0000");
  useEffect(() => { setCustom({}); }, [columnsKey]);
  const widths = columns.map((c, i) => custom[c] ?? widthFor(c, types[i] ?? ""));
  const resize = (i: number, w: number) =>
    setCustom((m) => ({ ...m, [columns[i]]: clampW(w) }));
  // Fit to the header and the rows on this page (about 7.5px a character).
  const fit = (i: number) => {
    let chars = columns[i].length;
    for (const row of rows) {
      const v = row[i];
      chars = Math.max(chars, v === null || v === undefined ? 4 : display(v, types[i] ?? "").length);
    }
    resize(i, chars * 7.5 + 28);
  };
  const drag = (i: number, e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX, from = widths[i];
    const onMove = (m: PointerEvent) => resize(i, from + m.clientX - start);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const template = widths.map((w) => `${w}px`).join(" ");
  const total = widths.reduce((a, b) => a + b, 0);
  // How many columns sit past the right edge until scrolled to: said in
  // words under the grid, since a clipped column gives no cue of its own.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      let x = 0, fit = 0;
      for (const w of widths) { if (x + w <= el.clientWidth + 1) { x += w; fit += 1; } else break; }
      setHidden(widths.length - fit);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // widths is derived from columns and types
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, widths.length]);
  const numeric = types.map((t) => typeFamily(t) === "number");

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
    // Assumed until the first measurement, so the first paint already has
    // rows (and so does a test environment with no layout at all).
    initialRect: { width: 1200, height: 600 },
  });

  // A new page starts at its first cell, unsorted.
  useEffect(() => { setActive([0, 0]); setSort(null); }, [given]);

  const [r, c] = active;
  const move = (nr: number, nc: number) => {
    const row = Math.max(0, Math.min(rows.length - 1, nr));
    const col = Math.max(0, Math.min(columns.length - 1, nc));
    setActive([row, col]);
    virtual.scrollToIndex(row, { align: "auto" });
  };
  const perScreen = Math.max(1, Math.floor(((scroller.current?.clientHeight ?? 400)
    - HEADER) / ROW) - 1);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      resize(c, widths[c] + (e.key === "ArrowRight" ? 24 : -24));
      return;
    }
    const plan: Record<string, () => void> = {
      ArrowDown: () => move(r + 1, c),
      ArrowUp: () => move(r - 1, c),
      ArrowRight: () => move(r, c + 1),
      ArrowLeft: () => move(r, c - 1),
      Home: () => move(ctrl ? 0 : r, 0),
      End: () => move(ctrl ? rows.length - 1 : r, columns.length - 1),
      PageDown: () => move(r + perScreen, c),
      PageUp: () => move(r - perScreen, c),
      ...(sortable ? { s: () => cycle(c), S: () => cycle(c) } : {}),
    };
    if (plan[e.key]) {
      e.preventDefault();
      plan[e.key]();
    }
  };

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-line px-3 py-8 text-center text-muted">
        No rows matched.
      </p>
    );
  }

  const cellId = (row: number, col: number) => `${id}-r${row}-c${col}`;

  return (
    <>
    <p id={`${id}-help`} className="sr-only">
      {sortable && "Press S to sort these rows by the current column; press it again to reverse, and a third time to restore the order. "}
      Press Alt with the left or right arrow to make the current column narrower or wider.
    </p>
    <div ref={scroller} role="grid" aria-label={label} tabIndex={0}
         aria-describedby={`${id}-help`}
         aria-rowcount={rows.length + 1} aria-colcount={columns.length}
         aria-activedescendant={focused ? cellId(r, c) : undefined}
         onKeyDown={keys} onFocus={() => setFocused(true)}
         onBlur={() => setFocused(false)}
         className="relative overflow-auto rounded-lg border border-line bg-panel outline-none
                    focus-visible:outline-2 focus-visible:outline-offset-1
                    focus-visible:outline-ref"
         style={{ maxHeight: "58vh" }}>
      <div style={{ width: total, minWidth: "100%" }}>
        <div role="row" aria-rowindex={1}
             className="sticky top-0 z-10 grid border-b
                        border-edge bg-panel"
             style={{ gridTemplateColumns: template, height: HEADER }}>
          {columns.map((name, i) => (
            <div key={name + i} role="columnheader" aria-colindex={i + 1}
                 aria-sort={sortable ? (sort?.col === i ? sort.dir : "none") : undefined}
                 className={`relative flex flex-col justify-center px-3 leading-tight ${
                   numeric[i] ? "items-end text-right" : ""}`}>
              {sortable ? (
                <button type="button" onClick={() => cycle(i)} tabIndex={-1}
                        className={`flex max-w-full cursor-pointer items-center gap-1
                                    text-[12px] font-semibold text-ink-2 hover:text-ink ${
                                    numeric[i] ? "flex-row-reverse" : ""}`}>
                  <span className="truncate" title={name}>{name}</span>
                  {sort?.col === i && (
                    <Icon name={sort.dir === "ascending" ? "up" : "down"} size={12} />
                  )}
                </button>
              ) : (
                <span className="truncate text-[12px] font-semibold text-ink-2"
                      title={name}>{name}</span>
              )}
              {/* The edge to drag; the keyboard path is Alt+arrows on a cell. */}
              <div aria-hidden="true" title="Drag to resize; double-click to fit"
                   onPointerDown={(e) => drag(i, e)} onDoubleClick={() => fit(i)}
                   className="group/edge absolute top-0 -right-1.5 z-10 flex h-full w-3
                              cursor-col-resize touch-none justify-center">
                <span className="h-full w-px bg-line group-hover/edge:w-0.5 group-hover/edge:bg-ref" />
              </div>
            </div>
          ))}
        </div>
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            // A faint band on every other row holds the eye across a wide table.
            const band = item.index % 2 === 1;
            return (
              <div key={item.key} role="row" aria-rowindex={item.index + 2}
                   className={`absolute left-0 grid w-full hover:bg-ref-wash ${
                     band ? "bg-well/45" : ""}`}
                   style={{ gridTemplateColumns: template, height: ROW,
                            transform: `translateY(${item.start}px)` }}>
                {row.map((v, j) => {
                  const on = focused && item.index === r && j === c;
                  return (
                    <div key={j} id={cellId(item.index, j)} role="gridcell"
                         aria-colindex={j + 1}
                         onMouseDown={() => setActive([item.index, j])}
                         className={`truncate px-3 leading-[26px] ${
                           numeric[j] ? "text-right" : ""} ${
                           on ? "outline-2 -outline-offset-2 outline-ref" : ""}`}>
                      <Value v={v} type={types[j] ?? ""} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
    {hidden > 0 && (
      <p className="mt-1.5 flex items-center justify-end gap-1 text-[12px] text-muted">
        Scroll sideways for {hidden} more {hidden === 1 ? "column" : "columns"}
        <Icon name="right" size={12} />
      </p>
    )}
    </>
  );
}
