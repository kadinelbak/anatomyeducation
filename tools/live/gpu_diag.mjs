// Does the scan viewer draw on this machine's GPU? Opens Explore (chest MRI) and Live (trunk locked, MRI)
// in a headless Chromium and measures how many pixels of the scan canvas are lit, so a black pane can be
// reproduced without a person at the keyboard. Meant to be run on the machine that shows the problem.
//   node tools/live/gpu_diag.mjs http://127.0.0.1:8000/ /snap/bin/chromium
//   GPU=1     use the real GPU (default: SwiftShader software rendering, like the automated tests)
//   NORM16=1  let the viewer use 16-bit textures again (?norm16=1)
//   OUT=/tmp  where the screenshots go
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }

const base = process.argv[2] || "http://127.0.0.1:8000/";
const executablePath = process.argv[3] || process.env.CHROME || undefined;
const out = process.env.OUT || "/tmp";
const gpu = process.env.GPU === "1";
const q = process.env.NORM16 === "1" ? "norm16=1" : "";
const args = ["--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  ...(gpu ? ["--use-gl=angle", "--use-angle=gl", "--enable-gpu-rasterization", "--enable-webgl"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])];
console.log(`mode: ${gpu ? "GPU" : "software"}${q ? " + norm16" : ""} · browser ${executablePath || "playwright default"}`);
const browser = await chromium.launch({ executablePath, headless: true, args });

// Percent of lit pixels in the centre 96x96 of a canvas, and over the whole canvas at a stride.
const MEASURE = (sel) => {
  const cv = document.querySelector(sel);
  if (!cv) return { error: "no canvas for " + sel };
  const probe = document.createElement("canvas");
  const c2 = probe.getContext("2d");
  const sample = (sx, sy, sw, sh, w, h) => {
    probe.width = w; probe.height = h;
    c2.drawImage(cv, sx, sy, sw, sh, 0, 0, w, h);
    const px = c2.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) lit++;
    return Math.round((lit * 400) / px.length);
  };
  const w = Math.min(96, cv.width), h = Math.min(96, cv.height);
  return { canvas: [cv.width, cv.height], centreLit: sample((cv.width - w) / 2, (cv.height - h) / 2, w, h, w, h), wholeLit: sample(0, 0, cv.width, cv.height, 64, 64) };
};

async function run(name, drive) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["camera"] });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem("live.pointerHand", "left"); localStorage.setItem("live.calibration.skipped", "1"); } catch {} });
  const logs = [];
  page.on("console", (m) => { const t = m.text(); if (/^volume:|scan|cornerstone|WebGL|GL_|error/i.test(t) && !/vision_wasm|goatcounter/.test(t)) logs.push(`${m.type()}: ${t.slice(0, 300)}`); });
  page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
  let result;
  try { result = await drive(page); } catch (e) { result = { error: String(e.message || e).slice(0, 200) }; }
  const gl = await page.evaluate(() => { try { const gl = document.createElement("canvas").getContext("webgl2"); const d = gl.getExtension("WEBGL_debug_renderer_info"); return { renderer: gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER), norm16: !!gl.getExtension("EXT_texture_norm16"), floatLinear: !!gl.getExtension("OES_texture_float_linear") }; } catch (e) { return { error: String(e) }; } });
  await page.screenshot({ path: `${out}/gpu-diag-${name}.png` }).catch(() => {});
  console.log(`\n== ${name} ==`);
  console.log(JSON.stringify({ ...result, gl }, null, 1));
  for (const l of logs) console.log("  " + l);
  console.log(`  screenshot: ${out}/gpu-diag-${name}.png`);
  await ctx.close();
}

await run("explore-chest-mri", async (page) => {
  await page.goto(base + (q ? "?" + q : ""), { waitUntil: "load" });
  await page.waitForFunction(() => !document.getElementById("home-explore").disabled, null, { timeout: 120000 });
  await page.click("#home-explore");
  await page.waitForSelector("#explore-row .chip[data-region='chest']", { timeout: 60000 });
  await page.click("#explore-row .chip[data-region='chest']");
  const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
  await idle();
  if (await page.$eval("#region-menu", (e) => e.hidden)) await page.click("#region-crumb");
  await page.click("#explore-modalities .chip:text-is('MRI')");
  await idle();
  await page.waitForTimeout(4000);
  const m = await page.evaluate(MEASURE, ".vol-root:not([hidden]) canvas");
  const study = await page.evaluate(() => document.querySelector(".vol-root:not([hidden]) .vol-badge")?.textContent);
  return { study, ...m };
});

await run("live-trunk-mri", async (page) => {
  await page.goto(`${base}?live-fixture=tools/live/fixtures/trunk-sweep.json${q ? "&" + q : ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 120000 });
  const home = await page.$("#home-live");
  if (home && (await home.isVisible())) await home.click();
  else { await page.click("#home-explore"); await page.waitForSelector("#go-live", { state: "visible" }); await page.click("#go-live"); }
  await page.waitForSelector("#live:not([hidden])");
  await page.click(".live-card button.primary");
  await page.waitForFunction(() => [...document.querySelectorAll(".live-card button")].some((b) => b.textContent === "Skip" && !b.closest("[hidden]")), null, { timeout: 60000 }).then(() => page.click(".live-card button:not(.primary)")).catch(() => {});
  await page.waitForFunction(() => /locked/.test(document.querySelector(".live-pill .text")?.textContent || ""), null, { timeout: 60000 });
  await page.click(".live-toolbar .tool[data-id='mri']");
  await page.waitForFunction(() => document.querySelector(".live-scan-view")?.dataset.slice, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const m = await page.evaluate(MEASURE, ".live-scan-view canvas");
  const ds = await page.evaluate(() => ({ ...document.querySelector(".live-scan-view").dataset, lit: document.querySelector(".live-scan-view [data-lit]")?.dataset.lit, caption: document.querySelector(".live-caption")?.textContent }));
  return { ...ds, ...m };
});

await browser.close();
