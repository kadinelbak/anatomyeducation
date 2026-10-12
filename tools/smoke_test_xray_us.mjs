// End-to-end click test for the X-ray and ultrasound renderers, modelled on playCT in smoke_test.mjs.
// For every question it asks the renderer where the target (then each accepted structure) is on screen
// (debug.canvasOf), checks pickAt() agrees and that nothing covers the point, then does a real mouse click.
//
//   node tools/smoke_test_xray_us.mjs                      xray, first set, desktop and phone
//   KIND=ultrasound node tools/smoke_test_xray_us.mjs      ultrasound
//   ALL=1 ...                                              every set of that kind
//   SET=xray:chest ...                                     one set      SIZES=1280x800,390x844 to change sizes
//   PORT=8123 to use a server that is already running (otherwise tools/serve.py is started).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kind = process.env.KIND || "xray";
const sizes = (process.env.SIZES || "1280x800,390x844").split(",").map((s) => s.split("x").map(Number));

// Sets of this kind, derived from the banks the way sets.js ids them ("xray:<region>", "us:<region>").
const dir = path.join(root, "assets/questions");
const qs = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).questions).filter((q) => q.renderer === kind);
const prefix = kind === "xray" ? "xray" : "us";
const allSets = [...new Set(qs.map((q) => `${prefix}:${q.tags?.region || q.study}`))];
const sets = process.env.SET ? [process.env.SET] : allSets;
if (!process.env.ALL && !process.env.SET) sets.splice(1);
if (!sets.length) { console.log(`no ${kind} sets found`); process.exit(1); }

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
const rows = [], errors = [];

async function playSet(setId, [width, height]) {
  const phone = width < 600;
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: phone });
  page.on("pageerror", (e) => errors.push(`${setId}@${width}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${setId}@${width}: ${m.text()}`));
  const size = `${width}x${height}`;
  const rec = (id, result, reason = "") => rows.push({ set: setId, size, id, result, reason });
  try {
    // ?q= plays every question of the set (a normal set deals a random 10); ?set= gives it the right title.
    const ids = qs.filter((q) => `${prefix}:${q.tags?.region || q.study}` === setId).map((q) => q.id);
    await page.goto(`${base}?set=${encodeURIComponent(setId)}&q=${ids.join(",")}`);
    await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 120000 });
    await page.click("#start");
    await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
    const n = await page.evaluate(() => window.__app.QUESTIONS.length);
    for (let i = 0; i < n; i++) {
      await page.waitForFunction(() => { const d = window.__app.switch.debug; return d.loading === 0 && d.state.pickEnabled; }, null, { timeout: 60000 });
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => {
        const a = window.__app, q = a.QUESTIONS[a.quiz.index], d = a.switch.debug, vr = d.vpEl.getBoundingClientRect();
        const cards = ["question", "intro", "controls"].map((id) => document.getElementById(id).getBoundingClientRect());
        const cands = [], whys = [];
        for (const key of [q.target, ...q.accept].filter((k, j, arr) => k && arr.indexOf(k) === j)) {
          const c = d.canvasOf(key);
          if (!c) { whys.push(`${key}: no canvasOf`); continue; }
          const x = vr.left + c[0], y = vr.top + c[1];
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { whys.push(`${key}: off screen`); continue; }
          const got = d.pickAt(c[0], c[1]);
          if (!q.accept.includes(got)) { whys.push(`${key}: pick mismatch (got ${got})`); continue; }
          const hit = document.elementFromPoint(x, y);
          if (!hit || !d.vpEl.contains(hit)) { whys.push(`${key}: covered by ${hit ? (hit.closest("[id]")?.id || hit.className || hit.tagName) : "nothing"}`); continue; }
          if (cards.some((r) => r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) { whys.push(`${key}: under a panel`); continue; }
          cands.push({ key, x, y });
        }
        // The one point canvasOf gives may sit under the panel while other pixels of the structure are free:
        // scan the viewport on a grid for any pickable, uncovered pixel of an accepted structure.
        if (!cands.length) {
          for (let y = 4; y < vr.height && !cands.length; y += 6) for (let x = 4; x < vr.width; x += 6) {
            const px = vr.left + x, py = vr.top + y;
            if (px > innerWidth || py > innerHeight) continue;
            const got = d.pickAt(x, y);
            if (!q.accept.includes(got)) continue;
            const hit = document.elementFromPoint(px, py);
            if (!hit || !d.vpEl.contains(hit)) continue;
            if (cards.some((r) => r.width && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) continue;
            cands.push({ key: got + " (grid)", x: px, y: py, grid: true }); break;
          }
        }
        return { id: q.id, cands, whys, quizIndex: a.quiz.index };
      });
      let ok = false, reason = "";
      if (!info.cands.length) reason = info.whys.join("; ") || "no candidate";
      for (const c of info.cands) {
        await page.mouse.click(c.x, c.y);
        try {
          await page.waitForSelector("#feedback:not([hidden])", { timeout: 3000 });
          const verdict = await page.evaluate(() => document.getElementById("feedback").textContent.trim().slice(0, 60));
          ok = true; reason = `${c.grid ? "canvasOf point covered; " : ""}clicked ${c.key} at ${Math.round(c.x)},${Math.round(c.y)}`;
          if (/not quite/i.test(verdict)) { ok = false; reason = `click on ${c.key} judged wrong: ${verdict}`; }
          break;
        } catch { reason = `click on ${c.key} gave no feedback`; }
      }
      rec(info.id, ok ? "ok" : "FAIL", reason);
      if (!(await page.evaluate(() => !document.getElementById("feedback").hidden))) await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[window.__app.quiz.index].accept[0]));
      await page.waitForSelector("#feedback:not([hidden])", { timeout: 5000 });
      const before = info.quizIndex;
      await page.click("#next");
      if (i < n - 1) {
        await page.waitForFunction((b) => window.__app.quiz.index > b, before, { timeout: 5000 }).catch(() => rec(info.id, "FAIL", "quiz.index did not advance after Next"));
      }
    }
    await page.waitForSelector("#results:not([hidden])", { timeout: 10000 });
    console.log(`${setId} @ ${size}: ${(await page.textContent("#final-score")).trim()}; share: ${await page.evaluate(() => window.__app.engine.shareText())}`);
  } catch (e) {
    rec("(set)", "FAIL", String(e.message).split("\n")[0]);
  }
  await page.close();
}

for (const s of sets) for (const sz of sizes) await playSet(s, sz);
await browser.close();
if (srv) srv.kill();

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + pad("set", 14) + pad("size", 10) + pad("question", 34) + pad("result", 7) + "reason");
for (const r of rows) console.log(pad(r.set, 14) + pad(r.size, 10) + pad(r.id, 34) + pad(r.result, 7) + r.reason);
const fails = rows.filter((r) => r.result !== "ok");
if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].join("\n  "));
console.log(`\n${rows.length - fails.length}/${rows.length} ok, ${fails.length} failing, ${errors.length} page error(s)`);
process.exit(fails.length || errors.length ? 1 : 0);
