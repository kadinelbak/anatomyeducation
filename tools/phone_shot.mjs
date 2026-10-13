import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
const openMenu = async () => { if (await page.$eval("#region-menu", (e) => e.hidden)) await page.click("#region-crumb"); }; // chips and zoom buttons live in the region dropdown
await page.goto("http://127.0.0.1:8000/"); await idle();
await page.screenshot({ path: "docs/screenshots/phone-bodymap.png" });
await page.click("#explore-row .chip[data-region='lower-limb']"); await idle(); await page.waitForTimeout(500);
await page.screenshot({ path: "docs/screenshots/phone-explore-3d.png" });
await page.click("#explore-back");
await page.click("#explore-row .chip[data-region='abdomen']"); await idle(); await page.waitForTimeout(500);
await page.screenshot({ path: "docs/screenshots/phone-explore-ct.png" });
await openMenu(); await page.click("#explore-modalities .chip:text-is('Ultrasound')"); await idle(); await page.waitForTimeout(500);
await page.screenshot({ path: "docs/screenshots/phone-explore-us.png" });
await browser.close();
