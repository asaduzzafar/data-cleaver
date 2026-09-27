/**
 * First run and the load flow: the welcome's ways in, and a load panel that
 * labels its fields and names what a reload will leave stale.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../src/App";
import { dependents } from "../../src/Sources";
import type { Relation } from "../../src/types";
import { fakeApi, HEALTH, ORDERS, renderWithClient } from "./fakeApi";

const FILE = { name: "sample_orders.csv", path: "C:/data/sample/sample_orders.csv",
               bytes: 1024, modified: "2026-09-21T10:00:00", loadable: true };
const DETECTION = {
  path: FILE.path, bytes: 1024, view_name: "sample_orders",
  parquet_name: "sample_orders.parquet",
  columns: [{ name: "order_id", type: "BIGINT", suggest_text: true },
            { name: "amount", type: "DOUBLE", suggest_text: false }],
  suggested_text: ["order_id"], already_registered: true,
  prior_csv_path: FILE.path, prior_loaded_at: "2026-09-20 09:00:00",
};
const slice = (name: string, inputs: string[]): Relation =>
  ({ ...ORDERS, name, kind: "slice", inputs, base: inputs[0] } as Relation);
const BIG = slice("big_orders", ["sample_orders"]);
const BIGGEST = slice("biggest_orders", ["big_orders"]);   // a chain
const OTHER = slice("customer_cut", ["sample_customers"]);

function routes(overrides = {}) {
  return {
    "/health": HEALTH,
    "/relations": { relations: [ORDERS, BIG, BIGGEST, OTHER] },
    "/relations/sample_orders/schema": { relation: "sample_orders", columns: [] },
    "/relations/sample_orders/profile": { id: "p", state: "queued" },
    "/jobs/p": { id: "p", state: "running" },
    "/jobs": { jobs: [] },
    "/files": { root: "C:/data/sample", path: "C:/data/sample", parent: null,
                directories: [], files: [FILE] },
    "/load/detect": DETECTION,
    ...overrides,
  };
}

describe("dependents", () => {
  it("follows chains of slices and ignores unrelated ones", () => {
    expect(dependents("sample_orders", [ORDERS as Relation, BIG, BIGGEST, OTHER])
      .map((r) => r.name)).toEqual(["big_orders", "biggest_orders"]);
  });
});

describe("The load panel", () => {
  async function pickFile() {
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Load a CSV/ }));
    await userEvent.click(await screen.findByRole("button", { name: /sample_orders\.csv/ }));
  }

  it("labels its fields and says blanks load as NULL", async () => {
    fakeApi(routes());
    await pickFile();
    expect(screen.getByLabelText("Delimiter")).toHaveValue(",");
    expect(screen.getByLabelText("Null marker")).toHaveValue("\\N");
    expect(screen.getByLabelText("Null marker"))
      .toHaveAccessibleDescription(/Blank fields load as NULL/);
    expect(await screen.findByRole("checkbox", { name: /order_id/ })).toBeChecked();
  });

  it("names every slice a reload leaves stale, chains included", async () => {
    fakeApi(routes());
    await pickFile();
    const warning = await screen.findByText(/will be flagged stale/);
    const names = within(warning).getAllByRole("listitem").map((li) => li.textContent);
    expect(names).toEqual(["big_orders", "biggest_orders"]);
  });

  it("knows the registry's backslashed path is the same file", async () => {
    fakeApi(routes({ "/load/detect": { ...DETECTION,
      prior_csv_path: "C:\\data\\sample\\SAMPLE_ORDERS.csv" } }));
    await pickFile();
    await screen.findByText(/will be flagged stale/);
    expect(screen.queryByText(/from a different file/)).not.toBeInTheDocument();
  });

  it("loads with Engage, whose plain action is part of its name", async () => {
    const sent: unknown[] = [];
    fakeApi(routes({
      "/load": (init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return { id: "l1", state: "queued" };
      },
      "/jobs/l1": { id: "l1", kind: "load", state: "done", result: {
        view_name: "sample_orders", rows: 5000, rejected: 3, parquet_path: "x",
        csv_path: FILE.path, forced_to_text: ["order_id"] } },
    }));
    await pickFile();
    await userEvent.click(await screen.findByRole("button", { name: /Engage.*Reload/ }));
    expect(sent).toEqual([{ path: FILE.path, delim: ",", nullstr: "\\N",
                            force_text: ["order_id"] }]);
    expect(await screen.findByText("Loaded 5,000 rows as sample_orders")).toBeInTheDocument();
    expect(screen.getByText(/3 rows were rejected/)).toBeInTheDocument();
  });
});
