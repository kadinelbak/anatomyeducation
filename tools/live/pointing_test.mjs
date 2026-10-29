// Browser check for src/live/pointing.js with the real segments.json and structures files.
//   python3 tools/serve.py --port 8133 &
//   node tools/live/pointing_test.mjs http://127.0.0.1:8133/ /opt/pw-browsers/chromium
import { createRequire } from "node:module";
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { chromium = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || "/opt/node22/lib/node_modules/playwright").chromium; }

const url = (process.argv[2] || "http://127.0.0.1:8133/").replace(/\/?$/, "/");
const executablePath = process.argv[3];
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const errors = [];
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("favicon.ico") && errors.push(`${r.status()} ${r.url()}`));
await page.goto(url + "tools/live/pointing_page.html");
await page.waitForFunction(() => window.ready);

const out = await page.evaluate(async () => {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, v: 1 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0, v: 1 }; };
  set(0, 0.5, 0.15); set(11, 0.6, 0.3); set(12, 0.4, 0.3);
  set(13, 0.65, 0.45); set(14, 0.35, 0.45); set(15, 0.68, 0.6); set(16, 0.32, 0.6);
  set(23, 0.56, 0.55); set(24, 0.44, 0.55);
  const tip = { x: 0.35 - 0.012, y: 0.51 };
  const h = Array.from({ length: 21 }, () => ({ x: tip.x - 0.1, y: tip.y, z: 0, v: 1 }));
  const hs = (i, dx, dy) => { h[i] = { x: tip.x - 0.1 + dx, y: tip.y + dy, z: 0, v: 1 }; };
  hs(5, 0.04, -0.012); hs(9, 0.04, -0.004); hs(13, 0.04, 0.004); hs(17, 0.04, 0.012);
  hs(8, 0.1, 0); hs(12, 0.045, -0.004); hs(16, 0.045, 0.004); hs(20, 0.045, 0.012);
  const frame = { t: 0, width: 1000, height: 1000, pose: { landmarks: lm, world: [], mask: null }, hands: [{ side: "left", landmarks: h, world: h, score: 1 }] };
  const p = await window.createPointer({ segmentsUrl: "assets/live/segments.json" });
  const result = p.update(frame);
  const forced = p.lock();
  const locked = p.update({ ...frame, t: 33 });
  p.unlock();
  const arm = await (await fetch("assets/model/structures.json")).json();
  return {
    result, forced, locked, unlocked: p.locked,
    armKeys: Object.keys(arm.structures),
    outline: p.outline(frame, "forearm", "right").length,
    outlines: p.outlines(frame).map((o) => o.label),
    hint: p.measure(frame).hint,
  };
});

let failures = 0;
const check = (name, ok, extra = "") => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const r = out.result;
check("forearm result", r && r.segment === "forearm" && r.side === "right", JSON.stringify(r));
check("structures non-empty", r && r.structures.length >= 5);
const known = new Set(out.armKeys);
const bad = (r?.structures || []).filter((s) => !known.has(s.key)).map((s) => s.key);
check("all keys exist in assets/model/structures.json", r && bad.length === 0, bad.join(", "));
check("outline polygon", out.outline === 12);
check("coarse label and progress", r?.coarse?.label === "Right forearm" && r.progress === 0 && r.locked === false && r.stable === false, JSON.stringify([r?.coarse, r?.progress]));
check("lock() locks, unlock() releases", out.forced === true && out.locked?.locked === true && out.locked.stable === true && out.unlocked === false, JSON.stringify([out.forced, out.locked?.locked, out.unlocked]));
check("outlines() labels every visible segment", out.outlines.includes("Right forearm") && out.outlines.includes("Trunk"), out.outlines.join(","));
check("measure() asks for the calibration stance", typeof out.hint === "string" && out.hint.length > 0, out.hint);
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
