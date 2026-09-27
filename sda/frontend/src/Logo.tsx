import { useId } from "react";

/**
 * The Data Cleaver mark, "the sliced rows": three rows of data cut on the
 * diagonal by a Gold blade, the far side shifted clear. The rows take the
 * theme's ink; the blade is always Gold. The favicon and the Windows icon set
 * the same mark in paper on a Midnight tile.
 */
function Mark({ size = 32, title }: { size?: number; title?: string }) {
  // React's ids carry characters that are unsafe inside url(#...).
  const id = "dc" + useId().replace(/[^A-Za-z0-9_-]/g, "");
  const rows = (
    <>
      <rect x="6" y="14" width="88" height="18" rx="4" />
      <rect x="6" y="41" width="88" height="18" rx="4" />
      <rect x="6" y="68" width="88" height="18" rx="4" />
    </>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role={title ? "img" : undefined}
         aria-hidden={title ? undefined : true} aria-label={title} focusable="false"
         className="shrink-0">
      <defs>
        <clipPath id={`${id}-near`}><path d="M0 0 H62 L38 100 H0 Z" /></clipPath>
        <clipPath id={`${id}-far`}><path d="M70 0 H100 V100 H46 Z" /></clipPath>
      </defs>
      <g clipPath={`url(#${id}-near)`} fill="var(--color-ink, #162236)">{rows}</g>
      <g clipPath={`url(#${id}-far)`} fill="var(--color-ink, #162236)" transform="translate(4 -4)">{rows}</g>
      <path d="M63 2 L69 2 L45 98 L39 98 Z" fill="var(--color-brand, #CEAD66)" />
    </svg>
  );
}

/** The logo: the mark beside DATA over CLEAVER in Roboto Slab ExtraBold.
 *  Folded, the mark stands alone. */
export function Logo({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark size={wordmark ? 34 : 30} />
      {wordmark && (
        <span className="flex flex-col font-(family-name:--font-display) text-[17px] leading-[0.95]
                         font-extrabold tracking-[0.01em] text-side-ink uppercase">
          <span>Data</span>
          <span>Cleaver</span>
        </span>
      )}
    </span>
  );
}
