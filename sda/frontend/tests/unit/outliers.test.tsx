/**
 * F13: the Outliers step as an exceptions list, and the handoff that opens a
 * finding's rows in Slice & dice under a banner citing the check.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OutliersStep } from "../../src/outliers/OutliersStep";
import { FindingRows } from "../../src/outliers/FindingRows";
import { fakeApi, ORDERS, renderWithClient } from "./fakeApi";

const JOB = { id: "o1", kind: "query", label: "outliers",
              state: "queued", progress: null, error: null, position: 0,
              ahead: 0, queued_ms: 0, elapsed_ms: 0 };
const SHOW = { mode: "slice", relation: "sample_orders", filters: {
  kind: "group", combiner: "OR", children: [] } };
const EXTREME = {
  column: "quantity", count: 3, below: 0, above: 3, low: -3, high: 13, k: 1.5,
  summary: "3 value(s) of quantity outside -3 to 13", show: SHOW,
  histogram: [{ lo: 1, hi: 2000, count: 999_997 }, { lo: 2000, hi: 4000, count: 3 }],
};
const RESULT = {
  relation: "sample_orders", rows: 1_000_000, k: 1.5, n: 5,
  extremes: [EXTREME],
  rare: [{ column: "product_code", count: 3, values: [{ value: "P999", count: 3 }],
           total_values: 1, summary: "1 value(s) of product_code seen 5 times or fewer",
           show: SHOW }],
  duplicates: [],
  missing: { columns: [{ column: "promo_code", count: 857_143, pct: 85.71,
                         summary: "857,143 blank value(s) in promo_code", show: SHOW }],
             mostly_blank: { column: null, count: 0, summary: "0 row(s)", show: SHOW } },
};

describe("OutliersStep", () => {
  function setup(focus: "extremes" | "duplicates" | null = null) {
    const posted: unknown[] = [];
    fakeApi({
      "/relations/sample_orders/outliers": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return JOB;
      },
      "/jobs/o1": { ...JOB, state: "done", result: RESULT },
    });
    const shown: unknown[] = [];
    renderWithClient(<OutliersStep relation={ORDERS as never} focus={focus}
                                   onNext={() => {}}
                                   onShow={(f, c) => shown.push([f.column, c])} />);
    return { posted, shown };
  }

  it("lists every check, found or not", async () => {
    setup();
    for (const [name, note] of [["Numeric extremes", "1 finding"],
                                ["Rare categories", "1 finding"],
                                ["Missing and blank", "1 finding"],
                                ["Duplicate keys", "nothing found"]]) {
      const h = await screen.findByRole("heading", { name: new RegExp(`^${name}`) });
      expect(h).toHaveTextContent(note);
    }
    expect(screen.getByText(/Checked: nothing here/)).toBeInTheDocument();
  });

  it("folds every box to its header line until opened", async () => {
    setup();
    const toggle = await screen.findByRole("button", { name: /^Numeric extremes/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Show these rows/ })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Show these rows/ })).toBeVisible();
  });

  it("states fences in words beside the drawing", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: /^Numeric extremes/ }));
    expect(await screen.findByText(/0 below -3 · 3 above 13/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Fences at -3 and 13/ })).toBeInTheDocument();
  });

  it("asks again with a wider fence or a different rare threshold", async () => {
    const { posted } = setup();
    await screen.findByText(/0 below/);
    await userEvent.selectOptions(screen.getByLabelText(/Fence width/), "3");
    await waitFor(() => expect(posted.at(-1)).toEqual({ k: 3, n: 5 }));
  });

  it("hands a finding to Slice & dice", async () => {
    const { shown } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /^Numeric extremes/ }));
    const row = (await screen.findByText(/value\(s\) of quantity/)).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /Show these rows/ }));
    expect(shown).toEqual([["quantity", "extremes"]]);
  });

  it("brings the check a lead pointed at into focus", async () => {
    setup("extremes");
    const toggle = await screen.findByRole("button", { name: /^Numeric extremes/ });
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("FindingRows", () => {
  it("runs the finding's own query, under a banner citing the check", async () => {
    const posted: Record<string, unknown>[] = [];
    fakeApi({
      "/query": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return { ...JOB, id: "q9" };
      },
      "/jobs/q9": { ...JOB, id: "q9", state: "done", result: {
        columns: ["quantity"], types: ["BIGINT"], rows: [[4000], [4000], [4000]],
        total: 3, page: 1, pages: 1, page_size: 500, sql: "", base: "x",
        inputs: [], mode: "slice", gateway: null } },
    });
    renderWithClient(<FindingRows relation="sample_orders" finding={EXTREME}
                                  check="extremes" onBack={() => {}}
                                  onClear={() => {}} onChanged={() => {}} />);
    expect(screen.getByText(/From Outliers · Numeric extremes · quantity/)).toBeInTheDocument();
    await waitFor(() => expect(posted[0]).toMatchObject({ ...SHOW, page: 1 }));
    expect(await screen.findByRole("grid")).toBeInTheDocument();
  });
});
