import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";

type Routes = Record<string, unknown | ((init?: RequestInit) => unknown)>;

export const HEALTH = {
  status: "ok", user: "me", duckdb: "1.5.5",
  database: "C:/data/x.duckdb", parquet_dir: "C:/data/parquets",
  folders: [{ path: "C:/data/sample", name: "sample", present: true }],
  memory_limit: "8192MB", threads: 8, query_slots: 2,
  queries: { slots: 2, running: 0, waiting: 0, free: 2 },
  loads: { slots: 1, running: 0, waiting: 0, free: 1 },
  registry: { sources: 1, slices: 0, saved_queries: 0, rejects: 3 },
  catalog_version: "1|0|2026-09-21 10:00:00|",
};

export const ORDERS = {
  name: "sample_orders", kind: "source", rows: 1_000_000,
  loaded_at: "2026-09-21T10:00:00", loaded_by: "me", csv_path: "x.csv",
  parquet_path: "x.parquet", text_cols: "order_id", base: "sample_orders",
  inputs: [], staleness: "fresh", note: null,
};

/** Stub fetch with a map of "/api path (no query)" -> JSON body. Unknown
 *  paths answer 404, so a test fails loudly on a call it did not expect. */
export function fakeApi(routes: Routes) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    if (!(path in routes)) {
      return new Response(JSON.stringify({ detail: `no route ${path}` }),
                          { status: 404 });
    }
    const body = routes[path];
    const value = typeof body === "function" ? body(init) : body;
    return new Response(JSON.stringify(value), {
      status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
