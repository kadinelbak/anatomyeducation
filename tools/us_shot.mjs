// Screenshot every named ultrasound view of a study and check picking. Run: node tools/us_shot.mjs [studyId]
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/")("playwright")); }

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".gz": "application/gzip", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const study = process.argv[2] || "ts-s1042";
const pre = study === "ts-s1042" ? "" : study + "-";
await mkdir(join(ROOT, "tools/shots"), { recursive: true });

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text()); });
page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
await page.goto(`${base}/tools/us_page.html?study=${study}`);
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 120000 });
const err = await page.evaluate(() => window.__error);
if (err) { console.error(err); process.exit(1); }

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) fails++; };
const names = await page.evaluate(() => Object.keys(window.__us.debug.views));
check("named views exist", names.length >= 6, `${names.length}: ${names.join(", ")}`);

for (const name of names) {
  const r = await page.evaluate(async (name) => {
    const us = window.__us;
    await us.show({ view: name, layers: ["labels"] });
    const v = us.debug.views[name], vol = us.debug.volume, f = us.debug.frame;
    const counts = {};
    for (const l of f.labels) if (l) counts[l] = (counts[l] || 0) + 1;
    const frac = (key) => (counts[vol.valueOf(key)] || 0) / f.labels.length;
    const out = { label: v.label, expect: (v.expect || []).map((k) => ({ key: k, frac: frac(k), at: us.debug.canvasOf(k) })), ms: us.debug.frameMs };
    for (const e of out.expect) e.picked = e.at ? us.debug.pickAt(e.at[0], e.at[1]) : null;
    return out;
  }, name);
  await page.screenshot({ path: join(ROOT, `tools/shots/us-${pre}${name}.png`) });
  const first = r.expect[0];
  check(`${name}: pickAt(canvasOf(${first?.key})) === key`, !first || first.picked === first.key, `${(first?.frac * 100 || 0).toFixed(1)}%`);
  for (const e of r.expect) check(`${name}: ${e.key} >= 2% of fan`, e.frac >= 0.02, `${(e.frac * 100).toFixed(1)}% picked=${e.picked}`);
  console.log(`   ${name} frameMs=${r.ms.toFixed(1)} "${r.label}"`);
  // Plain (no outlines) copy to judge the image itself.
  await page.evaluate((name) => window.__us.show({ view: name, layers: [] }), name);
  await page.screenshot({ path: join(ROOT, `tools/shots/us-${pre}${name}-plain.png`) });
}

// Timing after the first frame, and a real click through pointer events with pick enabled.
const timing = await page.evaluate(() => { const us = window.__us; us.show({ view: Object.keys(us.debug.views)[0] }); const t = []; for (let n = 0; n < 8; n++) { us.debug.setPose({ angleDeg: us.debug.pose.angleDeg + 2 }); t.push(us.debug.frameMs); } return t; });
check("frameMs < 60 after the first frame", Math.max(...timing) < 60, `max ${Math.max(...timing).toFixed(1)} ms, mean ${(timing.reduce((a, b) => a + b, 0) / timing.length).toFixed(1)} ms`);
await page.evaluate(() => { window.__us.setPickEnabled(true); window.__picks.length = 0; });
const key = await page.evaluate(() => { const us = window.__us; const k = us.debug.views[Object.keys(us.debug.views)[0]].expect[0]; return k; });
const at = await page.evaluate((k) => window.__us.debug.canvasOf(k), key);
const rect = await page.evaluate(() => { const r = window.__us.debug.vpEl.getBoundingClientRect(); return [r.left, r.top]; });
await page.mouse.click(rect[0] + at[0], rect[1] + at[1]);
const picks = await page.evaluate(() => window.__picks.slice());
check("mouse click on canvasOf point calls onPick", picks[0] === key, `${key} -> ${picks}`);
// Keyboard and drag change the pose.
const p0 = await page.evaluate(() => ({ ...window.__us.debug.pose }));
await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("r");
await page.waitForTimeout(100);
const p1 = await page.evaluate(() => ({ ...window.__us.debug.pose }));
check("keys move the probe", p1.angleDeg !== p0.angleDeg && p1.frac !== p0.frac && p1.rotDeg !== p0.rotDeg, JSON.stringify(p1));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
