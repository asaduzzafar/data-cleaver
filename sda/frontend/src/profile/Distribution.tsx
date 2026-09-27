import { useState, type KeyboardEvent, type PointerEvent } from "react";
import type { HistogramBin } from "../types";

/**
 * Small per-column distributions for the Profile step.
 *
 * One series, one hue (--color-trace), no legend: the row names the column.
 * Bars grow from one baseline with a 2px surface gap between them. Every
 * value is also reachable as text -- the row states range and median, and
 * the figure's accessible name summarises the shape -- so the drawing never
 * gates a number. Hover and keyboard give the same readout: the figure is a
 * single tab stop, and arrow keys walk its bins.
 */

const H = 28;
// Bars touch, as a histogram's should: then the only breaks in them are
// the etched quarter rules, which keeps the scale readable when bins are dense.
const GAP = 0;

export function formatValue(v: unknown) {
  if (v === null || v === undefined) return "blank";
  if (typeof v === "number") {
    return Math.abs(v) >= 1000 || Number.isInteger(v)
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : v.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  }
  const s = String(v);
  // Dates and timestamps: drop a midnight time, it is noise at this size.
  return s.replace(/[T ]00:00:00(\.0+)?$/, "");
}

export function Histogram({ bins, label, fences, width: W = 168 }: {
  bins: HistogramBin[]; label: string;
  /** Outlier fences: drawn as rules, and bins wholly past them in the
   *  stronger ink. The values are also stated in text by the caller. */
  fences?: { low: number; high: number };
  width?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const peak = Math.max(1, ...bins.map((b) => b.count));
  const total = bins.reduce((a, b) => a + b.count, 0);
  const slot = W / bins.length;
  const bar = Math.max(1, slot - GAP);
  const busiest = bins.findIndex((b) => b.count === peak);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * bins.length);
    setActive(Math.min(bins.length - 1, Math.max(0, i)));
  };
  const keys = (e: KeyboardEvent<SVGSVGElement>) => {
    const last = bins.length - 1;
    const next = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (next !== undefined) {
      e.preventDefault();
      setActive((a) => Math.min(last, Math.max(0, (a ?? (next > 0 ? -1 : last + 1)) + next)));
    } else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(last); }
    else if (e.key === "Escape") setActive(null);
  };

  const b = active === null ? null : bins[active];
  const lo = Number(bins[0]?.lo), hi = Number(bins[bins.length - 1]?.hi);
  const xOf = (v: number) => hi > lo ? ((v - lo) / (hi - lo)) * W : 0;
  const outside = (b: HistogramBin) => !!fences
    && (Number(b.hi) < fences.low || Number(b.lo) > fences.high);
  const summary = `Distribution of ${label}: ${total.toLocaleString()} values `
    + `from ${formatValue(bins[0]?.lo)} to ${formatValue(bins[bins.length - 1]?.hi)}, `
    + `most between ${formatValue(bins[busiest]?.lo)} and ${formatValue(bins[busiest]?.hi)}. `
    + (fences ? `Fences at ${formatValue(fences.low)} and ${formatValue(fences.high)}. ` : "")
    + "Use the arrow keys to read each bin.";

  return (
    <div className="relative">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label={summary} tabIndex={0} className="graticule block cursor-crosshair rounded-sm"
           onPointerMove={pick} onPointerLeave={() => setActive(null)}
           onKeyDown={keys} onBlur={() => setActive(null)}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5}
              className="stroke-line" strokeWidth={1} />
        {bins.map((bin, i) => {
          const h = bin.count ? Math.max(1.5, (bin.count / peak) * (H - 3)) : 0;
          return (
            <rect key={i} x={i * slot + GAP / 2} y={H - 1 - h} width={bar}
                  height={h}
                  className={i === active || outside(bin) ? "fill-trace-strong" : "fill-trace"} />
          );
        })}
        {/* The etched quarters run on through the bars as cuts, so the scale
            stays readable where the bars are dense. */}
        {[0.25, 0.5, 0.75].map((q) => (
          <line key={q} x1={q * W} x2={q * W} y1={0} y2={H - 1}
                stroke="var(--color-panel)" strokeWidth={1.5} />
        ))}
        {fences && [fences.low, fences.high].map((f, i) =>
          f >= lo && f <= hi ? (
            <line key={i} x1={xOf(f)} x2={xOf(f)} y1={0} y2={H}
                  className="stroke-ink-2" strokeWidth={1} />
          ) : null)}
      </svg>
      {b && (
        // Values lead, labels follow (dataviz: tooltip hierarchy).
        <div role="status"
             className="pointer-events-none absolute bottom-full left-0 z-20 mb-1
                        border border-line bg-panel px-2 py-1 text-[12px]
                        whitespace-nowrap">
          <span className="font-semibold text-ink">{b.count.toLocaleString()}</span>{" "}
          <span className="text-ink-2">
            {b.count === 1 ? "value" : "values"} from {formatValue(b.lo)} to {formatValue(b.hi)}
          </span>
        </div>
      )}
    </div>
  );
}

/** The most common values of a text column, as short bars with counts. */
export function TopValues({ top, total, label }: {
  top: { value: unknown; count: number }[]; total: number; label: string;
}) {
  return (
    <ul aria-label={`Most common values of ${label}`} className="flex flex-col gap-0.5">
      {top.slice(0, 3).map((t, i) => (
        <li key={i} className="grid grid-cols-[minmax(0,6.5rem)_4.5rem_auto] items-center gap-2
                               text-[12px] leading-4">
          <span className="truncate text-ink" title={String(t.value)}>
            {formatValue(t.value)}
          </span>
          {/* Share of all values, on a 0-100% track with the etched quarter
              scale, so a 1% value reads as 1%, never as a full bar. */}
          <span aria-hidden="true" className="graticule h-2 overflow-hidden rounded-sm bg-well/70">
            <span className="block h-full bg-trace"
                  style={{ width: `${total ? Math.max(1.5, (100 * t.count) / total) : 0}%` }} />
          </span>
          <span className="text-ink-2">
            {total ? `${((100 * t.count) / total).toLocaleString(undefined,
              { maximumFractionDigits: 1 })}%` : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}
