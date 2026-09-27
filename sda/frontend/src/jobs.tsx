import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, followJob, GatewayError } from "./api";
import { Button, Icon } from "./ui";
import type { GatewayReview, Job, Relation } from "./types";
import makingItSo from "./assets/making-it-so.webp";

/**
 * Run one job at a time and keep its live status.
 *
 * Starting a new job cancels the one it replaces. Without that, a user who
 * adjusts a filter three times leaves two abandoned queries holding slots
 * that everyone else is waiting for.
 */
export function useJob() {
  const [job, setJob] = useState<Job | null>(null);
  // A gateway refusal is not a failed job -- nothing ever ran. It is kept
  // apart so the UI can show the findings and offer to confirm, rather than
  // rendering a red "that query failed" for a query the server declined to
  // start.
  const [blocked, setBlocked] = useState<GatewayReview | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const current = useRef<string | null>(null);
  // Started from the action key (not a page turn or an automatic first
  // run): its wait is shown as the Making it so panel.
  const [loud, setLoud] = useState(false);
  // The last finished result stays on screen while the next one runs, so
  // the page keeps its height and its scroll position.
  const [lastDone, setLastDone] = useState<Job | null>(null);

  const detach = useCallback(() => {
    stop.current?.();
    stop.current = null;
  }, []);

  const cancel = useCallback(async () => {
    const id = current.current;
    detach();
    if (id) {
      try {
        await api.del(`/jobs/${id}`);
      } catch {
        /* already finished */
      }
    }
  }, [detach]);

  const start = useCallback(
    async (submit: () => Promise<Job>, asked = false) => {
      await cancel();
      setLoud(asked);
      setJob(null);
      setBlocked(null);
      try {
        const started = await submit();
        current.current = started.id;
        setJob(started);
        stop.current = followJob(started.id, (j) => {
          // Refused by the gateway while running (a join's fan-out check):
          // nothing failed, a decision is owed -- show it like a block at
          // submission, with its findings and a way to confirm.
          if (j.state === "error" && j.detail?.error === "gateway") {
            setBlocked(j.detail);
            setJob(null);
          } else {
            setJob(j);
            if (j.state === "done") setLastDone(j);
          }
        });
        return started;
      } catch (e) {
        if (e instanceof GatewayError) {
          setBlocked(e.review);
          return null;
        }
        setJob({
          id: "", kind: "query", label: "", state: "error",
          progress: null, error: errorText(e),
          position: 0, ahead: 0, queued_ms: 0, elapsed_ms: 0,
        });
        return null;
      }
    },
    [cancel],
  );

  useEffect(() => detach, [detach]);

  const busy = job?.state === "queued" || job?.state === "running";
  // What to show: this job once it is done; until then, the last result;
  // nothing after a failure, which must not look like the rows it replaced.
  const shown = job?.state === "done" ? job : job?.state === "error" ? null : lastDone;
  return {
    job, start, cancel, busy, blocked, loud, shown,
    clearBlocked: () => setBlocked(null),
    reset: () => { setJob(null); setBlocked(null); setLastDone(null); },
  };
}

/** Which data a result describes: the relation's name and the time it was
 *  last loaded or cut. A reload changes it, so nothing kept outlives it. */
export const versionKey = (r: Relation) =>
  `${r.name}@${(r.kind === "source" ? r.loaded_at : r.created_at) ?? "unknown"}`;

// Finished results for this session, by key. Profile, Preview and Outliers
// read whole relations; running one again on every visit costs a scan and
// a query slot for an answer already on hand.
// ponytail: never pruned; a few KB per result, fine for one session.
const kept = new Map<string, { job: Job; at: Date }>();
// Jobs started under a key and not yet seen to finish. Leaving the tab
// stops watching, not the job: coming back picks the same one up rather
// than starting the scan again.
const pending = new Map<string, string>();
// Settings on a step (which rows, how wide the fences), per relation.
const settings = new Map<string, unknown>();

/** For tests: start each one with nothing kept. */
export const forgetKept = () => {
  kept.clear();
  pending.clear();
  settings.clear();
};

/**
 * useJob, remembered: runs `submit` only when nothing is kept under `key`,
 * so coming back to a relation shows what it showed before. `refresh` runs
 * it again on request. A null key runs nothing.
 */
export function useKeptJob(key: string | null, submit: () => Promise<Job>) {
  const run = useJob();
  const { start } = run;
  // Which job belongs to which key, by job id: while one key's job is
  // being swapped for another's, the old job must not count for the new key.
  const [mine, setMine] = useState<{ key: string; id: string } | null>(null);
  const latest = useRef(submit);
  latest.current = submit;

  const refresh = useCallback(async (override?: () => Promise<Job>) => {
    if (key === null) return null;
    pending.delete(key);
    const started = await start(override ?? (() => latest.current()));
    if (started) {
      pending.set(key, started.id);
      setMine({ key, id: started.id });
    }
    return started;
  }, [key, start]);

  useEffect(() => {
    if (key === null || kept.has(key)) return;
    const id = pending.get(key);
    if (!id) { void refresh(); return; }
    // Rejoin the job this key already started, unless it was cancelled
    // or has expired meanwhile.
    void start(async () => {
      const j = await api.get<Job>(`/jobs/${id}`).catch(() => null);
      const expired = (j?.result as { expired?: boolean } | undefined)?.expired;
      return j && j.state !== "cancelled" && j.state !== "error" && !expired
        ? j : latest.current();
    }).then((j) => {
      if (!j) return;
      pending.set(key, j.id);
      setMine({ key, id: j.id });
    });
  }, [key, refresh, start]);

  const live = key !== null && mine?.key === key && run.job?.id === mine.id
    ? run.job : null;
  if (key !== null && live && ["done", "error", "cancelled"].includes(live.state)) {
    pending.delete(key);
    if (live.state === "done" && kept.get(key)?.job.id !== live.id) {
      kept.set(key, { job: live, at: new Date() });
    }
  }
  const hit = key !== null ? kept.get(key) : undefined;
  // A running refresh shows its status; anything else falls back to what
  // is kept.
  const job = live && live.state !== "done" ? live : hit?.job ?? live;
  return {
    ...run, job, keptAt: hit?.at ?? null, refresh,
    shown: job?.state === "done" ? job : run.shown,
  };
}

/** useState that outlives the step it belongs to, for this session. */
export function useKeptState<T>(key: string, initial: T) {
  const [, redraw] = useState(0);
  const value = settings.has(key) ? (settings.get(key) as T) : initial;
  const set = useCallback((next: T | ((was: T) => T)) => {
    const was = settings.has(key) ? (settings.get(key) as T) : initial;
    settings.set(key, typeof next === "function" ? (next as (w: T) => T)(was) : next);
    redraw((n) => n + 1);
    // `initial` is only the first value; later ones are ignored.
  }, [key]);
  return [value, set] as const;
}

/** When a kept result was worked out, and a way to work it out again. */
export function KeptNote({ at, busy, onRefresh, verb }: {
  at: Date | null; busy: boolean; onRefresh: () => void;
  /** Past tense of what produced it: "Profiled", "Checked". */
  verb: string;
}) {
  if (!at) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      {verb} at {at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      <Button variant="ghost" disabled={busy} onClick={() => onRefresh()}
              aria-label={`${verb} at ${at.toLocaleTimeString()}: run again`}>
        <Icon name="stale" size={12} />Run again
      </Button>
    </p>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * The difference between "waiting" and "hung".
 *
 * A spinner cannot tell those apart, so people press Run again and make the
 * queue they are stuck in longer. Naming the position, and offering Cancel
 * while queued, removes the reason to do that.
 */
export function JobStatus({ job, onCancel, loud = false }: {
  job: Job | null;
  onCancel?: () => void;
  /** Show a queued or running job as the Making it so panel, laid over the
   *  nearest positioned ancestor (the Slice & dice area). */
  loud?: boolean;
}) {
  if (!job) return null;
  // States print themselves as a line of text, like a status line on a
  // ledger -- never a spinner, which cannot tell waiting from hung.
  const line = "flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]";
  const cancel = onCancel && (
    <Button variant="ghost" onClick={onCancel}>Cancel</Button>
  );

  if (loud && (job.state === "queued" || job.state === "running")) {
    return (
      <MakingItSo onCancel={onCancel}>
        {job.state === "queued"
          ? `Waiting: ${job.ahead > 0 ? `${job.ahead} ahead of you` : "next to run"} · ${seconds(job.queued_ms)}`
          : `${job.progress ?? "Running"} · ${seconds(job.elapsed_ms)}`}
      </MakingItSo>
    );
  }

  if (job.state === "queued") {
    return (
      <p role="status" className={line}>
        <Icon name="unknown" size={14} className="text-ink-2" />
        <span className="font-semibold">Waiting</span>
        <span className="text-ink-2">
          — {job.ahead > 0 ? `${job.ahead} ahead of you` : "next to run"}
          {job.queue ? ` · ${job.queue.running} of ${job.queue.slots} slots busy` : ""}
          {" · "}queued {seconds(job.queued_ms)}
        </span>
        {cancel}
      </p>
    );
  }

  if (job.state === "running") {
    return (
      <p role="status" className={line}>
        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-trace" />
        <span className="font-semibold">Running</span>
        <span className="text-ink-2">
          — {job.progress ?? "working"} · {seconds(job.elapsed_ms)}
        </span>
        {cancel}
      </p>
    );
  }

  if (job.state === "error") {
    return (
      <div role="alert" className="rounded-lg border border-stop/30 bg-stop-wash px-3.5 py-2.5">
        <p className="font-semibold text-stop">That query failed</p>
        <p className="mt-0.5 font-mono text-[12px] break-all text-ink-2">
          {job.error}
        </p>
      </div>
    );
  }

  if (job.state === "cancelled") {
    return <p role="status" className={`${line} text-ink-2`}>Cancelled.</p>;
  }
  return null;
}

/**
 * The wait after MAKE IT SO: an unimpressed captain over the work area until
 * the rows arrive. The status line and Cancel stay, so waiting and hung are
 * still told apart. Not modal: it covers the controls it would be unsafe to
 * change mid-run, and nothing else.
 */
function MakingItSo({ children, onCancel }: { children: string; onCancel?: () => void }) {
  return (
    <div data-making-it-so className="absolute inset-0 z-20 flex justify-center bg-casing/85
                    backdrop-blur-[2px] motion-safe:animate-[fade-in_160ms_ease-out]">
      <div role="status"
           className="sticky top-6 mt-6 h-fit w-[min(460px,100%)] rounded-2xl border border-brand
                      bg-panel p-4 text-center shadow-(--shadow-plate)">
        <img src={makingItSo} width={792} height={596}
             alt="Captain Picard, unimpressed, gesturing at the wait"
             className="h-auto w-full rounded-[10px]" />
        <p className="mt-4 font-(family-name:--font-display) text-[20px] leading-tight font-extrabold
                      tracking-[0.02em] uppercase">
          Making it so…
        </p>
        <p className="mt-1 text-[14px] text-ink-2">{children}</p>
        {onCancel && (
          <div className="mt-3">
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        )}
      </div>
    </div>
  );
}
