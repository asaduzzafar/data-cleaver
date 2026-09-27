/**
 * Exporting: where the file goes, and a result too big for Excel says so in
 * words rather than by greying the button out.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DataGrid } from "../../src/DataGrid";
import { fakeApi, renderWithClient } from "./fakeApi";

const JOB = { id: "q", kind: "query", label: "", state: "done",
              progress: null, error: null, position: 0, ahead: 0, queued_ms: 0,
              elapsed_ms: 0 };
const result = (total: number) => ({
  columns: ["a"], types: ["VARCHAR"], rows: [["x"]], total, page: 1, pages: 1,
  page_size: 500, sql: "SELECT 1", base: "t", gateway: null, inputs: [], mode: "slice",
});

function setup(total: number) {
  fakeApi({ "/export/folder": { folder: "C:/Users/me/Downloads", changeable: true } });
  renderWithClient(<DataGrid result={result(total) as never} job={JOB as never}
                             onPage={() => {}} />);
}

describe("Export a file", () => {
  it("names the folder it saves to, with a way to change it", async () => {
    setup(10);
    expect(await screen.findByText(String.raw`C:\Users\me\Downloads`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change the export folder" })).toBeInTheDocument();
  });

  it("starts a result too big for one sheet on parquet", () => {
    setup(2_000_000);
    expect(screen.getByLabelText("Format")).toHaveValue("parquet");
    expect(screen.queryByText("Too many rows for Excel")).not.toBeInTheDocument();
  });

  it("says why xlsx cannot take it, and offers the formats that can", async () => {
    setup(2_000_000);
    await userEvent.selectOptions(screen.getByLabelText("Format"), "xlsx");
    expect(screen.getByText("Too many rows for Excel")).toBeInTheDocument();
    expect(screen.getByText(/2,000,000 rows, and one Excel sheet holds at most 1,048,576/))
      .toBeInTheDocument();
    const exportKey = screen.getByRole("button", { name: "Export" });
    expect(exportKey).toBeDisabled();
    expect(exportKey).toHaveAccessibleDescription(/Too many rows for Excel/);
    await userEvent.click(screen.getByRole("button", { name: "Use parquet" }));
    expect(screen.getByLabelText("Format")).toHaveValue("parquet");
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });
});
