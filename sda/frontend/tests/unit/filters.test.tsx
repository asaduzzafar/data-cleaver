/**
 * The Slice filters: an "Add a filter" key that opens a pop-up to build a
 * condition, and the applied filters shown above it on hover or focus. Its
 * state is the filter tree the backend compiles; these tests check the
 * sentence each condition reads as, the operators each type offers, the
 * five-filter limit, and where a server refusal lands.
 */
import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS, FilterBuilder, MAX_FILTERS, toFilters, type FilterGroup,
} from "../../src/slice/Filters";
import { fakeApi, renderWithClient } from "./fakeApi";

const COLUMNS = [
  { name: "region", type: "VARCHAR" },
  { name: "amount", type: "DOUBLE" },
  { name: "day", type: "DATE" },
];

function Harness({ error = null, start = EMPTY_FILTERS }: {
  error?: string | null; start?: FilterGroup;
}) {
  const [g, setG] = useState<FilterGroup>(start);
  return (
    <>
      <FilterBuilder relation="orders" columns={COLUMNS} group={g} onChange={setG}
                     error={error} />
      <output data-testid="tree">{JSON.stringify(toFilters(g))}</output>
    </>
  );
}
const tree = () => JSON.parse(screen.getByTestId("tree").textContent!);
const options = (label: string) =>
  within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent);
const addKey = () => screen.getByRole("button", { name: /Add a filter/ });
const cond = (column: string, op: string, value: unknown) =>
  ({ kind: "cond" as const, column, op, value });

describe("FilterBuilder", () => {
  it("starts empty, sending no filter at all", () => {
    fakeApi({});
    renderWithClient(<Harness />);
    expect(tree()).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("builds a condition in a pop-up, and applying closes it", async () => {
    fakeApi({});
    renderWithClient(<Harness />);
    await userEvent.click(addKey());
    const pop = screen.getByRole("dialog", { name: "Add a filter" });
    expect(screen.getByLabelText("Column for filter 1")).toHaveFocus();
    await userEvent.selectOptions(screen.getByLabelText("Condition for filter 1"), "CONTAINS");
    await userEvent.type(screen.getByLabelText("Value for filter 1"), "north");
    expect(tree()).toBeNull();                         // a draft until applied
    await userEvent.click(within(pop).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tree()).toEqual({ kind: "group", combiner: "AND",
                             children: [cond("region", "CONTAINS", "north")] });
    expect(addKey()).toHaveAccessibleName("Add a filter, 1 applied");
  });

  it("offers operators in words, by the column's type", async () => {
    fakeApi({});
    renderWithClient(<Harness />);
    await userEvent.click(addKey());
    await userEvent.selectOptions(screen.getByLabelText("Column for filter 1"), "amount");
    expect(options("Condition for filter 1")).toEqual(expect.arrayContaining(
      ["more than", "at most", "between"]));
    await userEvent.selectOptions(screen.getByLabelText("Column for filter 1"), "day");
    expect(options("Condition for filter 1")).toEqual(expect.arrayContaining(
      ["on", "before", "after"]));
    expect(screen.getByLabelText("Value for filter 1")).toHaveAttribute("type", "date");
  });

  it("closes on Escape without applying anything", async () => {
    fakeApi({});
    renderWithClient(<Harness />);
    await userEvent.click(addKey());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tree()).toBeNull();
    expect(addKey()).toHaveFocus();
  });

  it("shows the applied filters above the key on hover, to combine or remove",
     async () => {
    fakeApi({});
    renderWithClient(<Harness start={{ kind: "group", combiner: "AND", children: [
      cond("region", "=", "north"), cond("amount", ">", "5")] }} />);
    expect(screen.queryByRole("region", { name: "Applied filters" })).not.toBeInTheDocument();
    await userEvent.hover(addKey());
    const card = screen.getByRole("region", { name: "Applied filters" });
    expect(within(card).getByRole("button", { name: /Edit filter 2: amount more than 5/ }))
      .toBeInTheDocument();
    await userEvent.click(within(card).getByRole("radio", { name: "Match any" }));
    expect(tree().combiner).toBe("OR");
    await userEvent.click(within(card).getByRole("button", { name: "Remove filter 1" }));
    expect(tree().children).toEqual([cond("amount", ">", "5")]);
  });

  it("stops at five filters and says why", async () => {
    fakeApi({});
    const five = Array.from({ length: MAX_FILTERS }, (_, i) => cond("amount", ">", String(i)));
    renderWithClient(<Harness start={{ kind: "group", combiner: "AND", children: five }} />);
    await userEvent.click(addKey());
    expect(screen.getByText(/Five filters is the most a slice takes/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Column for filter 6")).not.toBeInTheDocument();
  });

  it("picks several values with their counts", async () => {
    fakeApi({ "/relations/orders/values": {
      values: [["north", 40], ["south", 12]], distinct_total: 2, truncated: false } });
    renderWithClient(<Harness />);
    await userEvent.click(addKey());
    await userEvent.selectOptions(screen.getByLabelText("Condition for filter 1"), "IN");
    await userEvent.click(await screen.findByRole("checkbox", { name: /south/ }));
    expect(screen.getByText(/1 chosen · 2 values/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(tree().children[0]).toEqual(cond("region", "IN", ["south"]));
  });

  it("marks the filter a refusal names, in the list and when edited", async () => {
    fakeApi({});
    renderWithClient(<Harness error="unknown column: 'amount'" start={{
      kind: "group", combiner: "AND",
      children: [cond("region", "=", "north"), cond("amount", ">", "5")] }} />);
    await userEvent.hover(addKey());
    await userEvent.click(screen.getByRole("button", { name: /Edit filter 2/ }));
    expect(screen.getByLabelText("Column for filter 2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Column for filter 2"))
      .toHaveAccessibleDescription("unknown column: 'amount'");
  });
});
