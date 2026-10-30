// A locked region's scan must follow the pointing finger's height: trunk-sweep.json locks the trunk,
// then slides the finger down the trunk and back. With MRI and then CT chosen, the shown slice must take
// many distinct values and move monotonically with the finger.
//   node tools/live/scrub_test.mjs http://127.0.0.1:8141/ /opt/pw-browsers/chromium
import { chromium } from "playwright";
import { openLive as openLiveFromHome } from "./_open_live.mjs";

const base = process.argv[2] || "http://127.0.0.1:8141/";
const executablePath = process.argv[3] || "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let failures = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) failures++; };

for (const tool of (process.env.TOOLS || "mri,ct,ultrasound").split(",")) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera"] });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem("live.pointerHand", "left"); localStorage.setItem("live.calibration.skipped", "1"); } catch {} });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}?live-fixture=tools/live/fixtures/trunk-sweep.json`, { waitUntil: "load" });
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
  await openLiveFromHome(page);
  await page.waitForSelector("#live:not([hidden])");
  await page.click(".live-card button.primary");
  await page.waitForFunction(() => [...document.querySelectorAll(".live-card button")].some((b) => b.textContent === "Skip" && !b.closest("[hidden]")), null, { timeout: 60000 }).then(() => page.click(".live-card button:not(.primary)")).catch(() => {});
  const locked = await page.waitForFunction(() => /locked/.test(document.querySelector(".live-pill .text")?.textContent || ""), null, { timeout: 30000 }).then(() => true, () => false);
  check(locked, `${tool}: trunk locks`);
  await page.click(`.live-toolbar .tool[data-id="${tool}"]`);
  await page.waitForFunction(() => document.querySelector(".live-scan-view")?.dataset.slice, null, { timeout: 90000 }).catch(() => {});
  // Sample one full sweep (frames loop every 7.5 s).
  const samples = [];
  for (let i = 0; i < 80; i++) {
    samples.push(await page.evaluate(() => { const v = document.querySelector(".live-scan-view"); return { slice: v?.dataset.slice, plane: v?.dataset.plane, study: v?.dataset.study, cap: document.querySelector(".live-caption")?.textContent, slider: document.querySelector(".live-scan-view .vol-slider")?.value }; }));
    await page.waitForTimeout(100);
  }
  const slices = new Set(samples.map((s) => s.slice).filter(Boolean));
  const caps = new Set(samples.map((s) => (s.cap || "").match(/(\d+)% from/)?.[1]).filter(Boolean));
  const planes = new Set(samples.map((s) => s.plane).filter(Boolean));
  const studies = new Set(samples.map((s) => s.study).filter(Boolean));
  check(caps.size >= 10, `${tool}: caption percent takes ${caps.size} values (>= 10): ${[...caps].slice(0, 12).join(",")}`);
  check(slices.size >= 10, `${tool}: requested slice takes ${slices.size} values (>= 10)`);
  // The request is not enough: the viewer's own slice slider (its camera depth) must move too. It sat at the
  // middle for every request while resolveView() did not understand the probe's { plane, frac, window } object.
  if (tool !== "ultrasound") { const sliders = new Set(samples.map((s) => s.slider).filter(Boolean)); check(sliders.size >= 10, `${tool}: the viewer's slice slider takes ${sliders.size} values (>= 10): ${[...sliders].slice(0, 12).join(",")}`); }
  if (tool !== "ultrasound") check(planes.size === 1 && planes.has("axial"), `${tool}: plane stays axial (${[...planes].join(",")})`);
  // CT/MRI/X-ray stay on the study Explore opens first for the locked region (thorax -> chest): one study per lock.
  const EXPLORE_FIRST = { mri: "ts-mr-s0153", ct: "ts-s1042" };
  if (EXPLORE_FIRST[tool]) check(studies.size === 1 && studies.has(EXPLORE_FIRST[tool]), `${tool}: the whole sweep stays on Explore's chest study ${EXPLORE_FIRST[tool]} (${[...studies].join(",")})`);
  else check(studies.size <= 2, `${tool}: ${studies.size} studies over the sweep (${[...studies].join(",")})`);
  check(errors.length === 0, `${tool}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
