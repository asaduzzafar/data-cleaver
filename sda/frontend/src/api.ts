import type { GatewayReview, Job } from "./types";

/**
 * A refusal from the query gateway, carrying the whole review.
 *
 * The findings and their suggestions are the entire point -- "query refused"
 * on its own tells an analyst nothing about what to do instead.
 */
export class GatewayError extends Error {
  review: GatewayReview;
  constructor(review: GatewayReview) {
    super(review.findings[0]?.title ?? "Query refused");
    this.name = "GatewayError";
    this.review = review;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const raw = await res.text();
    let detail: unknown = raw;
    try {
      detail = JSON.parse(raw).detail ?? raw;
    } catch {
      /* the body was not JSON; show it as-is */
    }
    if (
      detail && typeof detail === "object" &&
      (detail as { error?: string }).error === "gateway"
    ) {
      throw new GatewayError(detail as unknown as GatewayReview);
    }
    throw new Error(
      (typeof detail === "string" ? detail : raw) ||
        `${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

/**
 * Follow a job to completion, reporting every status change.
 *
 * Polled, and each poll reports the queue position afresh: it changes when
 * *another* job finishes, which nothing about this job's own state reveals.
 */
export function followJob(
  id: string,
  onUpdate: (job: Job) => void,
): () => void {
  let stopped = false;
  let timer: number | undefined;

  const poll = async () => {
    if (stopped) return;
    try {
      const job = await api.get<Job>(`/jobs/${id}`);
      if (stopped) return;
      onUpdate(job);
      if (["done", "error", "cancelled"].includes(job.state)) return stop();
    } catch {
      /* transient; the next tick retries */
    }
    timer = window.setTimeout(poll, 700);
  };
  void poll();

  function stop() {
    stopped = true;
    window.clearTimeout(timer);
  }
  return stop;
}

/** Trigger a browser download for a finished export job. */
export function downloadExport(jobId: string) {
  window.location.href = `/api/export/${jobId}/download`;
}

export function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined) {
  return n == null ? "—" : n.toLocaleString();
}

/** "21 Sep 2026, 10:00" -- or "an unknown time", never a plausible guess. */
/** What to show for a caught error. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function formatWhen(iso: string | null | undefined) {
  if (!iso) return "an unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  return d.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
