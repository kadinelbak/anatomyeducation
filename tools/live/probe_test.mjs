// Browser check for src/live/probe.js: a real renderer switch, a CT request applied, a canvas in
// .viewer-volume and the right study loaded.
//   python3 tools/serve.py --port 8134 &
//   node tools/live/probe_test.mjs http://127.0.0.1:8134/ /opt/pw-browsers/chromium
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:8134/").replace(/\/?$/, "/");
const executablePath = process.argv[3];
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && !/favicon/.test(r.url()) && errors.push(`${r.status()} ${r.url()}`));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

await page.goto(base + "tools/live/probe_page.html");
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const probe = window.__probe;
  const point = { segment: "trunk", side: null, frac: 0.2, aspect: "front", region: { label: "Chest" } };
  const mods = probe.modalitiesFor(point);
  const ct = mods.find((m) => m.id === "ct");
  const req = probe.request(point, { tip: { x: 0.5, y: 0.5 }, dir: { x: 1, y: 0 } }, ct);
  await probe.apply(req);
  const r = window.__renderers;
  return { req, active: r.active, study: r.study, rendererStudy: r.volume?.studyId, canvases: document.querySelectorAll(".viewer-volume canvas").length, hidden: document.querySelector(".viewer-volume").hidden };
});
check(out.req.kind === "volume" && out.req.view.plane === "axial", `request: ${out.req.study} ${JSON.stringify(out.req.view)}`);
check(out.active === "volume" && !out.hidden, "volume renderer is active and visible");
check(out.canvases > 0, `canvas in .viewer-volume (${out.canvases})`);
check(out.rendererStudy === out.req.study, `renderer studyId ${out.rendererStudy} = requested ${out.req.study}`);

// a second request: same study, a different slice, then a coronal one
const out2 = await page.evaluate(async () => {
  const probe = window.__probe, r = window.__renderers;
  const point = { segment: "trunk", side: null, frac: 0.3, aspect: "front" };
  const req = probe.request(point, { dir: { x: 0, y: 1 } }, "ct");
  await probe.apply(req);
  return { plane: req.view.plane, study: req.study, loaded: r.volume.studyId };
});
check(out2.plane === "coronal" && out2.loaded === out2.study, `coronal request applied on ${out2.loaded}`);

// switching to MRI changes the study
const out3 = await page.evaluate(async () => {
  const probe = window.__probe, r = window.__renderers;
  const req = probe.request({ segment: "head", side: null, frac: 0.5, aspect: "front" }, { dir: { x: 1, y: 0 } }, "mri");
  await probe.apply(req);
  return { want: req.study, got: r.volume.studyId };
});
check(out3.got === out3.want, `head MRI loaded: ${out3.got}`);

check(errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "no page errors");
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
