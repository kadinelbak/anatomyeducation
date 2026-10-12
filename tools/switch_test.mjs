import { chromium } from "playwright";
const base = process.argv[2], exe = process.argv[3];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
await page.goto(base);
await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
const groups = await page.$$eval(".chooser-group", (els) => els.map((e) => e.textContent));
check(groups.join("|") === "Upper limb|Lower limb|Scans|X-ray|Ultrasound|Histology|Cells", `chooser groups: ${groups.join(" | ")}`);
const dom = () => page.evaluate(() => ({
  zoom: [...document.querySelectorAll("#zoom-row [data-focus]")].map((b) => b.textContent).join(","),
  views: [...document.querySelectorAll("[data-view]")].map((b) => b.textContent).join(","),
  bp3d: !document.getElementById("attr-bp3d").hidden, o3d: !document.getElementById("attr-o3d").hidden,
  model: window.__app.switch.model, canvases: [...document.querySelectorAll(".viewer-mesh canvas")].map((c) => c.hidden).join(","),
  layers: [...document.querySelectorAll("input[data-layer]")].filter((b) => !b.closest("label").hidden).map((b) => b.dataset.layer).join(","),
}));
let d = await dom();
check(d.model === "upper-limb" && d.zoom === "Hand,Forearm,Arm,Shoulder,All" && d.views === "Palm,Back,Thumb side" && d.o3d && !d.bp3d, `upper limb first: ${JSON.stringify(d)}`);
// Lower limb daily: the second "Daily 10" chip.
await (await page.$$(".chip:text-is('Daily 10')"))[1].click();
await page.click("#start");
await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
d = await dom();
check(d.model === "lower-limb" && d.zoom === "Hip,Thigh,Knee,Leg,Ankle,Foot,All" && d.views === "Front,Back,Lateral" && d.o3d && !d.bp3d && d.canvases === "false,true" || d.canvases === "true,false", `lower limb active: ${JSON.stringify(d)}`);
check(d.canvases.split(",").filter((h) => h === "false").length === 1, "exactly one mesh canvas visible");
const q = await page.evaluate(() => window.__app.QUESTIONS[0]);
check(q.model === "lower-limb", `question is lower limb: ${q.id}`);
await page.waitForTimeout(900);
await page.screenshot({ path: "docs/screenshots/lower-limb-question.png" });
await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[0].accept[0]));
await page.waitForSelector("#feedback:not([hidden])");
check((await page.textContent("#verdict")).startsWith("Correct"), "answer accepted on the lower limb");
// Zoom button click works on the active renderer.
await page.click("#zoom-row [data-focus='foot']");
check(await page.evaluate(() => window.__app.viewTween.active), "zoom button drives the active model");
// Back to the chooser and play upper limb.
await page.evaluate(() => { for (let i = 0; i < 10; i++) { window.__app.engine.next(); if (window.__app.quiz.state === "done") break; window.__app.answer(window.__app.QUESTIONS[window.__app.quiz.index].accept[0]); } });
await page.waitForSelector("#results:not([hidden])");
check((await page.evaluate(() => window.__app.engine.shareText())).includes("Daily 10"), "share text");
await page.click("#new-set");
d = await dom();
check(d.model === "lower-limb" && d.o3d, `chooser keeps the last model: ${d.model}`);
await (await page.$$(".chip:text-is('Clinical cases')"))[0].click();
await page.click("#start");
await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
d = await dom();
check(d.model === "upper-limb" && d.zoom === "Hand,Forearm,Arm,Shoulder,All" && d.views === "Palm,Back,Thumb side" && d.o3d && !d.bp3d, `back on the upper limb: ${JSON.stringify(d)}`);
const q2 = await page.evaluate(() => window.__app.QUESTIONS[0]);
check(q2.model === "upper-limb" && q2.kind === "Clinical", `question is upper limb clinical: ${q2.id}`);
await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[0].accept[0]));
await page.waitForSelector("#feedback:not([hidden])");
check((await page.textContent("#verdict")).startsWith("Correct"), "answer accepted on the upper limb after switching");
// Share link to a lower-limb set loads the lower model directly.
await page.goto(base + "?set=lower-limb:daily");
await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
d = await dom();
check(d.model === "lower-limb" && d.o3d, `?set=lower-limb:daily preloads the lower limb: ${d.model}`);
await browser.close();
console.log(fails ? `${fails} failure(s)` : "ALL OK");
process.exit(fails ? 1 : 0);
