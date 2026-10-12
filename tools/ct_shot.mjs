// Screenshot a scan question at a given viewport, to check the panel stays clear of the toolbar.
import { chromium } from "playwright";
const [base, out, w, h, set = "ct:chest"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, hasTouch: Number(w) < 500 });
await page.goto(`${base}?set=${set}`);
await page.waitForFunction(() => !document.getElementById("start").disabled && document.getElementById("loading").hidden, null, { timeout: 120000 });
await page.click("#start");
await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
await page.waitForFunction(() => !window.__app.switch.debug.loading, null, { timeout: 60000 });
await page.waitForTimeout(800);
// Overlap check: toolbar rect vs card rect.
const r = await page.evaluate(() => {
  const a = document.querySelector("#question").getBoundingClientRect(), b = document.querySelector(".vol-root:not([hidden]) .vol-toolbar").getBoundingClientRect();
  const overlap = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  return { overlap, card: [a.left, a.top, a.right, a.bottom].map(Math.round), toolbar: [b.left, b.top, b.right, b.bottom].map(Math.round) };
});
console.log(`${w}x${h} ${r.overlap ? "OVERLAP" : "clear"} card=${r.card} toolbar=${r.toolbar}`);
await page.screenshot({ path: out });
await browser.close();
process.exit(r.overlap ? 1 : 0);
