// Mesh-based cell studies (study.json "model" + part "mesh"): renders tools/fixtures/glb-cell in headless Chromium.
// Checks pixels, picking by click, labels, cutaway, highlight, and the base64 text path (window.__CONFIG_TEXT_ASSETS).
//   node tools/cell_glb_test.mjs        (PORT=8124 to use a running server, else tools/serve.py is started on 8131)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "8131";
let srv = null;
if (!process.env.PORT) { srv = spawn("python3", ["tools/serve.py", "--port", port], { cwd: root, stdio: "ignore" }); await new Promise((r) => setTimeout(r, 1000)); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
let bad = 0;
const report = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); };
async function open(text) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const urls = [];
  page.on("pageerror", (e) => { console.log("PAGEERROR", e.message); bad++; });
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.location().url)) { console.log("CONSOLE", m.text()); bad++; } });
  page.on("request", (r) => urls.push(new URL(r.url()).pathname));
  if (text) await page.addInitScript(() => { window.__CONFIG_TEXT_ASSETS = true; });
  await page.goto(`http://127.0.0.1:${port}/tools/fixtures/glb_page.html`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  await page.waitForFunction(() => !window.__cl.debug.loading, null, { timeout: 60000 });
  return { page, urls };
}
async function run(text) {
  const tag = text ? "[b64]" : "[glb]";
  const { page, urls } = await open(text);
  report(urls.some((u) => u.endsWith(text ? "model.glb.b64.txt" : "model.glb")) && (!text || !urls.some((u) => u.endsWith("/model.glb"))), `${tag} fetched ${urls.filter((u) => /model/.test(u)).join(",")}`);
  const ev = (f, a) => page.evaluate(f, a);
  const keys = await ev(() => window.__cl.debug.meshes.map((m) => m.userData.key));
  report(keys.join() === "membrane,nucleus,structure", `${tag} three mesh parts built: ${keys}`);
  const r = await ev(() => window.__cl.debug.meshes.map((m) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox.getSize(new m.position.constructor()).x; }));
  report(Math.abs(r[0] - 10) < 1e-3, `${tag} membrane is 10 units long (${r[0]})`);
  // pixels: nucleus and structure colours show up in the canvas (read via screenshot of the page)
  await ev(() => window.__cl.show({ view: "overview", layers: ["membrane", "organelles"] }));
  const count = async () => ev(async () => {
    window.__cl.debug.render();
    const c = document.querySelector("canvas"), t = document.createElement("canvas");
    t.width = c.width; t.height = c.height;
    const g = t.getContext("2d"); g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, t.width, t.height).data, o = { bg: 0, blue: 0, red: 0, other: 0 };
    for (let i = 0; i < d.length; i += 4) {
      const [R, G, B] = [d[i], d[i + 1], d[i + 2]];
      if (Math.abs(R - 15) < 6 && Math.abs(G - 20) < 6 && Math.abs(B - 25) < 6) o.bg++;
      else if (B > R + 40 && B > G + 40) o.blue++; else if (R > B + 60 && R > G + 60) o.red++; else o.other++;
    }
    return o;
  });
  await page.waitForTimeout(100);
  let px = await count();
  report(px.blue > 200 && px.red > 200 && px.other > 2000, `${tag} pixels drawn ${JSON.stringify(px)}`);
  if (!text) await page.screenshot({ path: `${root}/tools/shots/cell-glb.png` }).catch(() => {});
  // picking, with a real click in pick mode
  await ev(() => window.__cl.show({ view: "overview", layers: ["membrane", "organelles"] }));
  for (const k of ["nucleus", "structure", "membrane"]) {
    await ev(() => { window.__cl.setPickEnabled(true); window.__picks.length = 0; });
    const c = await ev((k) => window.__cl.debug.canvasOf(k), k);
    await page.mouse.click(c[0], c[1]);
    await page.waitForTimeout(60);
    const picks = await ev(() => window.__picks.slice());
    report(picks[picks.length - 1] === k, `${tag} click ${k} at ${c.map((v) => v.toFixed(0))} -> ${JSON.stringify(picks)}`);
  }
  await ev(() => window.__cl.setPickEnabled(false));
  // labels
  const nLab = async () => ev(() => window.__cl.debug.scene.children.find((o) => o.type === "Group").children.filter((o) => o.userData.label && o.visible).length);
  await ev(() => window.__cl.show({ view: "overview", layers: ["membrane", "organelles"] }));
  const before = await nLab();
  await page.click("button:has-text('Labels')");
  const on = await nLab();
  await page.click("button:has-text('Labels')");
  report(before === 0 && on === 3 && (await nLab()) === 0, `${tag} labels toggle ${before} -> ${on} -> ${await nLab()}`);
  const anchor = await ev(() => { window.__cl.show({ layers: ["membrane", "organelles", "labels"] }); const s = window.__cl.debug.scene.children.find((o) => o.type === "Group").children.filter((o) => o.userData.label); return s.map((x) => x.position.x.toFixed(1)); });
  report(anchor.join() === "0.0,-1.5,2.5", `${tag} label anchors at bbox centres ${anchor}`);
  // highlight
  await ev(() => window.__cl.highlight("nucleus", "good"));
  report(await ev(() => window.__cl.debug.meshes.find((m) => m.userData.key === "nucleus").material.emissive.g > 0.3), `${tag} highlight tints`);
  await ev(() => window.__cl.clearHighlight());
  report(await ev(() => window.__cl.debug.meshes.find((m) => m.userData.key === "nucleus").material.emissive.getHex() === 0), `${tag} clearHighlight`);
  // cutaway: clip plane active on the membrane, membrane faint, nucleus (x<0) still pickable
  await page.click("button:has-text('Cutaway')");
  const cut = await ev(() => { const m = window.__cl.debug.meshes[0].material; return { c: m.clippingPlanes[0].constant, o: m.opacity }; });
  report(cut.c === 0 && cut.o <= 0.15, `${tag} cutaway clip=${cut.c} opacity=${cut.o}`);
  const cn = await ev(() => { const c = window.__cl.debug.canvasOf("nucleus"); return window.__cl.debug.pickAt(c[0], c[1]); });
  report(cn === "nucleus", `${tag} pick nucleus in cutaway -> ${cn}`);
  px = await count();
  report(px.blue > 200, `${tag} cutaway pixels ${JSON.stringify(px)}`);
  await page.click("button:has-text('Cutaway')");
  report(await ev(() => window.__cl.debug.meshes[0].material.clippingPlanes[0].constant > 1e5), `${tag} cutaway off`);
  // study swap / dispose: show again and re-show keeps cache (no second model fetch)
  const n0 = urls.filter((u) => /model/.test(u)).length;
  await ev(() => window.__cl.show({ study: "glb-cell" }));
  report(urls.filter((u) => /model/.test(u)).length === n0, `${tag} model cached`);
  await page.close();
}
try {
  await run(false);
  await run(true);
} finally { await browser.close(); srv?.kill(); }
console.log(bad ? `FAILED (${bad})` : "ALL PASS");
process.exit(bad ? 1 : 0);
