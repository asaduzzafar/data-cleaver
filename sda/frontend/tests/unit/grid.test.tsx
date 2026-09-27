/**
 * F3: the result grid. Behaviour, not styling: roles, what the header says,
 * how blanks read, and that the keyboard moves one visible cell focus.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResultGrid } from "../../src/ResultGrid";

const COLUMNS = ["account", "amount", "note"];
const TYPES = ["VARCHAR", "DECIMAL(12,2)", "VARCHAR"];
const ROWS = [
  ["000123", "10.50", "first"],
  ["000456", null, ""],
  ["000789", "30.00", null],
];

function grid() {
  render(<ResultGrid columns={COLUMNS} types={TYPES} rows={ROWS} label="Result" />);
  return screen.getByRole("grid", { name: "Result" });
}

describe("ResultGrid", () => {
  it("widens and narrows the current column with Alt and the arrows", () => {
    const g = grid();
    const head = () => within(g).getAllByRole("row")[0].style.gridTemplateColumns;
    const before = head();
    fireEvent.keyDown(g, { key: "ArrowRight", altKey: true });
    const wider = head();
    expect(parseInt(wider)).toBe(parseInt(before) + 24);
    expect(wider.split(" ").slice(1)).toEqual(before.split(" ").slice(1));
    fireEvent.keyDown(g, { key: "ArrowLeft", altKey: true });
    expect(head()).toBe(before);
  });

  it("is one ARIA grid whose headers name the columns only", () => {
    const g = grid();
    expect(g).toHaveAttribute("tabindex", "0");
    expect(g).toHaveAttribute("aria-rowcount", "4");
    const headers = within(g).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(
      ["account", "amount", "note"]);
  });

  it("tells NULL apart from an empty string", () => {
    const g = grid();
    const cells = within(g).getAllByRole("gridcell");
    // row 2: amount is NULL, note is ""
    expect(cells[4]).toHaveTextContent("null");
    expect(cells[5]).toHaveTextContent('""');
    expect(cells[5].querySelector("[title='empty text']")).not.toBeNull();
  });

  it("keeps zero-padded IDs as text, never numbers", () => {
    expect(within(grid()).getAllByRole("gridcell")[0]).toHaveTextContent("000123");
  });

  it("moves one active cell with the keyboard", () => {
    const g = grid();
    fireEvent.focus(g);
    const active = () => document.getElementById(
      g.getAttribute("aria-activedescendant") ?? "");
    expect(active()).toHaveTextContent("000123");
    fireEvent.keyDown(g, { key: "ArrowRight" });
    expect(active()).toHaveTextContent("10.50");
    fireEvent.keyDown(g, { key: "ArrowDown" });
    expect(active()).toHaveTextContent("null");
    fireEvent.keyDown(g, { key: "End" });
    expect(active()).toHaveTextContent('""');
    fireEvent.keyDown(g, { key: "End", ctrlKey: true });
    expect(active()).toHaveTextContent("null");     // last row, last column
    fireEvent.keyDown(g, { key: "Home", ctrlKey: true });
    expect(active()).toHaveTextContent("000123");
    fireEvent.keyDown(g, { key: "ArrowUp" });        // clamps at the top
    expect(active()).toHaveTextContent("000123");
  });

  it("shows a float at its real precision, and never touches a DECIMAL", () => {
    render(<ResultGrid columns={["f", "d"]} types={["DOUBLE", "DECIMAL(12,2)"]}
                       rows={[[1733821.7999999998, "10.50"]]} label="Floats" />);
    const cells = within(screen.getByRole("grid", { name: "Floats" }))
      .getAllByRole("gridcell");
    expect(cells[0]).toHaveTextContent(/^1733821\.8$/);
    expect(cells[1]).toHaveTextContent(/^10\.50$/);
  });

  it("says so when nothing matched", () => {
    render(<ResultGrid columns={COLUMNS} types={TYPES} rows={[]} label="Result" />);
    expect(screen.getByText("No rows matched.")).toBeInTheDocument();
  });
});
