// Layout check for the X-ray and ultrasound toolbars at phone and desktop sizes, in quiz and explore mode.
// Asserts the toolbar (and each of its controls) overlaps no panel, bar or footer, that in explore mode it is
// fully on screen with every control reachable, the Back button works, hover shows the structure name and the
// Labels button toggles without errors. Screenshots go to tools/shots/layout-<kind>-<width>.png (quiz) and
// layout-<kind>-explore-<width>.png.   node tools/layout_test_xray_us.mjs    (PORT=n to use a running server)
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
  port = 8900 + Math.floor(Math.random() * 90);
  srv = spawn("python3", ["tools/serve.py", "--port", String(port)], { cwd: root, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
}
const base = `http://127.0.0.1:${port}/`;
const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const KINDS = {
  xray: { set: "xray:chest", toolbar: ".xr-toolbar", label: ".xr-label", region: "Chest", chip: /^X-ray$/ },
  ultrasound: { set: "us:abdomen", toolbar: ".us-toolbar", label: ".us-label", region: "Abdomen", chip: /^Ultrasound$/ },
};
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

// The top bar is a pointer-events:none strip with 10px padding, so its visible parts (brand, score pill) are compared, not its padding box.
// Overlap report computed in the page: toolbar + its controls against every visible chrome element.
const overlapScript = (toolbarSel) => {
  const vis = (e) => { if (!e || e.hidden) return null; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return null; const r = e.getBoundingClientRect(); return r.width && r.height ? r : null; };
  const tb = document.querySelector(`.mode-xray ${toolbarSel}, ${toolbarSel}`);
  const tbs = [...document.querySelectorAll(toolbarSel)].filter(vis);
  if (!tbs.length) return { error: "toolbar not visible" };
  const tbEl = tbs[0], parts = [tbEl, ...tbEl.querySelectorAll("button, input, label, span")].filter(vis);
  const others = { "#question": document.getElementById("question"), "#controls": document.getElementById("controls"), "#explore-bar": document.getElementById("explore-bar"), "#intro": document.getElementById("intro"), "top bar brand": document.querySelector("header.topbar .brand"), "top bar stats": document.querySelector("header.topbar .stats"), "footer": document.querySelector("footer.attribution") };
  const hits = [];
  for (const [name, e] of Object.entries(others)) {
    const o = vis(e); if (!o) continue;
    for (const p of parts) {
      const r = p.getBoundingClientRect();
      const w = Math.min(r.right, o.right) - Math.max(r.left, o.left), h = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top);
      if (w > 1 && h > 1) { hits.push(`${p.className || p.tagName} x ${name} (${Math.round(w)}x${Math.round(h)}px)`); break; }
    }
  }
  const t = tbEl.getBoundingClientRect();
  return { hits, rect: [t.left, t.top, t.right, t.bottom].map(Math.round), inViewport: t.left >= 0 && t.top >= 0 && t.right <= innerWidth && t.bottom <= innerHeight };
};

async function run(kind, [width, height]) {
  const K = KINDS[kind], tag = `${kind}@${width}`;
  const errors = [];
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 600 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
  const ready = () => page.waitForFunction(() => { const d = window.__app.switch.debug; return d && d.loading === 0; }, null, { timeout: 120000 });

  // Quiz mode.
  await page.goto(`${base}?set=${encodeURIComponent(K.set)}`);
  await idle();
  await page.click("#start");
  await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
  await ready(); await page.waitForTimeout(600);
  let r = await page.evaluate(overlapScript, K.toolbar);
  check(!r.error && r.hits.length === 0, `${tag} quiz: toolbar overlaps nothing ${r.error || (r.hits.length ? r.hits.join("; ") : `(toolbar ${r.rect})`)}`);
  await page.screenshot({ path: `${root}/tools/shots/layout-${kind}-${width}.png` });
  await page.close();

  // Explore mode.
  const p2 = await browser.newPage({ viewport: { width, height }, hasTouch: width < 600 });
  p2.on("pageerror", (e) => errors.push(e.message));
  p2.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await p2.goto(base);
  await p2.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 120000 });
  // Body map: open the region, then pick the modality from the explore bar.
  await p2.click(`#explore-row .chip:text-is("${K.region}")`);
  await p2.waitForFunction(() => !document.getElementById("explore-bar").hidden, null, { timeout: 120000 });
  const chips = await p2.$$("#explore-modalities .chip");
  let chip = null;
  for (const c of chips) if (K.chip.test((await c.textContent()).trim())) { chip = c; break; }
  if (!chip) { check(false, `${tag} explore: no modality matching ${K.chip} for ${K.region}`); await p2.close(); return; }
  await chip.click();
  await p2.waitForFunction((kind) => document.body.classList.contains("mode-" + kind), kind, { timeout: 120000 });
  await p2.waitForFunction(() => { const d = window.__app.switch.debug; return d && d.loading === 0; }, null, { timeout: 120000 });
  await p2.waitForTimeout(600);
  r = await p2.evaluate(overlapScript, K.toolbar);
  check(!r.error && r.hits.length === 0 && r.inViewport, `${tag} explore: toolbar overlaps nothing and is inside the viewport ${r.error || (r.hits.join("; ") + ` toolbar ${r.rect}`)}`);
  // Every control reachable: the element at its centre is the control itself.
  const unreachable = await p2.evaluate((sel) => {
    const tb = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width);
    const bad = [];
    for (const b of tb.querySelectorAll("button, input")) {
      const r = b.getBoundingClientRect(); if (!r.width) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!(hit === b || b.contains(hit) || hit?.closest("label")?.contains(b))) bad.push(`${b.textContent || b.getAttribute("aria-label") || b.className} under ${hit?.id || hit?.className}`);
    }
    return bad;
  }, K.toolbar);
  check(unreachable.length === 0, `${tag} explore: all toolbar controls reachable ${unreachable.join("; ")}`);
  const back = await p2.evaluate(() => { const b = document.getElementById("explore-back"), r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { ok: hit === b || b.contains(hit), vis: r.width > 0 && r.bottom <= innerHeight && r.right <= innerWidth }; });
  check(back.ok && back.vis, `${tag} explore: Back button reachable ${JSON.stringify(back)}`);
  // Hover a structure: its name appears.
  const pt = await p2.evaluate(() => { const d = window.__app.switch.debug, vr = d.vpEl.getBoundingClientRect(); for (const k of ["heart", "liver", "kidney_left", "spleen", "stomach", "aorta"]) { const c = d.canvasOf(k); if (c && d.pickAt(c[0], c[1]) === k) { const x = vr.left + c[0], y = vr.top + c[1]; if (document.elementFromPoint(x, y)?.closest(".xr-viewport, .us-viewport")) return { k, x, y }; } } return null; });
  if (!pt) check(false, `${tag} explore: no hoverable structure found`);
  else {
    await p2.mouse.move(pt.x - 3, pt.y - 3); await p2.mouse.move(pt.x, pt.y); await p2.waitForTimeout(300);
    const text = await p2.evaluate((s) => { const l = document.querySelector(s); return l && !l.hidden && getComputedStyle(l).display !== "none" ? l.textContent : ""; }, K.label);
    check(text.length > 0, `${tag} explore: hovering ${pt.k} shows name label "${text}"`);
  }
  // Labels button.
  const before = errors.length;
  await p2.click(`${K.toolbar} button:text-is('Labels')`);
  await p2.waitForTimeout(400);
  const active = await p2.evaluate((s) => document.querySelector(`${s} button.xr-active, ${s} button.us-active`) && [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent === "Labels")?.className, K.toolbar);
  check(errors.length === before && /active/.test(active || ""), `${tag} explore: Labels toggles on without errors (${active})`);
  await p2.screenshot({ path: `${root}/tools/shots/layout-${kind}-explore-${width}.png` });
  await p2.click("#explore-back");
  check(await p2.evaluate(() => !document.getElementById("intro").hidden && document.getElementById("explore-bar").hidden), `${tag} explore: Back returns to the intro`);
  check(errors.length === 0, `${tag}: no page errors ${errors.join("; ")}`);
  await p2.close();
}

const kinds = process.env.KIND ? [process.env.KIND] : Object.keys(KINDS);
for (const kind of kinds) {
  const bank = fs.existsSync(path.join(root, "assets/questions")) && fs.readdirSync(path.join(root, "assets/questions")).some((f) => f.startsWith(kind === "xray" ? "xray" : "us"));
  if (!bank) { console.log(`skip ${kind}: no bank`); continue; }
  for (const sz of [[1280, 800], [390, 844]]) await run(kind, sz).catch((e) => check(false, `${kind}@${sz[0]} threw ${e.message.split("\n")[0]}`));
}
await browser.close();
if (srv) srv.kill();
console.log(fails ? `${fails} failure(s)` : "all layout checks passed");
process.exit(fails ? 1 : 0);
