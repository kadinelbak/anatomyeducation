// Screenshot each real histology slide at its default view: node tools/histology_shot.mjs [base]
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:8124/";
const ids = ["muscle-ls", "muscle-ts", "nerve-ts", "artery-ts"];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 180000 });
const settle = async () => {
  await page.waitForFunction(() => !(window.__app && window.__app.switch && window.__app.switch.debug && window.__app.switch.debug.loading), null, { timeout: 180000 });
  await page.waitForTimeout(1000);
};
await page.goto(base); await idle();
await page.click("#explore-row .chip[data-region='tissue']"); await idle();
await page.click("#explore-modalities .chip:text-is('Histology')"); await idle();
await settle();
for (const id of ids) {
  await page.selectOption("#explore-study", id);
  await settle();
  await page.screenshot({ path: `docs/screenshots/histology-real-${id}.png` });
  console.log(id, "footer:", await page.evaluate(() => (document.getElementById("attr-hist") || {}).textContent));
}
await browser.close();
