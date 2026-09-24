/**
 * F7-F8: the Join tab. The base is the relation you are on; the keys are
 * measured before the rows are trusted; a fan-out must be confirmed.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { JoinTab } from "../../src/joins/JoinTab";
import { fakeApi, ORDERS, renderWithClient } from "./fakeApi";

const CUSTOMERS = { ...ORDERS, name: "sample_customers", rows: 20_021 };
const JOB = { id: "j", kind: "query", label: "", state: "queued",
              progress: null, error: null, position: 0, ahead: 0, queued_ms: 0,
              elapsed_ms: 0 };
const STEP = { left: "s", right: "sa", left_relation: "sample_orders",
               right_relation: "sample_customers", type: "inner",
               left_rows: 1000, right_rows: 21, left_distinct: 20, right_distinct: 20,
               left_nulls: 0, right_nulls: 0, matched_left: 1000, matched_right: 21,
               max_fanout: 2, right_unique: false, pairs: 1050, estimated_rows: 1050 };
const FANOUT = { verdict: "block", overridable: true, estimated_rows: 1050,
                 scanned_rows: 0, operators: [], findings: [{
                   rule: "fanout", severity: "block",
                   title: "sample_customers matches some sample_orders rows more than once",
                   detail: "one key matches up to 2 rows", suggestions: [] }] };

function setup() {
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  let confirmed = false;
  fakeApi({
    "/relations/sample_orders/schema": { columns: [
      { name: "customer_id", type: "VARCHAR" }, { name: "amount", type: "DOUBLE" }] },
    "/relations/sample_customers/schema": { columns: [
      { name: "customer_id", type: "VARCHAR" }, { name: "segment", type: "VARCHAR" }] },
    "/joins/probe": (init?: RequestInit) => {
      posted.push({ path: "probe", body: JSON.parse(String(init?.body)) });
      return { ...JOB, id: "p" };
    },
    "/jobs/p": { ...JOB, id: "p", state: "done", result: { steps: [STEP], review: FANOUT } },
    "/query": (init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      confirmed = !!body.confirm_expensive;
      posted.push({ path: "query", body });
      return { ...JOB, id: "q" };
    },
    "/jobs/q": () => confirmed
      ? { ...JOB, id: "q", state: "done", result: {
          columns: ["customer_id", "amount", "segment"], types: ["VARCHAR", "DOUBLE", "VARCHAR"],
          rows: [["000001", 5, "Public"]], total: 1050, page: 1, pages: 3,
          page_size: 500, sql: "", base: "sample_orders", gateway: null,
          inputs: ["sample_orders", "sample_customers"], mode: "join",
          probe: { steps: [STEP], review: FANOUT } } }
      : { ...JOB, id: "q", state: "error", error: "Rejected",
          detail: { error: "gateway", ...FANOUT } },
  });
  renderWithClient(<JoinTab relation={ORDERS as never}
                            relations={[ORDERS, CUSTOMERS] as never} onChanged={() => {}} />);
  return posted;
}

async function addCustomersOnKey() {
  await userEvent.selectOptions(screen.getByLabelText(/Join another relation/), "sample_customers");
  await userEvent.selectOptions(await screen.findByLabelText(/Key 1: column of sample_orders/),
                                "customer_id");
  await userEvent.selectOptions(screen.getByLabelText(/Key 1: column of sample_customers/),
                                "customer_id");
}

describe("JoinTab", () => {
  it("starts from the relation you are on, as the base", () => {
    setup();
    expect(screen.getByText(/the base/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make it so/ })).toBeNull();
  });

  it("waits for complete keys before it can run", async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText(/Join another relation/), "sample_customers");
    expect(screen.getByRole("button", { name: /Make it so/ })).toBeDisabled();
    expect(screen.getByText(/Choose the key columns/)).toBeInTheDocument();
  });

  it("previews the result's column names, prefixing a shared name", async () => {
    setup();
    await addCustomersOnKey();
    expect(await screen.findByText(/s_customer_id, amount, sa_customer_id, segment/))
      .toBeInTheDocument();
    expect(screen.getByText(/gets its alias in front/)).toBeInTheDocument();
  });

  it("measures the keys once they are complete, in the backend's spec shape", async () => {
    const posted = setup();
    await addCustomersOnKey();
    await waitFor(() => expect(posted.find((p) => p.path === "probe")).toBeTruthy(),
                  { timeout: 2000 });
    const spec = posted.find((p) => p.path === "probe")!.body.join as { inputs: unknown[] };
    expect(spec.inputs[1]).toMatchObject({ relation: "sample_customers",
      join: { type: "inner", with: "s", on: [["customer_id", "customer_id"]] } });
    const check = await screen.findByRole("table", { name: /Key check/ });
    expect(within(check).getByText("1,050")).toBeInTheDocument();
    expect(screen.getByText(/up to 2 matches for one key/)).toBeInTheDocument();
  });

  it("asks before a fan-out, then runs with the numbers beside the rows", async () => {
    const posted = setup();
    await addCustomersOnKey();
    await userEvent.click(screen.getByRole("button", { name: /Make it so/ }));
    // Refused inside the job: shown as a decision, not a failure.
    // (The key check may state the same finding; the run's refusal adds the
    // decision.)
    const confirm = await screen.findByRole("button", { name: /Run it anyway/ },
                                            { timeout: 3000 });
    expect(screen.getAllByText(/matches some sample_orders rows more than once/).length)
      .toBeGreaterThan(0);
    expect(screen.queryByText("That query failed")).toBeNull();
    await userEvent.click(confirm);
    await waitFor(() => expect(posted.at(-1)!.body.confirm_expensive).toBe(true));
    expect(await screen.findByRole("grid", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Key check for these results/ })).toBeInTheDocument();
  });
});
