/**
 * WCAG 2.1 AA, checked by axe in a real browser against the running app.
 *
 * The first run records today's violations as a baseline (baseline.json)
 * rather than failing: F1's job is to measure, the redesign's job is to fix.
 * After that it is a ratchet -- a view fails on any rule it did not break
 * before, or on more elements breaking a rule than before. Fixes shrink the
 * baseline when it is rewritten with UPDATE_A11Y_BASELINE=1.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)),
                           "baseline.json");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
type Counts = Record<string, number>;

const baseline: Record<string, Counts> = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, "utf-8")) : {};
const updating = process.env.UPDATE_A11Y_BASELINE === "1"
  || !fs.existsSync(BASELINE);
const found: Record<string, Counts> = {};

async function audit(page: Page, view: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const counts: Counts = {};
  for (const v of violations) counts[v.id] = v.nodes.length;
  found[view] = counts;
  if (updating) return;
  const allowed = baseline[view] ?? {};
  const worse = Object.entries(counts)
    .filter(([rule, n]) => n > (allowed[rule] ?? 0))
    .map(([rule, n]) => `${rule}: ${n} (baseline ${allowed[rule] ?? 0}) at ` +
      violations.find((v) => v.id === rule)!.nodes
        .map((node) => `${node.target.join(" ")} ${node.failureSummary ?? ""}`)
        .join(" | "));
  expect(worse, `${view} got worse`).toEqual([]);
}

test.beforeAll(async ({ request }) => {
  // The first-run sample install runs in the background; wait for it.
  await expect.poll(async () =>
    (await (await request.get("/api/sample")).json()).state,
    { timeout: 45_000 }).toBe("installed");
});

test.afterAll(() => {
  if (updating) {
    fs.writeFileSync(BASELINE, JSON.stringify(found, null, 2) + "\n");
    console.log(`a11y baseline written: ${BASELINE}`);
  }
});

async function openRelation(page: Page, name: string) {
  await page.goto("/");
  const index = page.getByRole("navigation", { name: "Your Data Sources" });
  await index.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Steps" })).toBeVisible();
}

test("profile step (opens by default)", async ({ page }) => {
  await openRelation(page, "sample_orders");
  await expect(page.getByRole("table", { name: /Columns of/ })).toBeVisible();
  await page.getByRole("button", { name: /Rejected rows/ }).click();
  await audit(page, "profile");
});

test("preview step", async ({ page }) => {
  await openRelation(page, "sample_orders");
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByRole("grid")).toBeVisible();   // audit real rows
  await audit(page, "preview");
});

test("outliers step, and a finding opened in Slice & dice", async ({ page }) => {
  await openRelation(page, "sample_orders");
  await page.getByRole("tab", { name: "Outliers" }).click();
  // Audit the findings, not the running state.
  await expect(page.getByRole("heading", { name: /^Numeric extremes/ })).toBeVisible();
  await audit(page, "outliers");
  // Boxes open folded; audit them open too.
  const folded = page.getByRole("button", { expanded: false })
    .filter({ hasText: /finding|nothing found/ });
  while (await folded.count()) await folded.first().click();
  await audit(page, "outliers:open");
  await page.getByRole("button", { name: /Show these rows/ }).first().click();
  await expect(page.getByText(/From Outliers/)).toBeVisible();
  await expect(page.getByRole("grid")).toBeVisible();
  await audit(page, "finding rows");
});

for (const tab of ["Slice", "Pivot", "SQL"]) {
  test(`slice & dice: ${tab}`, async ({ page }) => {
    await openRelation(page, "sample_orders");
    await page.getByRole("tab", { name: "Slice & dice" }).click();
    await page.getByRole("tab", { name: tab, exact: true }).click();
    if (tab === "Slice") {
      // Audit the filter pop-up with its value picker open, then the
      // applied filter shown above the key, then the result.
      await page.getByRole("button", { name: /Add a filter/ }).click();
      await page.getByLabel("Condition for filter 1").selectOption("IN");
      await expect(page.getByRole("list", { name: /Values of/ })).toBeVisible();
      await page.getByRole("list", { name: /Values of/ }).getByRole("checkbox").first().check();
      await audit(page, "dice:slice:filter");
      await page.getByRole("button", { name: "Apply" }).click();
      await page.getByRole("button", { name: /Add a filter, 1 applied/ }).hover();
      await expect(page.getByRole("region", { name: "Applied filters" })).toBeVisible();
      await audit(page, "dice:slice:applied");
      await page.getByRole("button", { name: /make it so/i }).click();
      await expect(page.getByRole("grid").first()).toBeVisible();
    }
    if (tab === "SQL") {
      // The editor is not a keyboard trap: Esc, then Tab, moves on.
      const editor = page.getByRole("textbox", { name: "SQL query" });
      await editor.click();
      await page.keyboard.press("Tab");
      await expect(editor).toBeFocused();          // Tab indents...
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await expect(editor).not.toBeFocused();      // ...until Esc says leave.
      // Audit a refusal: a write is denied, with no override offered.
      await editor.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.type("DROP TABLE sample_orders");
      await page.getByRole("button", { name: /make it so/i }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Refused" })).toBeVisible();
    }
    await audit(page, `dice:${tab.toLowerCase()}`);
  });
}

test("slice & dice: Join, with the key check and a fan-out to confirm", async ({ page }) => {
  await openRelation(page, "sample_orders");
  await page.getByRole("tab", { name: "Slice & dice" }).click();
  await page.getByRole("tab", { name: "Join", exact: true }).click();
  await page.getByLabel("Join another relation").selectOption("sample_customers");
  await page.getByLabel(/Key 1: column of sample_orders/).selectOption("customer_id");
  await page.getByLabel(/Key 1: column of sample_customers/).selectOption("customer_id");
  await expect(page.getByRole("table", { name: /Key check/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /make it so/i }).click();
  await expect(page.getByRole("button", { name: /Run it anyway/ })).toBeVisible({ timeout: 20_000 });
  await audit(page, "dice:join");
});

test("load panel", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Load a CSV/ }).click();
  await expect(page.getByText("Your folders", { exact: true })).toBeVisible();
  // Audit a picked file: the column list, the reload warning and Engage.
  const files = page.getByRole("region", { name: "Choose a file" });
  await files.getByRole("button", { name: /^(?!Remove).*sample$/ }).click();
  await files.getByRole("button", { name: /^sample_orders\.csv/ }).click();
  await expect(page.getByRole("button", { name: /Engage/ })).toBeVisible();
  await expect(page.getByText(/is already loaded/)).toBeVisible();
  await audit(page, "load");
});

test("settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Backup" })).toBeVisible();
  await audit(page, "settings");
});

// Last: it reloads a source, which leaves the slices cut from it stale. The
// rail then prints "stale" on graphite, on a plain row and a hovered one --
// states no other view reaches.
test("index with a stale chain", async ({ page, request }) => {
  const post = async (p: string, data: unknown) =>
    (await request.post(`/api${p}`, { data })).json();
  const done = async (job: { id: string }) => {
    await expect.poll(async () =>
      (await (await request.get(`/api/jobs/${job.id}`)).json()).state,
      { timeout: 30_000 }).toBe("done");
    return job;
  };
  const cut = await done(await post("/query", { mode: "slice", relation: "sample_orders",
    page: 1, page_size: 10, filters: { kind: "group", combiner: "AND",
      children: [{ kind: "cond", column: "quantity", op: ">", value: "20" }] } }));
  await post("/query/save", { job_id: cut.id, name: "large_orders" });
  const piv = await done(await post("/query", { mode: "pivot", relation: "large_orders",
    page: 1, page_size: 10, rows: ["product_code"], value: "amount", agg: "sum" }));
  await post("/query/save", { job_id: piv.id, name: "large_orders_by_product" });
  await page.waitForTimeout(1100);   // cut strictly before the reload
  const folder = (await (await request.get("/api/sample")).json()).folder;
  const later = `${folder}/later/sample_orders.csv`;
  const det = await post("/load/detect", { path: later });
  await done(await post("/load", { path: later, force_text: det.suggested_text }));

  await page.goto("/");
  const index = page.getByRole("navigation", { name: "Your Data Sources" });
  await index.getByRole("button", { name: "large_orders_by_product", exact: true }).click();
  await expect(index.getByText("stale").first()).toBeVisible();
  await index.getByRole("button", { name: "large_orders", exact: true }).hover();
  await audit(page, "index:stale");
});
