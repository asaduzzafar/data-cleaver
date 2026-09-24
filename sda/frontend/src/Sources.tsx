import { Fragment, useId, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, formatBytes, formatCount, formatWhen } from "./api";
import { useDesktop } from "./desktop";
import { JobStatus, useJob } from "./jobs";
import {
  Badge, Button, Card, FreshnessMark, Icon, Input, Label, Notice, RunButton,
} from "./ui";
import type { Detection, Job, Listing, LoadResult, Relation } from "./types";

/**
 * Everything that reads `name`, directly or through a chain of slices: what
 * a reload of `name` will leave stale.
 */
export function dependents(name: string, relations: Relation[]): Relation[] {
  const found = new Map<string, Relation>();
  const walk = (n: string) => {
    for (const r of relations) {
      if (r.kind === "slice" && r.inputs.includes(n) && !found.has(r.name)) {
        found.set(r.name, r);
        walk(r.name);
      }
    }
  };
  walk(name);
  return [...found.values()];
}

export function Sources({ relations, selected, onSelect, onChanged, loading, onLoading,
  collapsed = false }: {
  relations: Relation[];
  selected: string | null;
  onSelect: (name: string) => void;
  onChanged: () => void;
  /** The sidebar is folded to icons: only the Load key shows. */
  collapsed?: boolean;
  /** Whether the load panel is open; App owns it so the welcome can open it. */
  loading: boolean;
  onLoading: (open: boolean) => void;
}) {
  const setLoading = onLoading;
  const sources = relations.filter((r) => r.kind === "source");
  const slices = relations.filter((r) => r.kind === "slice");
  // File each slice under the paper it was cut from, source or slice, so a
  // chain reads as a chain. That is its primary parent: the base a join was
  // cut from, not its first input, since inputs come back sorted by name.
  // The other inputs are cited on the row.
  const known = new Set(relations.map((r) => r.name));
  const cutFrom = (r: Relation) =>
    r.source && r.source !== r.name && known.has(r.source) ? r.source
      : r.inputs.find((i) => i !== r.name && known.has(i));
  const childrenOf = (name: string) => slices.filter((r) => cutFrom(r) === name);
  // Roots: every source, and any slice whose parent is gone.
  const roots = [...sources, ...slices.filter((r) => !cutFrom(r))];
  // Branches start open; folding one is remembered while the app is open.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggle = (name: string) => setFolded((was) => {
    const next = new Set(was);
    if (!next.delete(name)) next.add(name);
    return next;
  });

  const branch = (r: Relation, depth: number, seen: Set<string>): ReactNode => {
    const children = seen.has(r.name) ? [] : childrenOf(r.name);
    const open = !folded.has(r.name);
    return (
      <li key={r.name}>
        <RelationRow relation={r} depth={depth} base={cutFrom(r)}
                     active={r.name === selected}
                     onSelect={() => onSelect(r.name)} onChanged={onChanged}
                     slices={children.length}
                     open={open} onToggle={() => toggle(r.name)} />
        {open && children.length > 0 && (
          <ul>
            {children.map((c) => branch(c, depth + 1, new Set([...seen, r.name])))}
          </ul>
        )}
      </li>
    );
  };

  if (collapsed) {
    return (
      <button type="button" onClick={() => setLoading(!loading)} aria-pressed={loading}
              aria-label="Load a CSV" title="Load a CSV"
              className="mx-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded-full
                         bg-primary text-primary-ink hover:bg-primary-hover">
        <Icon name="plus" size={16} />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => setLoading(!loading)} aria-pressed={loading}
              className="inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2
                         rounded-full bg-primary text-[14px] font-semibold text-primary-ink
                         transition-[background-color,box-shadow] duration-150 hover:bg-primary-hover
                         hover:shadow-(--shadow-gold)">
        <Icon name="plus" size={15} />Load a CSV
      </button>

      <nav aria-labelledby="data-sources-h" className="flex flex-col gap-1.5">
        <h2 id="data-sources-h" className="px-2 text-[12.5px] font-medium text-side-muted">
          Your Data Sources
        </h2>
        {relations.length === 0 ? (
          <p className="px-2 text-[13px] leading-relaxed text-side-muted">
            Nothing loaded yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {roots.map((r) => branch(r, 0, new Set()))}
          </ul>
        )}
      </nav>
    </div>
  );
}

/** The load form, in the main area where it has room to breathe. */
export function LoadPanel({ relations, onClose, onDone }: {
  relations: Relation[];
  onClose: () => void;
  /** Called after a load; `view` is the source just loaded, to open it. */
  onDone: (view?: string) => void;
}) {
  return (
    <Card className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="font-(family-name:--font-display) text-[20px] font-semibold tracking-[-0.02em]">
          Load a CSV
        </h2>
        <p className="text-ink-2">
          Pick a file from one of your folders; it becomes a source you can explore.
        </p>
        <div className="ml-auto">
          <Button variant="ghost" onClick={onClose}><Icon name="close" size={14} />Close</Button>
        </div>
      </header>
      <LoadWizard relations={relations} onDone={onDone} />
    </Card>
  );
}

/** An identifier with a line-break opportunity after each underscore. */
const breakable = (name: string) =>
  name.split("_").map((part, i, all) => (
    <Fragment key={i}>{part}{i < all.length - 1 && <>_<wbr /></>}</Fragment>
  ));

/** A root sits at the list's edge; each step down a chain moves 14px in. */
const indent = (depth: number) => 8 + depth * 14;

function RelationRow({ relation, active, onSelect, onChanged, depth = 0, base,
  slices = 0, open = true, onToggle }: {
  relation: Relation; active: boolean;
  onSelect: () => void; onChanged: () => void;
  depth?: number; base?: string;
  /** How many slices are filed directly under this row, and whether they show. */
  slices?: number; open?: boolean; onToggle?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const noteId = useId();
  const others = relation.inputs.filter((i) => i !== base);
  // Every light wears its word: current rides quietly in the tooltip and for
  // screen readers; stale and unchecked are printed, because they ask for action.
  const word = relation.staleness === "stale" ? "stale"
    : relation.staleness === "unknown" ? "unchecked" : null;

  const remove = async () => {
    setError(null);
    try {
      await api.del(`/relations/${encodeURIComponent(relation.name)}`);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className={`group rounded-lg ${
      active ? "bg-side-active text-side-ink ring-1 ring-brand ring-inset" : "text-side-ink hover:bg-side-hover"}`}>
      <div className="flex items-center gap-2 py-1.5 pr-1.5" style={{ paddingLeft: indent(depth) }}
           title={relation.staleness === "fresh" ? "current" : undefined}>
        {depth > 0 && (
          <span aria-hidden="true"
                className="-mt-2 h-3 w-2 shrink-0 rounded-bl-sm border-b border-l border-side-line" />
        )}
        {slices > 0 && (
          <button type="button" onClick={onToggle} aria-expanded={open}
                  aria-label={`${open ? "Hide" : "Show"} ${slices} ${slices === 1 ? "slice" : "slices"} of ${relation.name}`}
                  title={open ? "Hide its slices" : `Show its ${slices} ${slices === 1 ? "slice" : "slices"}`}
                  className="-mx-0.5 inline-flex shrink-0 cursor-pointer rounded p-0.5 text-side-muted
                             hover:text-side-ink">
            <Icon name="right" size={12}
                  className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          </button>
        )}
        {relation.note ? (
          // The note says why: which input moved, and when. A title alone
          // would hide it from keyboard and touch users.
          <button type="button" onClick={() => setWhy(!why)}
                  aria-expanded={why} aria-controls={noteId}
                  title={relation.note}
                  className="inline-flex cursor-pointer items-center">
            <FreshnessMark state={relation.staleness} compact />
            <span className="sr-only"> — why?</span>
          </button>
        ) : (
          <FreshnessMark state={relation.staleness} compact />
        )}
        <button onClick={onSelect} aria-current={active ? "page" : undefined}
                title={`${relation.name} · ${formatCount(relation.rows)} rows`}
                // A name never gives way: a long one wraps to a second line,
                // after an underscore where it can.
                className={`min-w-0 flex-1 cursor-pointer text-left text-[13.5px] leading-snug
                  break-words ${
                  active ? "font-semibold" : ""}`}>
          {breakable(relation.name)}
        </button>
        {word && (
          <span aria-hidden="true" className={`shrink-0 text-[11px] font-semibold ${
            relation.staleness === "stale" ? "text-stop" : "text-side-muted"}`}>
            {word}
          </span>
        )}
        {others.length > 0 && (
          <span className="truncate text-[11px] text-side-muted">+ {others.join(", ")}</span>
        )}
        {!confirming && (
          <button onClick={() => setConfirming(true)}
                  aria-label={`Remove ${relation.name}`}
                  className="cursor-pointer rounded p-0.5 text-side-muted opacity-0 transition-opacity
                             group-hover:opacity-100 hover:text-stop focus-visible:opacity-100">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {/* The question gets its own line, so the name above keeps its width. */}
      {confirming && (
        <div role="group" aria-label={`Remove ${relation.name}?`}
             style={{ paddingLeft: indent(depth) + 4 }}
             className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pr-1.5 pb-2 text-[12px]">
          <span className="text-side-muted">Remove it?</span>
          <button onClick={remove} autoFocus
                  className="cursor-pointer rounded-full bg-stop px-2.5 py-0.5 font-semibold text-panel hover:bg-stop-strong">
            Remove
          </button>
          <button onClick={() => setConfirming(false)}
                  className="cursor-pointer rounded-full px-2 py-0.5 text-side-muted hover:text-side-ink">
            Keep
          </button>
        </div>
      )}
      {why && relation.note && (
        <p id={noteId} style={{ paddingLeft: indent(depth) + 16 }}
           className={`pb-2 pr-3 text-[12px] leading-snug ${
             relation.staleness === "stale" ? "text-stop" : "text-side-muted"}`}>
          {relation.note}
        </p>
      )}
      {error && <p className="px-3 pb-1.5 text-[12px] text-stop">{error}</p>}
    </div>
  );
}

/** Windows paths: either slash, any case. */
const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

function LoadWizard({ relations, onDone }: {
  relations: Relation[];
  /** Closes the panel; `view` is the source just loaded, to open it. */
  onDone: (view?: string) => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [delim, setDelim] = useState(",");
  const [nullstr, setNullstr] = useState("\\N");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [forceText, setForceText] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loader = useJob();
  const id = useId();

  const detect = async (target: string) => {
    setError(null);
    setDetection(null);
    try {
      const body = await api.post<Detection>("/load/detect",
        { path: target, delim, nullstr });
      setDetection(body);
      setForceText(body.suggested_text);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const result = loader.job?.state === "done"
    ? (loader.job.result as LoadResult) : null;
  // Named before the load, while there is still time to change your mind.
  const goingStale = detection?.already_registered
    ? dependents(detection.view_name, relations) : [];

  return (
    <div className="flex flex-col gap-4">
      <FileBrowser onPick={(p) => { setPath(p); void detect(p); }} picked={path} />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] font-semibold text-ink-2">
          How the file is written
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-delim`}>Delimiter</Label>
            <Input id={`${id}-delim`} value={delim} className="w-full font-mono"
                   aria-describedby={`${id}-delim-hint`}
                   onChange={(e) => setDelim(e.target.value)} />
            <p id={`${id}-delim-hint`} className="mt-1 text-[12px] text-muted">
              The character between fields: usually a comma.
            </p>
          </div>
          <div>
            <Label htmlFor={`${id}-null`}>Null marker</Label>
            <Input id={`${id}-null`} value={nullstr} className="w-full font-mono"
                   aria-describedby={`${id}-null-hint`}
                   onChange={(e) => setNullstr(e.target.value)} />
            <p id={`${id}-null-hint`} className="mt-1 text-[12px] text-muted">
              Text that means “no value”. Blank fields load as NULL either way.
            </p>
          </div>
        </div>
        {path && (
          <div>
            <Button onClick={() => void detect(path)}>Read the file again</Button>
          </div>
        )}
      </fieldset>

      {error && <Notice tone="warn" title="Could not read that file">{error}</Notice>}

      {detection && (
        <>
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
            <span>Loads as</span>
            <Badge tone="accent">{detection.view_name}</Badge>
            <span>· {formatBytes(detection.bytes)}</span>
          </p>

          {detection.already_registered && (
            <Notice tone="caution" title={`${detection.view_name} is already loaded`}>
              Last loaded {formatWhen(detection.prior_loaded_at)}
              {detection.prior_csv_path &&
                !samePath(detection.prior_csv_path, detection.path) && (
                  <> from a different file,{" "}
                    <code className="break-all">{detection.prior_csv_path}</code></>
                )}.
              Loading again replaces it.{" "}
              {goingStale.length > 0 ? (
                <>
                  {goingStale.length === 1 ? "This slice reads" : "These slices read"}{" "}
                  the old extract and will be flagged stale:
                  <ul className="mt-1 list-disc pl-5">
                    {goingStale.map((r) => <li key={r.name}><code>{r.name}</code></li>)}
                  </ul>
                </>
              ) : "Nothing has been cut from it, so nothing goes stale."}
            </Notice>
          )}

          <fieldset>
            <legend className="mb-1 text-[12px] font-semibold text-ink-2">
              Keep as text
            </legend>
            <p className="mb-2 text-[12px] text-ink-2">
              An account or order number read as a number loses its leading
              zeros, and nothing puts them back later. Columns that look like
              IDs are ticked for you. Types come from a sample of the first
              rows; the load reads the whole file.
            </p>
            <div className="flex max-h-44 flex-col gap-0.5 overflow-auto border
                            border-line bg-panel p-2">
              {detection.columns.map((c) => (
                <label key={c.name}
                       className="flex cursor-pointer items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={forceText.includes(c.name)}
                         onChange={(e) => setForceText(e.target.checked
                           ? [...forceText, c.name]
                           : forceText.filter((x) => x !== c.name))} />
                  <span>{c.name}</span>
                  <span className="font-mono text-[12px] text-muted">{c.type}</span>
                  {c.suggest_text && <Badge tone="warn">looks like an ID</Badge>}
                </label>
              ))}
            </div>
          </fieldset>

          {!result && (
            <div>
              <RunButton voice="Engage" busyVoice="Engaging…" shortcut={null}
                         action={detection.already_registered ? "Reload" : "Load"}
                         busy={loader.busy}
                         onRun={() => void loader.start(() => api.post<Job>("/load", {
                           path: detection.path, delim, nullstr,
                           force_text: forceText,
                         }))} />
            </div>
          )}
        </>
      )}

      <JobStatus job={loader.job} onCancel={loader.cancel} />

      {result && (
        <Notice tone="info" title={`Loaded ${formatCount(result.rows)} rows as ${result.view_name}`}>
          {result.rejected > 0 ? (
            <>
              {formatCount(result.rejected)} {result.rejected === 1 ? "row was" : "rows were"}{" "}
              rejected by the parser and {result.rejected === 1 ? "is" : "are"} absent
              from that count. Profile lists them under Rejected rows.
            </>
          ) : "Every row parsed cleanly."}
          {result.forced_to_text.length > 0 &&
            ` Kept as text: ${result.forced_to_text.join(", ")}.`}
          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={() => onDone(result.view_name)}>
              Open {result.view_name}
            </Button>
            <Button onClick={() => onDone()}>Close</Button>
          </div>
        </Notice>
      )}
    </div>
  );
}

function FileBrowser({ onPick, picked }: {
  onPick: (path: string) => void; picked: string | null;
}) {
  const [path, setPath] = useState("");
  const heading = useId();
  const { data, error, isPending } = useQuery({
    queryKey: ["files", path],
    queryFn: () => api.get<Listing>(`/files?path=${encodeURIComponent(path)}`),
  });

  if (error) {
    return (
      <Notice tone="warn" title="That folder could not be read">
        {errorText(error)}
      </Notice>
    );
  }

  return (
    <section aria-labelledby={heading}>
      <h3 id={heading} className="mb-1 text-[12px] font-semibold text-ink-2">
        Choose a file
      </h3>
      <div className={`mb-1 truncate text-[12px] text-ink-2 ${data?.path ? "font-mono" : "font-medium"}`}>
        {data?.path || "Your folders"}
      </div>
      <div className="max-h-56 overflow-auto border border-line bg-panel">
        {isPending && <p className="px-3 py-1.5 text-[13px] text-ink-2">Reading…</p>}
        {data?.parent !== null && data !== undefined && (
          <button onClick={() => setPath(data.parent ?? "")}
                  className="block w-full cursor-pointer px-3 py-1 text-left
                             text-[13px] text-ink-2 hover:bg-well">
            <span className="inline-flex items-center gap-1.5"><Icon name="up" size={14} />Up</span>
          </button>
        )}
        {data?.directories.map((d) => (
          <div key={d.path} className="flex items-center hover:bg-well">
            <button onClick={() => setPath(d.path)} disabled={d.present === false}
                    className="block min-w-0 flex-1 cursor-pointer truncate px-3 py-1
                               text-left text-[13px] disabled:cursor-not-allowed
                               disabled:text-muted">
              <span className="inline-flex items-center gap-1.5"><Icon name="folder" size={14} className="text-muted" />{data.root === null ? d.path : d.name}</span>
              {d.present === false && " (missing)"}
            </button>
            {data.root === null && <RemoveFolder path={d.path} />}
          </div>
        ))}
        {data?.files.map((f) => (
          <button key={f.path} disabled={!f.loadable}
                  onClick={() => onPick(f.path)}
                  aria-pressed={f.loadable ? picked === f.path : undefined}
                  title={`${f.name} · modified ${f.modified.replace("T", " ")}`}
                  className={`flex w-full items-center gap-3 px-3 py-1
                    text-left text-[13px] ${
                    !f.loadable ? "cursor-not-allowed text-muted"
                      : picked === f.path ? "cursor-pointer bg-well font-semibold"
                      : "cursor-pointer hover:bg-well"}`}>
            <span className="w-3.5 shrink-0 text-go">
              {picked === f.path && <Icon name="tick" size={14} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="font-mono text-[12px] font-normal text-ink-2">
              {formatBytes(f.bytes)}
            </span>
          </button>
        ))}
        {data && data.directories.length === 0 && data.files.length === 0 && (
          <p className="px-3 py-1.5 text-[13px] text-ink-2">
            {data.root === null ? "No folders added yet." : "This folder is empty."}
          </p>
        )}
      </div>
      {data?.root === null && <AddFolder />}
    </section>
  );
}

/** Adding a folder is how the app gets permission to read it. The desktop
 *  app will offer the native folder picker; this typed path is the fallback. */
function AddFolder() {
  const client = useQueryClient();
  const desktop = useDesktop();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async (chosen: string = path) => {
    setError(null);
    try {
      // Picked or typed, the server validates it the same way.
      await api.post("/folders", { path: chosen });
      setPath("");
      void client.invalidateQueries({ queryKey: ["files"] });
      void client.invalidateQueries({ queryKey: ["health"] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const pick = async () => {
    const chosen = await desktop?.pick_folder();
    if (chosen) await add(chosen);
  };
  return (
    <form className="mt-2 flex flex-col gap-1"
          onSubmit={(e) => { e.preventDefault(); void add(); }}>
      {desktop && (
        <div className="mb-1">
          <Button onClick={() => void pick()}>Choose folder…</Button>
        </div>
      )}
      <label htmlFor="add-folder" className="text-[12px] text-ink-2">
        {desktop ? "Or paste its full path" : "Add a folder (its full path, e.g. C:/Users/you/Documents/exports)"}
      </label>
      <div className="flex gap-2">
        <Input id="add-folder" value={path} onChange={(e) => setPath(e.target.value)} />
        <Button type="submit" disabled={!path.trim()}>Add folder</Button>
      </div>
      {error && <p role="alert" className="text-[12px] text-stop">{error}</p>}
    </form>
  );
}

function RemoveFolder({ path }: { path: string }) {
  const client = useQueryClient();
  const remove = async () => {
    await api.del(`/folders?path=${encodeURIComponent(path)}`);
    void client.invalidateQueries({ queryKey: ["files"] });
    void client.invalidateQueries({ queryKey: ["health"] });
  };
  return (
    <button onClick={() => void remove()} aria-label={`Remove folder ${path}`}
            className="cursor-pointer px-3 py-1 text-[12px] text-ink-2 hover:text-stop">
      Remove
    </button>
  );
}
