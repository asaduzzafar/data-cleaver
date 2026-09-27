/**
 * F12: the Preview step says what its rows are, asks for the right look,
 * and draws a new sample only when asked.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PreviewStep } from "../../src/preview/PreviewStep";
import { fakeApi, ORDERS, renderWithClient } from "./fakeApi";

const JOB = { id: "q1", kind: "query", label: "preview",
              state: "queued", progress: null, error: null, position: 0,
              ahead: 0, queued_ms: 0, elapsed_ms: 0 };

function setup() {
  const posted: Record<string, unknown>[] = [];
  let last: Record<string, unknown> = {};
  fakeApi({
    "/query": (init?: RequestInit) => {
      last = JSON.parse(String(init?.body));
      posted.push(last);
      return JOB;
    },
    "/jobs/q1": () => ({ ...JOB, state: "done", result: {
      columns: ["id", "amount"], types: ["VARCHAR", "DOUBLE"],
      rows: [["002", 20], ["001", 10], ["003", null]],
      total: 3, page: 1, pages: 1, page_size: 200, sql: "", base: "x",
      inputs: [], mode: "preview", gateway: null,
      preview: { kind: last.preview, size: 3, of: 1_000_000,
                 seed: last.preview === "sample" ? last.seed : null,
                 order: last.preview === "sample" ? "random" : "stored" },
    } }),
  });
  renderWithClient(<PreviewStep relation={ORDERS as never} onNext={() => {}} />);
  return posted;
}

describe("PreviewStep", () => {
  it("opens on the first rows as stored", async () => {
    const posted = setup();
    await screen.findByRole("grid");
    expect(posted[0]).toMatchObject({ mode: "preview", preview: "head", page_size: 200 });
  });

  it("draws a repeatable sample, and a new one only when asked", async () => {
    const posted = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "Random sample" }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ preview: "sample", seed: 1 }));
    await userEvent.click(screen.getByRole("button", { name: "Another sample" }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ preview: "sample", seed: 2 }));
  });

  it("comes back to the same look, without reading the rows again", async () => {
    const posted = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "Random sample" }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ preview: "sample" }));
    await screen.findByRole("grid", { name: "Random sample of rows" });
    const reads = posted.length;
    cleanup();   // leave the step...
    renderWithClient(<PreviewStep relation={ORDERS as never} onNext={() => {}} />);
    // ...and come back: same look, same rows, no new read.
    expect(screen.getByRole("radio", { name: "Random sample" }))
      .toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("grid", { name: "Random sample of rows" })).toBeInTheDocument();
    expect(posted.length).toBe(reads);
  });

  it("sorts the rows shown by a column head, blanks last", async () => {
    setup();
    const grid = await screen.findByRole("grid");
    const head = within(grid).getAllByRole("columnheader")[1];
    expect(head).toHaveAttribute("aria-sort", "none");
    await userEvent.click(within(head).getByRole("button"));
    expect(head).toHaveAttribute("aria-sort", "ascending");
    const firstCol = () => within(grid).getAllByRole("row").slice(1)
      .map((r) => within(r).getAllByRole("gridcell")[0].textContent);
    expect(firstCol()).toEqual(["001", "002", "003"]);
    await userEvent.click(within(head).getByRole("button"));
    expect(head).toHaveAttribute("aria-sort", "descending");
    expect(firstCol()).toEqual(["002", "001", "003"]);   // the blank stays last
  });
});
