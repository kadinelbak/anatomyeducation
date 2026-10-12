import { chromium } from "playwright";
const [base, out, w, h] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
await page.goto(base);
await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
await page.waitForTimeout(500);
await page.screenshot({ path: out });
await browser.close();
