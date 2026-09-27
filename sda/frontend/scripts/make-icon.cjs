// Renders the Data Cleaver mark (public/favicon.svg) to the Windows app icon,
// sda/desktop/datacleaver.ico, which the PyInstaller spec and the installer
// pick up. From sda/frontend:  node scripts/make-icon.cjs
const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const svg = fs.readFileSync(path.join(__dirname, "..", "public", "favicon.svg"), "utf8");
const out = path.join(__dirname, "..", "..", "desktop", "datacleaver.ico");

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const pngs = [];
  for (const s of SIZES) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">
         <div style="width:${s}px;height:${s}px">${svg.replace("<svg ", `<svg width="${s}" height="${s}" `)}</div>
       </body></html>`);
    pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }));
  }
  await browser.close();

  // ICO: a 6-byte header, a 16-byte entry per image, then the PNGs.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const entries = SIZES.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...pngs]));
  console.log(`wrote ${out} (${SIZES.join(", ")} px)`);
})().catch((e) => { console.error(e); process.exit(1); });
