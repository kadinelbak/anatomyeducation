// Browser check of the cell diagram view: explore labels and hover names, the Diagram / 3D switch and its footer
// line, and one question answered by clicking the diagram (labels hidden while asking, green mark after).
//   node tools/diagram_ui_test.mjs [study ...]      default: every study with a diagram; screenshots in tools/shots/
//   SIZES=1280x800,390x844 to change sizes; PORT=8123 to use a running server.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sizes = (process.env.SIZES || "1280x800,390x844").split(",").map((s) => s.split("x").map(Number));
const studies = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.join(root, "assets/cells"))
  .filter((d) => JSON.parse(fs.readFileSync(path.join(root, "assets/cells", d, "study.json"), "utf8")).diagram);
const qs = JSON.parse(fs.readFileSync(path.join(root, "assets/questions/cells-limb.json"), "utf8")).questions;
let srv = null, port = Number(process.env.PORT || 0);
if (!port) {
  port = 8200 + Math.floor(Math.random() * 700);
  srv = spawn("python3", ["tools/serve.py", "--port", String(port)], { cwd: root, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
}
const base = `http://127.0.0.1:${port}/`;
const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const fails = [], errors = [];
const shots = path.join(root, "tools/shots");
fs.mkdirSync(shots, { recursive: true });
const check = (cond, msg) => { if (!cond) fails.push(msg); return cond; };

for (const [width, height] of sizes) for (const sid of studies) {
  const tag = `${sid}@${width}`;
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 600 });
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${tag}: ${m.text()}`));
  const q = qs.find((x) => x.study === sid);
  try {
    // 1. A question: labels hidden, click the target region, expect a correct verdict and a green mark.
    await page.goto(`${base}?set=${encodeURIComponent(`cell:${q.tags.region}`)}&q=${q.id}`);
    await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 120000 });
    await page.click("#start");
    await page.waitForFunction(() => { const d = window.__app.switch.debug; return d && d.state && !d.loading && d.state.pickEnabled && d.svg; }, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    const qi = await page.evaluate((key) => {
      const d = window.__app.switch.debug, r = d.root.getBoundingClientRect(), c = d.canvasOf(key);
      return { mode: window.__app.switch.cell.mode, labelsHidden: d.svg.classList.contains("dg-nolabels"), at: c && [r.left + c[0], r.top + c[1]], got: c && d.pickAt(c[0], c[1]) };
    }, q.target);
    check(qi.mode === "diagram", `${tag}: question opened in ${qi.mode}`);
    check(qi.labelsHidden, `${tag}: labels visible during a question`);
    if (check(qi.at && q.accept.includes(qi.got), `${tag}: target ${q.target} not pickable (got ${qi.got})`)) {
      await page.mouse.click(qi.at[0], qi.at[1]);
      await page.waitForSelector("#feedback:not([hidden])", { timeout: 4000 });
      const fb = (await page.textContent("#feedback")).trim();
      check(!/not quite/i.test(fb), `${tag}: click on ${q.target} judged wrong: ${fb.slice(0, 80)}`);
      const marked = await page.evaluate(() => window.__app.switch.debug.svg.querySelectorAll(".dg-good").length);
      check(marked > 0, `${tag}: no green mark after answering`);
    }
    await page.screenshot({ path: path.join(shots, `diagram-ui-${sid}-${width}-question.png`) });

    // 2. Explore: labels on, hover names a part, the 3D switch swaps the view and the footer line, and back.
    await page.evaluate((id) => window.__app.openExplore("cell", id), sid);
    await page.waitForFunction(() => { const d = window.__app.switch.debug; return d && d.state && !d.loading && !d.state.pickEnabled && d.svg && window.__app.switch.active === "cell"; }, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    const ex = await page.evaluate(() => {
      const d = window.__app.switch.debug, r = d.root.getBoundingClientRect(), c = d.canvasOf("nucleus") || d.canvasOf("nucleus-1") || d.canvasOf("soma");
      return { labels: !d.svg.classList.contains("dg-nolabels"), at: c && [r.left + c[0], r.top + c[1]], attr: document.getElementById("attr-cell").textContent };
    });
    check(ex.labels, `${tag}: labels hidden in explore`);
    check(/diagram/i.test(ex.attr), `${tag}: footer does not credit the diagram: ${ex.attr}`);
    if (width >= 600 && ex.at) {
      await page.mouse.move(ex.at[0], ex.at[1]);
      await page.waitForTimeout(100);
      const lab = await page.evaluate(() => { const l = document.querySelector(".cl-label"); return l.hidden ? "" : l.textContent; });
      check(/nucle|soma/i.test(lab), `${tag}: hover label is "${lab}"`);
    }
    await page.screenshot({ path: path.join(shots, `diagram-ui-${sid}-${width}-explore.png`) });
    await page.click(".cl-btn.cl-mode:nth-of-type(2), button[title='Stylised 3D model']");
    await page.waitForTimeout(400);
    const td = await page.evaluate(() => ({ mode: window.__app.switch.cell.mode, canvas: !document.querySelector(".cl-viewport").hidden, attr: document.getElementById("attr-cell").textContent }));
    check(td.mode === "3d" && td.canvas, `${tag}: 3D switch did not show the model`);
    check(/3D model/.test(td.attr), `${tag}: footer after 3D switch: ${td.attr}`);
    await page.click("button[title='Labelled 2D diagram']");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__app.switch.cell.mode === "diagram"), `${tag}: Diagram switch did not come back`);
  } catch (e) { fails.push(`${tag}: ${String(e.message).split("\n")[0]}`); }
  await page.close();
}
await browser.close();
if (srv) srv.kill();
for (const f of fails) console.log("FAIL", f);
if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].join("\n  "));
console.log(`${studies.length} studies x ${sizes.length} sizes, ${fails.length} failure(s), ${errors.length} page error(s)`);
process.exit(fails.length || errors.length ? 1 : 0);
