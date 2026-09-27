// The README's screenshots, taken from a release build on the generated
// sample only, as a throwaway "analyst" profile. From sda/frontend:
//
//   node scripts/readme-shots.cjs ../../build/dist/DataCleaver/DataCleaver.exe ../../docs/img
//
// It launches the app, walks the EDA path, then saves a slice, cuts a pivot
// from it and reloads the source from later/, so the lineage shot is real.
const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [exe, out] = process.argv.slice(2).map((p) => path.resolve(p));
const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "dc-readme-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

(async () => {
  const proc = spawn(exe, [], { env: { ...process.env, LOCALAPPDATA: appdata, USERNAME: "analyst" } });
  const portFile = path.join(appdata, "DataCleaver", "instance.port");
  const port = await until("port", () => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim());
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, body) => {
    const r = await fetch(`${base}/api${p}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const job = async (started) => until(`job ${started.id}`, async () => {
    const j = await api(`/jobs/${started.id}`);
    if (j.state === "error") throw new Error(j.error);
    return j.state === "done" && j;
  });
  const sample = await until("sample", async () => {
    const s = await api("/sample"); return s.state === "installed" && s; });

  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...opts });
  await page.goto(base);

  // 1. Settings: the demo-data switch and where data is kept.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: /Enable demo data/ }).waitFor();
  await sleep(500);
  await shot("settings");

  // 2. Profile.
  const index = page.getByRole("navigation", { name: "Your Data Sources" });
  await index.getByRole("button", { name: "sample_orders", exact: true }).click();
  await page.getByRole("table", { name: /Columns of/ }).waitFor();
  await sleep(500);
  await shot("profile");

  // 3. Outliers.
  await page.getByRole("tab", { name: "Outliers" }).click();
  await page.getByRole("heading", { name: /^Numeric extremes/ }).waitFor();
  await page.getByRole("button", { name: /^Numeric extremes/ }).click();
  await sleep(500);
  await shot("outliers");

  // 4. Slice with a filter.
  await page.getByRole("tab", { name: "Slice & dice" }).click();
  await page.getByRole("tab", { name: "Slice", exact: true }).click();
  await page.getByRole("button", { name: /Add a filter/ }).click();
  await page.getByLabel("Column for filter 1").selectOption("quantity");
  await page.getByLabel("Condition for filter 1").selectOption(">");
  await page.getByLabel("Value for filter 1").fill("20");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: /make it so/i }).first().click();
  await page.getByRole("grid").waitFor();
  await page.mouse.wheel(0, 260);
  await sleep(600);
  await shot("slice");

  // 5. Join fan-out.
  await page.getByRole("tab", { name: "Join", exact: true }).click();
  await page.getByLabel("Join another relation").selectOption("sample_customers");
  await page.getByLabel(/Key 1: column of sample_orders/).selectOption("customer_id");
  await page.getByLabel(/Key 1: column of sample_customers/).selectOption("customer_id");
  await page.getByRole("table", { name: /Key check/ }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /make it so/i }).last().click();
  const anyway = page.getByRole("button", { name: /Run it anyway/ });
  await anyway.waitFor({ timeout: 30_000 });
  await page.getByRole("table", { name: /Key check/ }).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 250);
  await sleep(400);
  await shot("join");

  // 6. Lineage: a slice, a pivot cut from it, then the source reloaded.
  const big = await job(await api("/query", {
    mode: "slice", relation: "sample_orders", page: 1, page_size: 10,
    filters: { kind: "group", combiner: "AND", children: [
      { kind: "cond", column: "quantity", op: ">", value: "20" }] } }));
  await api("/query/save", { job_id: big.id, name: "large_orders" });
  const piv = await job(await api("/query", {
    mode: "pivot", relation: "large_orders", page: 1, page_size: 10,
    rows: ["product_code"], value: "amount", agg: "sum" }));
  await api("/query/save", { job_id: piv.id, name: "large_orders_by_product" });
  await sleep(1200);   // cut times strictly before the reload
  const later = `${sample.folder}/later/sample_orders.csv`;
  const det = await api("/load/detect", { path: later });
  await job(await api("/load", { path: later, force_text: det.suggested_text }));

  await page.reload();
  await index.getByRole("button", { name: "large_orders_by_product", exact: true }).click();
  await page.getByRole("tablist", { name: "Steps" }).waitFor();
  const row = index.locator("div.group").filter({ hasText: "large_orders_by_product" });
  await row.locator("button[aria-expanded]").click();
  await sleep(600);
  await shot("lineage");

  await browser.close();
  proc.kill();
  console.log("done:", fs.readdirSync(out).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
