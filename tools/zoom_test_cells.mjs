// Zoom path test (organ -> tissue -> cell): explore entries exist for slides and cells, the explore bar carries
// zoom chips that open the linked study or model, an answered question offers its zoom links, and at phone width
// the slide and cell toolbars sit clear of the question panel. Run from the app root after integration:
//   node tools/zoom_test_cells.mjs        (PORT=n to use a running server)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(root, "tools/shots"), { recursive: true });
let port = Number(process.env.PORT || 0), srv = null;
if (!port) {
  port = 8300 + Math.floor(Math.random() * 600);
  srv = spawn("python3", ["tools/serve.py", "--port", String(port)], { cwd: root, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
}
const base = `http://127.0.0.1:${port}/`;
const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let fails = 0; const errors = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const st = (page) => page.evaluate(() => ({
  intro: !document.getElementById("intro").hidden, bar: !document.getElementById("explore-bar").hidden,
  title: document.getElementById("explore-title").textContent, active: window.__app.switch.active,
  model: window.__app.switch.model, study: window.__app.switch.study, quiz: window.__app.quiz.state,
  chips: [...document.querySelectorAll("#explore-zoom .chip")].map((b) => b.textContent),
}));
const idle = (page) => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
const settled = (page) => page.waitForFunction(() => { const d = window.__app.switch.debug; return !d || !d.loading; }, null, { timeout: 60000 });

const dir = path.join(root, "assets/questions");
const banks = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).questions);
const slideQ = banks.find((q) => q.renderer === "slide" && q.zoom?.in);
const cellQ = banks.find((q) => q.renderer === "cell" && q.zoom?.out);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base); await idle(page);
  // The body map lists a "Tissues and cells" entry whose modalities are Histology and Cell.
  const entries = await page.$$eval("#explore-row .chip", (b) => b.map((x) => x.textContent));
  console.log("body map entries:", entries.join(" | "));
  check(entries.includes("Tissues and cells"), "body map has a Tissues and cells entry");
  await page.click("#explore-row .chip:text-is('Tissues and cells')");
  await idle(page); await settled(page); await page.waitForTimeout(600);
  const mods = await page.$$eval("#explore-modalities .chip", (b) => b.map((x) => x.textContent));
  check(mods.includes("Histology") && mods.includes("Cell"), `modality chips: ${mods.join(" | ")}`);
  // Explore the muscle slide (the most-asked slide opens first; pick it by title if not).
  await page.click("#explore-modalities .chip:text-is('Histology')").catch(() => {});
  await idle(page); await settled(page); await page.waitForTimeout(400);
  const picks = await page.$$eval("#explore-study option", (o) => o.map((x) => [x.value, x.textContent]));
  console.log("study picker:", picks.map((p) => p[1]).join(" | "));
  check(picks.length === 5 && picks.every((p) => !/^Study: (cl |muscle |bone |nerve |artery )/.test(p[1])), "study picker lists the five slides by manifest title");
  if ((await page.$eval("#explore-study", (e) => e.value)) !== "muscle-ls") { await page.selectOption("#explore-study", "muscle-ls"); await idle(page); await settled(page); await page.waitForTimeout(600); }
  let s = await st(page);
  check(!s.intro && s.bar && s.active === "slide" && s.quiz === "intro", `explore slide: ${JSON.stringify({ ...s, chips: s.chips.length })}`);
  check(s.chips.some((c) => c.startsWith("Zoom in: ")) && s.chips.some((c) => c.startsWith("Zoom out: ")), `slide explore bar has zoom chips: ${s.chips.join(" | ")}`);
  check(await page.evaluate(() => getComputedStyle(document.getElementById("controls")).display === "none"), "layer controls hidden on a slide");
  await page.screenshot({ path: "tools/shots/zoom-slide-explore.png" });
  // Zoom in to a cell.
  await page.click("#explore-zoom .chip:text-matches('^Zoom in: ')");
  await idle(page); await settled(page); await page.waitForTimeout(600);
  s = await st(page);
  check(s.active === "cell" && s.bar && /^cl-|^generic/.test(s.study || ""), `zoom in opened a cell: ${s.study} (${s.title})`);
  check(s.chips.some((c) => c.startsWith("Zoom out: ")), `cell explore bar offers zoom out: ${s.chips.join(" | ")}`);
  await page.screenshot({ path: "tools/shots/zoom-cell-explore.png" });
  // Zoom out to the slide, then out again to the model with the structure highlighted.
  await page.click("#explore-zoom .chip:text-matches('^Zoom out: ')");
  await idle(page); await settled(page); await page.waitForTimeout(400);
  s = await st(page);
  check(s.active === "slide", `zoom out returned to the slide: ${s.study}`);
  await page.click("#explore-zoom .chip:text-matches('^Zoom out: ')");
  await idle(page); await page.waitForTimeout(800);
  s = await st(page);
  check(s.active === "mesh" && s.bar, `zoom out reached the model: ${s.model} (${s.title})`);
  check(await page.evaluate(() => getComputedStyle(document.getElementById("controls")).display !== "none"), "layer controls back on the model");
  await page.screenshot({ path: "tools/shots/zoom-model.png" });
  await page.click("#explore-back"); await page.waitForTimeout(200);
  s = await st(page);
  check(s.intro && !s.bar, "Back to the body map returns to the intro");
  // A question's zoom links appear under its explanation and open the linked study.
  if (slideQ) {
    await page.goto(`${base}?set=hist:${encodeURIComponent(slideQ.tags.region)}&q=${slideQ.id}`); await idle(page);
    await page.click("#start"); await page.waitForSelector("#question:not([hidden])", { timeout: 60000 });
    await settled(page); await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[0].accept[0]));
    await page.waitForSelector("#feedback:not([hidden])", { timeout: 5000 });
    const chips = await page.$$eval("#feedback-zoom .chip", (b) => b.map((x) => x.textContent));
    check(chips.some((c) => c.startsWith("Zoom in: ")), `answered slide question offers zoom links: ${chips.join(" | ")}`);
    await page.click("#feedback-zoom .chip:text-matches('^Zoom in: ')");
    await idle(page); await settled(page); await page.waitForTimeout(600);
    s = await st(page);
    check(s.active === "cell" && s.bar && s.quiz === "intro", `question zoom link opened the cell in explore mode: ${s.study}`);
  } else check(false, "no slide question with a zoom.in link");
  if (cellQ) {
    await page.goto(`${base}?set=cell:${encodeURIComponent(cellQ.tags.region)}&q=${cellQ.id}`); await idle(page);
    await page.click("#start"); await page.waitForSelector("#question:not([hidden])", { timeout: 60000 });
    await settled(page); await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[0].accept[0]));
    await page.waitForSelector("#feedback:not([hidden])", { timeout: 5000 });
    const chips = await page.$$eval("#feedback-zoom .chip", (b) => b.map((x) => x.textContent));
    check(chips.some((c) => c.startsWith("Zoom out: ")), `answered cell question offers zoom out: ${chips.join(" | ")}`);
  } else check(false, "no cell question with a zoom.out link");
  await page.close();
  // Phone layout: the toolbar of each kind must sit above the question panel while a question is open.
  for (const [kind, sel] of [["slide", ".sl-toolbar"], ["cell", ".cl-toolbar"]]) {
    const q = banks.find((x) => x.renderer === kind);
    if (!q) { check(false, `no ${kind} question`); continue; }
    const p = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    p.on("pageerror", (e) => errors.push(e.message));
    const prefix = kind === "slide" ? "hist" : "cell";
    await p.goto(`${base}?set=${prefix}:${encodeURIComponent(q.tags.region)}&q=${q.id}`); await idle(p);
    await p.click("#start"); await p.waitForSelector("#question:not([hidden])", { timeout: 60000 });
    await settled(p); await p.waitForTimeout(600);
    const r = await p.evaluate((sel) => {
      const tb = document.querySelector(sel)?.getBoundingClientRect(), qc = document.getElementById("question").getBoundingClientRect();
      const ctrls = [...document.querySelectorAll(`${sel} button, ${sel} input`)].map((e) => e.getBoundingClientRect());
      return { tbBottom: tb ? Math.round(tb.bottom) : null, qTop: Math.round(qc.top), overflow: document.documentElement.scrollWidth > innerWidth,
        offscreen: ctrls.filter((c) => c.right > innerWidth || c.bottom > qc.top).length };
    }, sel);
    check(r.tbBottom !== null && r.tbBottom <= r.qTop && !r.overflow && r.offscreen === 0, `${kind} at 390px: toolbar bottom ${r.tbBottom}, question top ${r.qTop}, ${r.offscreen} controls covered or off screen, overflow ${r.overflow}`);
    await p.screenshot({ path: `tools/shots/zoom-${kind}-phone.png` });
    await p.close();
  }
} finally {
  await browser.close(); if (srv) srv.kill();
}
if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].join("\n  "));
console.log(`${fails} failing, ${errors.length} page error(s)`);
process.exit(fails || errors.length ? 1 : 0);
