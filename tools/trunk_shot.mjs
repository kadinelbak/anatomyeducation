// Screenshot the trunk model from the body map (chest, organs layer on): node tools/trunk_shot.mjs [base]
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:8124/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 180000 });
await page.goto(base); await idle();
await page.click("#explore-row .chip[data-region='abdomen']"); await idle();
await page.click("#controls-toggle").catch(() => {});
await page.check("input[data-layer='organ']").catch((e) => console.log("no organ checkbox", e.message));
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/screenshots/trunk-abdomen.png" });
console.log("model:", await page.evaluate(() => window.__app.switch.model), "layers:", await page.$$eval("input[data-layer]", (b) => b.filter((x) => x.checked).map((x) => x.dataset.layer).join(",")));
await browser.close();
