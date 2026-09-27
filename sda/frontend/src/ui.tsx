import { useId, useLayoutEffect, useRef, useState } from "react";
import type {
  InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, SVGProps,
} from "react";

/**
 * Primitives for the Data Cleaver brand: Roboto Slab headings, pill keys,
 * rounded plates on paper, one filled key. Every colour comes from a token. Signal colours carry
 * one job each -- green current, amber worth a look, red stale or refused,
 * blue references -- and no state is signalled by colour alone.
 */

// ----------------------------------------------------------------------
// Icons: one authored set, 16px grid, 1.5 stroke, currentColor.
// ----------------------------------------------------------------------
const PATHS = {
  tick: "M3.5 8.5l3 3 6-7",
  stale: "M12.5 5.5A5 5 0 1 0 13 9.5M12.5 2.5v3h-3",
  unknown: "M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12v.01",
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  up: "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  down: "M8 3.5v9M4.5 9L8 12.5 11.5 9",
  left: "M10 3.5L5.5 8l4.5 4.5",
  right: "M6 3.5l4.5 4.5L6 12.5",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  ref: "M6 4h6v6M12 4l-7.5 7.5",
  alert: "M8 2.5l6 11H2zM8 6.5v3.5M8 12v.01",
  // A stop sign: refused, and no way round it.
  stop: "M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5zM5 8h6",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.5V11M8 5v.01",
  // A gear: six teeth around a hub.
  gear: "M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM6.9 1.75h2.2l.35 1.7 1.2.7 1.65-.55 1.1 1.9-1.3 1.15v1.4l1.3 1.15-1.1 1.9-1.65-.55-1.2.7-.35 1.7H6.9l-.35-1.7-1.2-.7-1.65.55-1.1-1.9 1.3-1.15v-1.4L2.6 5.5l1.1-1.9 1.65.55 1.2-.7z",
  // A panel with its sidebar: collapse and expand.
  sidebar: "M2.5 3h11v10h-11zM6 3v10",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: {
  name: IconName; size?: number;
} & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}

// ----------------------------------------------------------------------
export function Button({
  children, onClick, variant = "default", disabled, title, type = "button",
  "aria-label": ariaLabel, "aria-describedby": describedBy,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  // Pills. Primary is the filled key (a Midnight pill); default
  // is an outlined pill; ghost has no edge until hovered.
  const styles = {
    default: "border-line bg-panel text-ink hover:border-edge",
    primary: "border-primary bg-primary text-primary-ink hover:bg-primary-hover hover:shadow-(--shadow-gold)",
    ghost: "border-transparent bg-transparent text-ink-2 hover:bg-well hover:text-ink",
    danger: "border-stop/50 bg-panel text-stop hover:bg-stop-wash",
  }[variant];
  return (
    <button
      type={type}
      aria-label={ariaLabel} aria-describedby={describedBy}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${styles} inline-flex h-9 cursor-pointer items-center gap-1.5
        rounded-full border px-4 text-[13.5px] font-medium whitespace-nowrap
        transition-[background-color,border-color,box-shadow,transform] duration-150 ease-(--ease-detent)
        active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

const fieldBase =
  `h-9 w-full rounded-[10px] border border-edge/70 bg-field px-3 text-[13.5px]
   text-ink outline-none transition-colors duration-150
   placeholder:text-muted hover:border-edge focus:border-ref disabled:opacity-50`;

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldBase} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${fieldBase} ${props.className ?? ""}`} />;
}

export function Label({ children, hint, htmlFor }: {
  children: ReactNode; hint?: string; htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} title={hint}
           className="mb-1.5 block text-[12.5px] font-medium text-ink-2">
      {children}
    </label>
  );
}

/** A plate: content sits on it, set on the window ground. */
export function Card({ children, className = "" }: {
  children: ReactNode; className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-line bg-panel p-5 shadow-(--shadow-plate) ${className}`}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = "muted", title }: {
  children: ReactNode;
  tone?: "muted" | "accent" | "warn" | "danger" | "ok";
  title?: string;
}) {
  const tones = {
    muted: "bg-well text-ink-2",
    accent: "bg-ref-wash text-ref",
    warn: "bg-stop-wash text-stop",
    danger: "bg-stop-wash text-stop ring-1 ring-stop/40",
    ok: "bg-go/10 text-go",
  }[tone];
  return (
    <span title={title}
          className={`inline-flex items-center gap-1 rounded-full ${tones} px-2.5
            text-[12px] leading-5 font-medium whitespace-nowrap`}>
      {children}
    </span>
  );
}

/** A reference to another relation: a small link-key that takes you there. */
export function RefChip({ name, onClick }: { name: string; onClick?: () => void }) {
  const cls = `inline-flex items-center gap-1 rounded-md bg-ref-wash px-1.5
    font-mono text-[12px] leading-6 text-ref`;
  return onClick ? (
    <button type="button" onClick={onClick}
            className={`${cls} cursor-pointer hover:underline`}>
      {name}<Icon name="ref" size={12} />
    </button>
  ) : (
    <span className={cls}>{name}</span>
  );
}

/**
 * An indicator light. It glows in its signal colour, and it is never shown
 * without a word: colour alone states nothing.
 */
function Light({ tone, className = "" }: {
  tone: "go" | "look" | "stop" | "off"; className?: string;
}) {
  const fill = {
    go: "bg-go-lit shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-go-lit)_20%,transparent)]",
    look: "bg-look-lit shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-look-lit)_22%,transparent)]",
    stop: "bg-stop-lit shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-stop-lit)_22%,transparent)]",
    off: "bg-transparent ring-1 ring-edge",
  }[tone];
  return (
    <span aria-hidden="true"
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${fill} ${className}`} />
  );
}

const FRESHNESS = {
  fresh: { light: "go" as const, word: "current", cls: "text-go" },
  stale: { light: "stop" as const, word: "stale", cls: "text-stop font-semibold" },
  unknown: { light: "off" as const, word: "unchecked", cls: "text-muted" },
};

/**
 * Freshness as an indicator light and its word. Stale stays readable: it is
 * marked, never hidden. `compact` keeps the word for screen readers only,
 * for a row that prints it separately.
 */
export function FreshnessMark({ state, compact = false }: {
  state: "fresh" | "stale" | "unknown"; compact?: boolean;
}) {
  const spec = FRESHNESS[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${spec.cls}`}>
      <Light tone={spec.light} />
      <span className={compact ? "sr-only" : ""}>{spec.word}</span>
    </span>
  );
}

/**
 * A printed notice. warn is red (stale, stopped, refused); caution is amber
 * (worth knowing before you act); info is blue (reference).
 */
export function Notice({ tone = "warn", title, children }: {
  tone?: "warn" | "caution" | "info";
  title?: string;
  children: ReactNode;
}) {
  const t = {
    warn: { frame: "bg-stop-wash", ink: "text-stop", icon: "alert" as const },
    caution: { frame: "bg-look-wash", ink: "text-look", icon: "alert" as const },
    info: { frame: "bg-ref-wash", ink: "text-ref", icon: "info" as const },
  }[tone];
  return (
    <div className={`flex gap-2.5 rounded-xl px-4 py-3 ${t.frame}`}>
      <Icon name={t.icon} size={16} className={`mt-0.5 shrink-0 ${t.ink}`} />
      <div className="min-w-0">
        {title && <p className={`font-semibold ${t.ink}`}>{title}</p>}
        <div className="text-ink-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * A segmented switch: a recessed pill track with a raised thumb that slides
 * to the chosen position. `numbered` prints each position's place when the
 * order itself is information, as in the EDA path.
 */
export function Tabs<T extends string>({ tabs, active, onChange, numbered = false,
  label, size = "md" }: {
  tabs: readonly T[];
  active: T;
  onChange: (t: T) => void;
  numbered?: boolean;
  label?: string;
  size?: "md" | "sm";
}) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = track.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [active, tabs]);
  const pad = size === "md" ? "px-4 py-1.5 text-[14px]" : "px-3.5 py-1 text-[13px]";
  const move = (i: number) => onChange(tabs[(i + tabs.length) % tabs.length]);

  return (
    <div ref={track} role="tablist" aria-label={label}
         className="relative inline-flex max-w-full gap-0.5 self-start rounded-full
                    border border-line bg-well p-1">
      {thumb && (
        <span aria-hidden="true"
              style={{ transform: `translateX(${thumb.x - 4}px)`, width: thumb.w }}
              className="absolute top-1 bottom-1 left-1 rounded-full border border-brand bg-panel
                         shadow-(--shadow-lift) transition-[transform,width] duration-200 ease-(--ease-detent)" />
      )}
      {tabs.map((t, i) => {
        const on = t === active;
        return (
          <button
            key={t}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); move(i + 1); }
              if (e.key === "ArrowLeft") { e.preventDefault(); move(i - 1); }
            }}
            className={`relative z-10 inline-flex cursor-pointer items-center gap-2
              rounded-full ${pad} whitespace-nowrap transition-colors duration-150 ${
              on ? "font-semibold text-ink" : "font-medium text-muted hover:text-ink"}`}
          >
            {numbered && (
              // Visual only: a tablist already announces "tab 1 of 4".
              <span aria-hidden="true"
                    className={`inline-flex h-[18px] w-[18px] items-center justify-center
                                rounded-full text-[11px] leading-none font-semibold ${
                                on ? "bg-primary text-primary-ink" : "text-muted ring-1 ring-line"}`}>
                {i + 1}
              </span>
            )}
            {t}
          </button>
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-muted">{children}</p>;
}

/**
 * The action key. It reads "Make it so" (or its voice), with the plain action
 * and its shortcut always visible beside it. Both are inside the button, so
 * the accessible name contains the visible label (WCAG 2.5.3) and says what
 * the control does (2.4.6).
 */
export function RunButton({ onRun, busy, disabled, action = "Run",
  voice = "Make it so", busyVoice = "Making it so…", shortcut = "Ctrl+Enter" }: {
  onRun: () => void; busy?: boolean; disabled?: boolean; action?: string;
  /** The app's voice for this control; the plain action always rides beside it. */
  voice?: string; busyVoice?: string;
  /** The key that also runs it, for assistive tech; null where there is none. */
  shortcut?: string | null;
}) {
  return (
    <button type="button" onClick={onRun} disabled={disabled || busy}
            aria-keyshortcuts={shortcut ? "Control+Enter" : undefined}
            className="inline-flex h-10 cursor-pointer items-center gap-3 rounded-full
                       bg-primary pr-2 pl-5 text-primary-ink transition-[background-color,transform]
                       duration-150 ease-(--ease-detent) hover:bg-primary-hover hover:shadow-(--shadow-gold)
                       active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40">
      <span className="font-(family-name:--font-display) text-[14.5px] font-bold tracking-[0.04em] uppercase">
        {busy ? busyVoice : voice}
      </span>
      <span className="rounded-full bg-primary-ink/15 px-2.5 py-1 text-[11.5px] font-medium">
        {action}
      </span>
    </button>
  );
}

/** An on/off switch, labelled by its visible text. */
export function Switch({ checked, onChange, label, disabled, describedBy }: {
  checked: boolean; onChange: (on: boolean) => void; label: string;
  disabled?: boolean; describedBy?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
            aria-describedby={describedBy}
            onClick={() => onChange(!checked)}
            className="group inline-flex cursor-pointer items-center gap-3 text-[14px] font-medium
                       text-ink disabled:cursor-not-allowed disabled:opacity-50">
      <span aria-hidden="true"
            className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border
              transition-colors duration-150 ease-(--ease-detent) ${
              checked ? "border-primary bg-primary" : "border-edge bg-field"}`}>
        <span className={`absolute h-4 w-4 rounded-full transition-transform duration-200
          ease-(--ease-detent) ${checked
            ? "translate-x-[19px] bg-primary-ink"
            : "translate-x-[3px] bg-muted"}`} />
      </span>
      {label}
      <span className="sr-only">{checked ? " (on)" : " (off)"}</span>
    </button>
  );
}

/**
 * A short explanation that appears on hover or keyboard focus, never on
 * hover alone, and is tied to its trigger for screen readers.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex"
          onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-describedby={id} aria-label={label}
              onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
              onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              className="inline-flex h-7 cursor-help items-center gap-1.5 rounded-full px-2
                         text-[13px] text-muted hover:text-ink">
        <Icon name="info" size={16} />{label}
      </button>
      <span id={id} role="tooltip"
            className={`absolute top-full left-0 z-30 mt-2 w-80 rounded-xl border border-line
              bg-panel p-3.5 text-[13px] leading-relaxed text-ink-2 shadow-(--shadow-pop)
              transition-opacity duration-150 ${open ? "visible opacity-100" : "invisible opacity-0"}`}>
        {children}
      </span>
    </span>
  );
}

/** Ctrl+Enter anywhere inside a form area runs it. */
export function runOnCtrlEnter(run: () => void) {
  return (e: { ctrlKey: boolean; metaKey: boolean; key: string;
               preventDefault: () => void }) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  };
}

/**
 * A findings box that folds to its header line. The heading holds the
 * toggle, so the box is still reachable by heading; the count stays in the
 * header, so a folded box still says what is inside it.
 */
export function Collapsible({ title, meta, about, open, onToggle, tone = "plain",
  headRef, ref, children }: {
  title: ReactNode;
  /** Beside the title, e.g. "3 findings". */
  meta?: ReactNode;
  /** A line under the title: what the box checks. */
  about?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** "focus" washes the header: the box you were sent to. */
  tone?: "plain" | "focus";
  headRef?: Ref<HTMLButtonElement>;
  /** The box itself, e.g. to scroll it into view. */
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const body = useId();
  return (
    <section ref={ref} className="overflow-hidden rounded-lg border border-line">
      <h3>
        <button ref={headRef} type="button" aria-expanded={open} aria-controls={body}
                onClick={onToggle}
                className={`flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left
                            hover:bg-well ${open ? "border-b border-line" : ""} ${
                            tone === "focus" ? "bg-ref-wash" : "bg-casing"}`}>
          <Icon name="right" size={12}
                className={`mt-[5px] shrink-0 text-ink-2 motion-safe:transition-transform ${
                            open ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{title}</span>
            {meta && <span className="font-normal text-ink-2">{" · "}{meta}</span>}
            {about && <span className="block text-[12px] font-normal text-muted">{about}</span>}
          </span>
        </button>
      </h3>
      <div id={body} hidden={!open}>{children}</div>
    </section>
  );
}
