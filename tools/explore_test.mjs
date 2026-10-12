// Explore mode: models and studies open from the intro without a quiz, and set chips switch the backdrop.
import { chromium } from "playwright";
const base = process.argv[2], exe = process.argv[3];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const st = () => page.evaluate(() => ({
  intro: !document.getElementById("intro").hidden, bar: !document.getElementById("explore-bar").hidden,
  title: document.getElementById("explore-title").textContent, active: window.__app.switch.active,
  model: window.__app.switch.model, study: window.__app.switch.study, volume: document.body.classList.contains("mode-volume"),
  quiz: window.__app.quiz.state, loading: !document.getElementById("loading").hidden,
}));
const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
await page.goto(base);
await idle();
const entries = await page.$$eval("#explore-row .chip", (b) => b.map((x) => x.textContent));
console.log("explore entries:", entries.join(" | "));
check(entries[0] === "Upper limb" && entries[1] === "Lower limb" && entries.some((e) => e.startsWith("CT:")) && entries.some((e) => e.startsWith("MRI:")), "entries cover both models and scans");
// Explore the lower limb.
await page.click("#explore-row .chip:text-is('Lower limb')");
await idle();
let s = await st();
check(!s.intro && s.bar && s.model === "lower-limb" && s.quiz === "intro" && s.title === "Lower limb", `explore lower limb: ${JSON.stringify(s)}`);
check(await page.evaluate(() => getComputedStyle(document.getElementById("controls")).display !== "none"), "layer controls visible while exploring a model");
await page.screenshot({ path: "docs/screenshots/explore-lower-limb.png" });
// Hover names work (pick disabled): click a bone and expect a label.
await page.click("#zoom-row [data-focus='knee']"); await page.waitForTimeout(800);
await page.mouse.click(640, 400); await page.waitForTimeout(200);
console.log("hover label:", await page.evaluate(() => document.getElementById("hover-label").hidden ? "(none)" : document.getElementById("hover-label").textContent));
// Back, then explore a scan.
await page.click("#explore-back");
s = await st(); check(s.intro && !s.bar, "back to the intro");
await page.click("#explore-row .chip:text-matches('^MRI: Pelvis')");
await idle();
s = await st();
check(!s.intro && s.bar && s.active === "volume" && s.study === "msd-prostate-04" && s.volume, `explore MRI pelvis: ${JSON.stringify(s)}`);
check(await page.evaluate(() => !!document.querySelector(".vol-root:not([hidden]) .vol-toolbar")), "scan toolbar visible");
await page.click("#explore-back");
// Choosing a set chip switches the backdrop without starting.
await page.click(".chip:text-is('CT: Chest')");
await idle();
s = await st();
check(s.intro && s.active === "volume" && s.quiz === "intro" && /^ts-s/.test(s.study), `chip switches backdrop to CT chest: ${JSON.stringify(s)}`);
await (await page.$$(".chip:text-is('Daily 10')"))[0].click();
await idle();
s = await st();
check(s.intro && s.active === "mesh" && s.model === "upper-limb", `chip switches back to the upper limb: ${s.model}`);
// And a quiz still starts from there.
await page.click("#start");
await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
check((await st()).quiz === "asking", "quiz starts after exploring");
await browser.close();
console.log(fails ? `${fails} failure(s)` : "ALL OK");
process.exit(fails ? 1 : 0);
