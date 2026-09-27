/**
 * The SQL tab's editor, and the gateway notice every run can raise.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { GatewayNotice } from "../../src/Gateway";
import type { GatewayReview } from "../../src/types";
import { fakeApi, HEALTH, ORDERS, renderWithClient } from "./fakeApi";

const SCHEMA = { relation: "sample_orders",
                 columns: [{ name: "order_id", type: "VARCHAR" },
                           { name: "amount", type: "DOUBLE" }] };

async function openSql(posted: unknown[] = []) {
  fakeApi({
    "/health": HEALTH,
    "/relations": { relations: [ORDERS] },
    "/relations/sample_orders/schema": SCHEMA,
    "/relations/sample_orders/profile": { id: "p", state: "queued" },
    "/jobs/p": { id: "p", state: "running" },
    "/jobs": { jobs: [] },
    "/query": (init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return { id: "q1", state: "queued" };
    },
    "/jobs/q1": { id: "q1", state: "running" },
  });
  renderWithClient(<App />);
  await userEvent.click(await screen.findByRole("tab", { name: "Slice & dice" }));
  await userEvent.click(screen.getByRole("tab", { name: "SQL", exact: true }));
  return screen.findByRole("textbox", { name: "SQL query" });
}

describe("The SQL editor", () => {
  it("is labelled, and says how to leave it by keyboard", async () => {
    const editor = await openSql();
    expect(editor).toHaveTextContent('SELECT * FROM "sample_orders"');
    expect(editor).toHaveAccessibleDescription(/press Esc, then Tab/);
  });

  it("runs on Ctrl+Enter from inside the editor, once", async () => {
    const posted: unknown[] = [];
    const editor = await openSql(posted);
    editor.focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    // Slice runs by itself when the relation opens; count only SQL runs.
    const sql = posted.filter((b) => (b as { mode: string }).mode === "sql");
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatchObject({ mode: "sql", relation: "sample_orders",
                                      sql: 'SELECT * FROM "sample_orders"' });
  });
});

const finding = (severity: "deny" | "block" | "warn") => ({
  rule: `${severity}_rule`, severity, title: `A ${severity} finding`,
  detail: "Why it happened.", suggestions: ["Filter first"],
});
const review = (severity: "deny" | "block" | "warn", overridable: boolean) =>
  ({ findings: [finding(severity)], estimated_rows: 5_000_000, overridable,
  } as unknown as GatewayReview);

describe("Gateway notice", () => {
  it("names each severity in words, not colour alone", () => {
    const { rerender } = render(<GatewayNotice review={review("deny", false)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Refused");
    rerender(<GatewayNotice review={review("block", true)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped before running");
    rerender(<GatewayNotice review={review("warn", false)} />);
    expect(screen.getByRole("status")).toHaveTextContent("Worth knowing");
  });

  it("offers Run it anyway only on an overridable block", async () => {
    const confirm = vi.fn();
    const { rerender } = render(
      <GatewayNotice review={review("block", true)} onConfirm={confirm} onDismiss={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Run it anyway" }));
    expect(confirm).toHaveBeenCalledOnce();

    rerender(<GatewayNotice review={review("deny", true)} onConfirm={confirm}
                            onDismiss={() => {}} />);
    const notice = screen.getByRole("alert");
    expect(within(notice).queryByRole("button", { name: "Run it anyway" }))
      .not.toBeInTheDocument();
    expect(notice).toHaveTextContent("there is no override");
  });
});
