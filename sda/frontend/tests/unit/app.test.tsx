/**
 * Smoke tests: each current screen renders from API data. They assert content
 * and roles, never styling, so they survive visual changes.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../src/App";
import { fakeApi, HEALTH, ORDERS, renderWithClient } from "./fakeApi";

const SCHEMA = { relation: "sample_orders",
                 columns: [{ name: "order_id", type: "VARCHAR" },
                           { name: "amount", type: "DECIMAL(12,2)" }] };

const PROFILE = {
  relation: "sample_orders", rows: 1_000_000, rejected: 3, approx: true,
  columns: [
    { name: "order_id", type: "VARCHAR", family: "text", non_null: 1_000_000,
      null_pct: 0, distinct: 1_000_000, distinct_approx: true, min: null,
      max: null, q1: null, median: null, q3: null, mean: null,
      quartiles_approx: false, histogram: null, top: null },
    { name: "amount", type: "DECIMAL(12,2)", family: "number",
      non_null: 999_600, null_pct: 0.04, distinct: 50_000,
      distinct_approx: true, min: 5, max: 950, q1: 50, median: 120, q3: 300,
      mean: 180, quartiles_approx: true, top: null,
      histogram: [{ lo: 5, hi: 400, count: 900_000 },
                  { lo: 400, hi: 950, count: 99_600 }] },
  ],
  leads: [{ column: "amount", check: "extremes",
            summary: "amount reaches 950, far past its middle half (50–300)" }],
};
const JOB = { id: "p1", kind: "query", label: "profile",
              state: "queued", progress: null, error: null, position: 0,
              ahead: 0, queued_ms: 0, elapsed_ms: 0 };

const FREQ = {
  columns: ["value", "rows"], types: ["DOUBLE", "BIGINT"],
  rows: [[50, 4], [300, 2]], total: 2, page: 1, pages: 1, page_size: 500,
  sql: "", base: "sample_orders", gateway: null, inputs: [], mode: "frequencies",
};
const REFUSAL = { verdict: "block", overridable: true, estimated_rows: 9e9,
                  scanned_rows: 0, operators: [], findings: [{
                    rule: "scan", severity: "block",
                    title: "This reads the whole table",
                    detail: "1.5 GB", suggestions: [] }] };

function baseRoutes(overrides = {}) {
  return {
    "/health": HEALTH,
    "/relations": { relations: [ORDERS] },
    "/relations/sample_orders/schema": SCHEMA,
    "/relations/sample_orders/profile": JOB,
    "/jobs/p1": { ...JOB, state: "done", result: PROFILE },
    "/jobs": { jobs: [] },
    "/files": { root: null, path: "", parent: null, files: [],
                directories: HEALTH.folders },
    ...overrides,
  };
}

describe("App shell", () => {
  it("shows the name and the index, and no welcome box", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    expect(screen.getByRole("heading", { name: "Data Cleaver" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Welcome/ })).not.toBeInTheDocument();
    const index = screen.getByRole("navigation", { name: "Your Data Sources" });
    expect(await within(index).findByText("sample_orders")).toBeInTheDocument();
  });

  it("explains an empty folder list instead of showing nothing", async () => {
    fakeApi(baseRoutes({ "/health": { ...HEALTH, folders: [] },
                         "/relations": { relations: [] } }));
    renderWithClient(<App />);
    expect(await screen.findByText("No folders added yet")).toBeInTheDocument();
  });

  it("flags a folder that went missing", async () => {
    fakeApi(baseRoutes({ "/health": { ...HEALTH, folders: [
      { path: "C:/gone", name: "gone", present: false }] } }));
    renderWithClient(<App />);
    expect(await screen.findByText("A folder has gone missing"))
      .toBeInTheDocument();
  });
});

describe("The EDA path", () => {
  it("offers the steps in order and opens on Profile", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    const steps = await screen.findByRole("tablist", { name: "Steps" });
    expect(within(steps).getAllByRole("tab").map((t) => t.textContent))
      .toEqual(["1Profile", "2Preview", "3Outliers", "4Slice & dice"]);
    expect(within(steps).getByRole("tab", { name: "Profile" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("profiles the relation on open: columns, leads, rejected rows", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    const ledger = await screen.findByRole("table", { name: /Columns of/ });
    expect(within(ledger).getByRole("rowheader", { name: "amount" }))
      .toBeInTheDocument();
    expect(screen.getByText(/far past its middle half/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rejected rows · 3/ }))
      .toBeInTheDocument();
  });

  it("keeps the profile when you come back to it, and runs it again on request", async () => {
    let profiled = 0;
    fakeApi(baseRoutes({
      "/relations/sample_orders/profile": () => { profiled++; return JOB; },
    }));
    renderWithClient(<App />);
    await screen.findByRole("table", { name: /Columns of/ });
    const steps = screen.getByRole("tablist", { name: "Steps" });
    await userEvent.click(within(steps).getByRole("tab", { name: "Preview" }));
    await userEvent.click(within(steps).getByRole("tab", { name: "Profile" }));
    // Straight back, with no second scan.
    expect(screen.getByRole("table", { name: /Columns of/ })).toBeInTheDocument();
    expect(profiled).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: /run again/ }));
    await waitFor(() => expect(profiled).toBe(2));
  });

  it("picks up a profile left running, rather than starting another", async () => {
    let profiled = 0;
    fakeApi(baseRoutes({
      "/relations/sample_orders/profile": () => { profiled++; return JOB; },
      "/jobs/p1": { ...JOB, state: "running" },   // never finishes here
    }));
    renderWithClient(<App />);
    const steps = await screen.findByRole("tablist", { name: "Steps" });
    await waitFor(() => expect(profiled).toBe(1));
    await userEvent.click(within(steps).getByRole("tab", { name: "Preview" }));
    await userEvent.click(within(steps).getByRole("tab", { name: "Profile" }));
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(profiled).toBe(1);
  });

  it("keeps Slice & dice work on each relation while you visit another", async () => {
    const customers = { ...ORDERS, name: "sample_customers" };
    fakeApi(baseRoutes({
      "/relations": { relations: [ORDERS, customers] },
      "/relations/sample_customers/schema": { ...SCHEMA, relation: "sample_customers" },
      "/relations/sample_customers/profile": JOB,
      "/query": { ...JOB, id: "q9" },
      "/jobs/q9": { ...JOB, id: "q9" },   // the opening slice, still queued
    }));
    renderWithClient(<App />);
    const index = screen.getByRole("navigation", { name: "Your Data Sources" });
    const steps = await screen.findByRole("tablist", { name: "Steps" });
    await userEvent.click(within(steps).getByRole("tab", { name: "Slice & dice" }));
    await userEvent.click(screen.getByRole("tab", { name: "Pivot" }));
    await userEvent.selectOptions(screen.getByLabelText("as"), "median");

    await userEvent.click(within(index).getByRole("button", { name: "sample_customers" }));
    await userEvent.click(within(index).getByRole("button", { name: "sample_orders" }));
    // Back on the first relation: still on Pivot, still median.
    expect(screen.getByRole("tab", { name: "Pivot" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("as")).toHaveValue("median");
  });

  it("lists a column's distinct values from its Distinct figure", async () => {
    const posted: Record<string, unknown>[] = [];
    fakeApi(baseRoutes({
      "/query": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return { ...JOB, id: "f1" };
      },
      "/jobs/f1": { ...JOB, id: "f1", state: "done", result: {
        columns: ["value", "rows"], types: ["DOUBLE", "BIGINT"],
        rows: [[50, 4], [300, 2]], total: 2, page: 1, pages: 1, page_size: 500,
        sql: "", base: "sample_orders", gateway: null, inputs: [], mode: "frequencies" } },
    }));
    renderWithClient(<App />);
    const ledger = await screen.findByRole("table", { name: /Columns of/ });
    await userEvent.click(within(ledger).getByRole("button", {
      name: /list the values of amount/ }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({
      mode: "frequencies", relation: "sample_orders", column: "amount" }));
    expect(screen.getByLabelText("Column")).toHaveValue("amount");
    const grid = await screen.findByRole("grid");
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["value", "rows"]);
    expect(screen.queryByRole("button", { name: "Save slice" })).not.toBeInTheDocument();
  });

  it("opens the folded Distinct values box when a Distinct figure is clicked",
     async () => {
    fakeApi(baseRoutes({
      "/query": { ...JOB, id: "f1" },
      "/jobs/f1": { ...JOB, id: "f1", state: "done", result: FREQ },
    }));
    renderWithClient(<App />);
    const fold = await screen.findByRole("button", { name: /^Distinct values/ });
    await userEvent.click(fold);          // the reader folds it away
    expect(fold).toHaveAttribute("aria-expanded", "false");
    const ledger = screen.getByRole("table", { name: /Columns of/ });
    await userEvent.click(within(ledger).getByRole("button", {
      name: /list the values of amount/ }));
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("grid")).toBeVisible();
  });

  it("says when a distinct-values query is refused, and can run it anyway",
     async () => {
    const posted: Record<string, unknown>[] = [];
    fakeApi(baseRoutes({
      "/query": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return { ...JOB, id: posted.length === 1 ? "f1" : "f2" };
      },
      "/jobs/f1": { ...JOB, id: "f1", state: "error", error: "Refused",
                    detail: { error: "gateway", ...REFUSAL } },
      "/jobs/f2": { ...JOB, id: "f2", state: "done", result: FREQ },
    }));
    renderWithClient(<App />);
    const ledger = await screen.findByRole("table", { name: /Columns of/ });
    await userEvent.click(within(ledger).getByRole("button", {
      name: /list the values of amount/ }));
    expect(await screen.findByText("This reads the whole table")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run it anyway" }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({
      mode: "frequencies", column: "amount", confirm_expensive: true }));
    expect(await screen.findByRole("grid")).toBeInTheDocument();
  });

  it("draws each distribution as one focusable figure with a text summary",
     async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    const fig = await screen.findByRole("img", { name: /Distribution of amount/ });
    expect(fig).toHaveAttribute("tabindex", "0");
  });

  it("follows a lead into Outliers", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button",
                                                  { name: /Numeric extremes/ }));
    const steps = screen.getByRole("tablist", { name: "Steps" });
    expect(within(steps).getByRole("tab", { name: "Outliers" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("keeps Slice, Pivot and SQL inside Slice & dice", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("tab", { name: "Slice & dice" }));
    const dice = screen.getByRole("tablist", { name: "Slice and dice" });
    expect(within(dice).getAllByRole("tab").map((t) => t.textContent))
      .toEqual(["Slice", "Pivot", "Join", "SQL"]);
  });
});

describe("Slice & dice keeps your work", () => {
  it("keeps Slice's filters while you visit Pivot; the key sits beside the tabs",
     async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("tab", { name: "Slice & dice" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a filter" }));
    await userEvent.type(screen.getByLabelText("Value for filter 1"), "A1");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Add a filter, 1 applied" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Pivot" }));
    expect(screen.queryByRole("button", { name: /Add a filter/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Slice" }));
    expect(screen.getByRole("button", { name: "Add a filter, 1 applied" })).toBeInTheDocument();
  });

  it("keeps the work when you step out to Profile or Preview and back", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("tab", { name: "Slice & dice" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a filter" }));
    await userEvent.type(screen.getByLabelText("Value for filter 1"), "A1");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await userEvent.click(screen.getByRole("tab", { name: "SQL" }));
    for (const step of ["Profile", "Preview"]) {
      await userEvent.click(screen.getByRole("tab", { name: step }));
      expect(screen.queryByRole("tablist", { name: "Slice and dice" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("tab", { name: "Slice & dice" }));
      expect(screen.getByRole("tab", { name: "SQL" })).toHaveAttribute("aria-selected", "true");
    }
    await userEvent.click(screen.getByRole("tab", { name: "Slice" }));
    expect(screen.getByRole("button", { name: "Add a filter, 1 applied" })).toBeInTheDocument();
  });
});

describe("Removing a source", () => {
  it("asks on a line of its own, so the name keeps its width", async () => {
    fakeApi(baseRoutes());
    renderWithClient(<App />);
    const index = await screen.findByRole("navigation", { name: "Your Data Sources" });
    await userEvent.click(await within(index).findByRole("button", { name: "Remove sample_orders" }));
    const ask = within(index).getByRole("group", { name: "Remove sample_orders?" });
    expect(within(ask).getByRole("button", { name: "Remove" })).toHaveFocus();
    await userEvent.click(within(ask).getByRole("button", { name: "Keep" }));
    expect(within(index).queryByRole("group")).not.toBeInTheDocument();
  });
});

describe("Running a query again", () => {
  it("keeps the rows on screen while the next run works", async () => {
    let runs = 0;
    fakeApi(baseRoutes({
      "/query": () => ({ ...JOB, id: ++runs === 1 ? "q1" : "q2" }),
      "/jobs/q1": { ...JOB, id: "q1", state: "done", result: {
        columns: ["order_id"], types: ["VARCHAR"], rows: [["000123"]], total: 1,
        page: 1, pages: 1, page_size: 500, sql: "", base: "sample_orders",
        gateway: null, inputs: ["sample_orders"], mode: "slice" } },
      // The second run never finishes: the first result must stay put.
      "/jobs/q2": { ...JOB, id: "q2", state: "running", elapsed_ms: 400 },
    }));
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("tab", { name: "Slice & dice" }));
    const grid = await screen.findByRole("grid");
    expect(within(grid).getByText("000123")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /make it so/i }));
    await waitFor(() => expect(runs).toBe(2));
    expect(within(await screen.findByRole("grid")).getByText("000123"))
      .toBeInTheDocument();
  });
});

describe("Settings", () => {
  const routes = (over = {}) => baseRoutes({
    "/admin/backups": { root: "C:/data/backups", backups: [] },
    "/admin/storage": { database_dir: "C:/data", parquet_dir: "C:/data/parquets",
                        changeable: true },
    "/sample": { state: "installed", enabled: true, error: null,
                 removes: { sources: ["sample_orders"], slices: ["big"] } },
    ...over,
  });

  it("opens from the gear item at the foot of the sidebar", async () => {
    fakeApi(routes());
    renderWithClient(<App />);
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    await userEvent.click(within(side).getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Settings" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("shows where data is kept and the machine-sized memory, and never says DuckDB",
     async () => {
    fakeApi(routes());
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByText("C:/data/parquets")).toBeInTheDocument();
    expect(screen.getByText(/8 GB · 8 threads/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/duckdb/i);
  });

  it("explains the backup on hover or focus, not in a paragraph", async () => {
    fakeApi(routes());
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const tip = await screen.findByRole("button", { name: "What this does and does not cover" });
    expect(tip).toHaveAccessibleDescription(/registry and every saved slice/);
    expect(screen.getByRole("button", { name: "Back up now" })).toBeInTheDocument();
  });

  it("asks before the demo switch removes anything, and names what goes", async () => {
    const calls: string[] = [];
    fakeApi(routes({ "/sample": (init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      const on = !calls.includes("DELETE");
      return { state: on ? "installed" : "not_installed", enabled: on, error: null,
               removes: { sources: on ? ["sample_orders"] : [], slices: on ? ["big"] : [] } };
    } }));
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const sw = await screen.findByRole("switch", { name: /Enable demo data/ });
    await screen.findByText(/generated sample/);
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(calls).not.toContain("DELETE");                // nothing yet
    expect(screen.getByText("big")).toBeInTheDocument();  // the slice is named
    await userEvent.click(screen.getByRole("button", { name: "Remove the demo data" }));
    expect(calls).toContain("DELETE");
    expect(await screen.findByRole("switch", { name: /Enable demo data/ }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("changes a folder with the Windows picker in the desktop app", async () => {
    const posted: unknown[] = [];
    fakeApi(routes({ "/admin/storage": (init?: RequestInit) => {
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
      return { database_dir: "C:/data", parquet_dir: "C:/data/parquets", changeable: true };
    } }));
    window.pywebview = { api: { pick_folder: async () => "D:/new" } };
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Change the database folder" }));
    expect(posted).toEqual([{ database_dir: "D:/new" }]);
  });
});

describe("The sidebar", () => {
  it("folds to icons and remembers it", async () => {
    fakeApi(baseRoutes());
    const first = renderWithClient(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" }));
    expect(screen.queryByRole("heading", { name: "Your Data Sources" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load a CSV" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    first.unmount();
    renderWithClient(<App />);
    expect(screen.getByRole("button", { name: "Expand the sidebar" }))
      .toHaveAttribute("aria-expanded", "false");
  });
});

describe("Adding a folder", () => {
  async function openLoadPanel() {
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button",
                                                  { name: /Load a CSV/ }));
  }

  it("in a browser, takes a typed path", async () => {
    fakeApi(baseRoutes());
    await openLoadPanel();
    expect(await screen.findByLabelText(/Add a folder/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose folder…" }))
      .not.toBeInTheDocument();
  });

  it("in the desktop app, offers the native picker and posts its choice",
     async () => {
    const posted: unknown[] = [];
    fakeApi(baseRoutes({ "/folders": (init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return { folders: [], added: "C:/picked" };
    } }));
    window.pywebview = { api: { pick_folder: async () => "C:/picked" } };
    await openLoadPanel();
    await userEvent.click(await screen.findByRole("button",
                                                  { name: "Choose folder…" }));
    expect(posted).toEqual([{ path: "C:/picked" }]);
  });
});

describe("The index", () => {
  it("files a saved join under its base, citing the other input", async () => {
    const join = { ...ORDERS, name: "orders_with_segment", kind: "slice",
                   source: "sample_orders", base: "sample_orders",
                   inputs: ["sample_customers", "sample_orders"] };   // sorted by name
    const customers = { ...ORDERS, name: "sample_customers" };
    fakeApi(baseRoutes({ "/relations": { relations: [ORDERS, customers, join] } }));
    renderWithClient(<App />);
    const index = screen.getByRole("navigation", { name: "Your Data Sources" });
    const orders = (await within(index).findByRole("button", { name: "sample_orders" }))
      .closest("li")!;
    expect(within(orders).getByRole("button", { name: "orders_with_segment" }))
      .toBeInTheDocument();
    expect(within(orders).getByText("+ sample_customers")).toBeInTheDocument();
  });

  it("files a slice cut from a slice under that slice, however deep", async () => {
    const big = { ...ORDERS, name: "big", kind: "slice", source: "sample_orders",
                  inputs: ["sample_orders"] };
    const bigger = { ...ORDERS, name: "bigger", kind: "slice", source: "big",
                     inputs: ["big"] };
    fakeApi(baseRoutes({ "/relations": { relations: [ORDERS, bigger, big] } }));
    renderWithClient(<App />);
    const index = screen.getByRole("navigation", { name: "Your Data Sources" });
    const bigItem = (await within(index).findByRole("button", { name: "big" }))
      .closest("li")!;
    expect(within(bigItem).getByRole("button", { name: "bigger" })).toBeInTheDocument();
    // Its own parent is not repeated as a "+" citation.
    expect(within(index).queryByText("+ big")).not.toBeInTheDocument();
  });

  it("folds a source's slices away and back", async () => {
    const big = { ...ORDERS, name: "big", kind: "slice", source: "sample_orders",
                  inputs: ["sample_orders"] };
    fakeApi(baseRoutes({ "/relations": { relations: [ORDERS, big] } }));
    renderWithClient(<App />);
    const index = screen.getByRole("navigation", { name: "Your Data Sources" });
    const hide = await within(index).findByRole("button",
      { name: "Hide 1 slice of sample_orders" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(hide);
    expect(within(index).queryByRole("button", { name: "big" })).not.toBeInTheDocument();
    await userEvent.click(within(index).getByRole("button",
      { name: "Show 1 slice of sample_orders" }));
    expect(within(index).getByRole("button", { name: "big" })).toBeInTheDocument();
  });
});
