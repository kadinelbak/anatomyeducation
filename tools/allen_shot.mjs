// Screenshot each real (Allen) cell study in explore mode: node tools/allen_shot.mjs [base]
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:8124/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(base);
await page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
for (const id of ["allen-mitochondria", "allen-er", "allen-golgi", "allen-nucleolus"]) {
  const t0 = Date.now();
  await page.evaluate((id) => window.__app.switch.activate("cell", id), id);
  await page.waitForFunction(() => { const d = window.__app.switch.debug; return d && !d.loading; }, null, { timeout: 120000 });
  await page.evaluate(() => { document.getElementById("intro").hidden = true; });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `docs/screenshots/${id}.png` });
  const n = await page.evaluate(() => Object.keys(window.__app.switch.cell?.debug?.meshes ?? {}).length);
  console.log(id, "loaded in", Date.now() - t0, "ms, parts:", n);
}
await browser.close();
