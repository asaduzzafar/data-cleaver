/**
 * Choosing columns by moving them. Drag physics need a real layout, so these
 * tests drive the keyboard paths every drag must also have: Enter adds,
 * the zone's Add chooser adds, Alt+arrows reorder, Delete removes.
 */
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FieldWell } from "../../src/fields/FieldWell";

const COLUMNS = [
  { name: "region", type: "VARCHAR" },
  { name: "amount", type: "DOUBLE" },
  { name: "day", type: "DATE" },
];

function Harness({ pivot = false }: { pivot?: boolean }) {
  const [a, setA] = useState<string[]>([]);
  const [b, setB] = useState<string[]>([]);
  const zones = pivot
    ? [{ id: "rows", label: "Rows", items: a, onChange: setA },
       { id: "values", label: "Values", items: b, onChange: setB, max: 1 }]
    : [{ id: "columns", label: "Columns", items: a, onChange: setA }];
  return (
    <>
      <FieldWell label="Fields" columns={COLUMNS} zones={zones} />
      <output data-testid="state">{JSON.stringify({ a, b })}</output>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent!);
const field = (name: string) =>
  within(screen.getByRole("list", { name: "Columns" }))
    .getByRole("button", { name: new RegExp(`^${name}`) });
const zone = (label: string) => screen.getByRole("region", { name: label });
const pill = (name: string) =>
  screen.getByLabelText(new RegExp(`^${name}, .* position`));

describe("FieldWell", () => {
  it("adds a column with Enter, in the order chosen", async () => {
    render(<Harness />);
    field("amount").focus();
    await userEvent.keyboard("{Enter}");
    field("region").focus();
    await userEvent.keyboard("{Enter}");
    expect(state().a).toEqual(["amount", "region"]);
    expect(pill("amount")).toHaveAccessibleName(/Columns position 1 of 2/);
  });

  it("adds with a click too, and never twice", async () => {
    render(<Harness />);
    await userEvent.click(field("day"));
    await userEvent.click(field("day"));
    expect(state().a).toEqual(["day"]);
  });

  it("reorders a pill with Alt+arrows and removes it with Delete", async () => {
    render(<Harness />);
    for (const n of ["region", "amount", "day"]) await userEvent.click(field(n));
    fireEvent.keyDown(pill("day"), { key: "ArrowLeft", altKey: true });
    expect(state().a).toEqual(["region", "day", "amount"]);
    fireEvent.keyDown(pill("region"), { key: "Delete" });
    expect(state().a).toEqual(["day", "amount"]);
  });

  it("adds to a chosen zone from its Add chooser", async () => {
    render(<Harness pivot />);
    await userEvent.selectOptions(
      within(zone("Values")).getByLabelText("Add a column to Values"), "amount");
    expect(state()).toEqual({ a: [], b: ["amount"] });
  });

  it("a single-slot zone swaps its column rather than holding two", async () => {
    render(<Harness pivot />);
    const add = within(zone("Values")).getByLabelText("Add a column to Values");
    await userEvent.selectOptions(add, "amount");
    await userEvent.selectOptions(
      within(zone("Values")).getByLabelText("Add a column to Values"), "day");
    expect(state().b).toEqual(["day"]);
  });

  it("finds columns by name", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Find a column"), "am");
    const list = screen.getByRole("list", { name: "Columns" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["amount123"]);
  });

  it("says what an empty zone is for", () => {
    render(<Harness pivot />);
    expect(within(zone("Rows")).getByText(/Drag a column here, or several/))
      .toBeInTheDocument();
    expect(within(zone("Values")).getByText(/^Drag a column here\.$/))
      .toBeInTheDocument();
  });
});
