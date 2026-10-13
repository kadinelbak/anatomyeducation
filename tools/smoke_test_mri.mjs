// Plays every MRI set in the app headless: checks the sequence badge, the MR preset buttons, the
// MRI attribution line, and clicks a real voxel of each answer (same method as tools/smoke_test.mjs CT=1).
//
//   python3 tools/serve.py --port 8124 &        (from the app root that has the mri files merged in)
//   node mri/test/smoke_test.mjs http://127.0.0.1:8124/ [chromium] [shots dir]
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8124/";
const executablePath = process.argv[3] || undefined;
const shots = process.argv[4] || "";
const browser = await chromium.launch({ executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

async function play(setId, expect) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${url.split("?")[0]}?${setId.startsWith("q=") ? setId : "set=" + setId}`);
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
  const chips = await page.$$eval("#chooser .chip, .chip", (els) => els.map((e) => e.textContent.trim()));
  if (expect.title) ok(chips.includes(expect.title), `set chip "${expect.title}" offered (chips: ${chips.join(" | ")})`);
  await page.click("#start");
  await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
  await page.waitForSelector(".vol-btn[data-window].vol-active", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const ui = await page.evaluate(() => ({
    badge: document.querySelector(".vol-badge")?.textContent, badgeTitle: document.querySelector(".vol-badge")?.title,
    wins: [...document.querySelectorAll(".vol-btn[data-window]")].map((b) => b.textContent),
    active: document.querySelector(".vol-btn[data-window].vol-active")?.dataset.window,
    attrMr: !document.getElementById("attr-mr").hidden, attrCt: !document.getElementById("attr-ct").hidden,
    state: { ...window.__app.switch.debug.state, highlights: undefined },
    prompt: document.getElementById("prompt")?.textContent || document.querySelector("#question")?.textContent,
  }));
  ok(ui.badge === expect.badge || (!expect.exact && /^MRI · (T1|T2|PD|3D)/.test(ui.badge)), `badge "${ui.badge}" (title: ${ui.badgeTitle})`);
  ok(ui.wins.join(",") === "Default,Tissue,Bright,Dark", `window buttons ${ui.wins.join(",")}`);
  ok(ui.active === "soft" && ui.state.width > 1000, `default preset active: ${ui.active} width ${ui.state.width} level ${ui.state.level}`);
  ok(ui.attrMr && !ui.attrCt, `attribution: MRI ${ui.attrMr}, CT ${ui.attrCt}`);
  ok(/MRI/.test(ui.prompt), `prompt names the modality: ${ui.prompt.slice(0, 80)}`);
  const n = await page.evaluate(() => window.__app.QUESTIONS.length);
  let failed = 0;
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(600);
    const spot = await page.evaluate(() => {
      const a = window.__app, q = a.QUESTIONS[a.quiz.index], d = a.switch.debug, vol = d.volume;
      const key = q.accept[0], value = vol.valueOf(key);
      if (!d.state.pickEnabled) return { id: q.id, why: "pick not enabled" };
      const ax = { axial: [0, 1, 2], coronal: [0, 2, 1], sagittal: [1, 2, 0] }[d.state.plane];
      const dims = vol.dims, ijk = [0, 0, 0], pts = [];
      ijk[ax[2]] = d.currentDepth();
      for (let u = 0; u < dims[ax[0]]; u++) for (let v = 0; v < dims[ax[1]]; v++) {
        ijk[ax[0]] = u; ijk[ax[1]] = v;
        if (vol.labelAt(ijk[0], ijk[1], ijk[2]) === value) pts.push([u, v]);
      }
      if (!pts.length) return { id: q.id, why: "target not on the shown slice" };
      const cu = pts.reduce((s, p) => s + p[0], 0) / pts.length, cv = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      pts.sort((p, r) => Math.hypot(p[0] - cu, p[1] - cv) - Math.hypot(r[0] - cu, r[1] - cv));
      const cards = ["question", "intro"].map((id) => document.getElementById(id).getBoundingClientRect());
      const vr = d.vpEl.getBoundingClientRect();
      for (const [u, v] of pts.slice(0, 200)) {
        ijk[ax[0]] = u; ijk[ax[1]] = v;
        const [cx, cy] = d.canvasOf(ijk.slice());
        const x = vr.left + cx, y = vr.top + cy;
        if (cx < 0 || cy < 0 || x > innerWidth || y > innerHeight) continue;
        if (cards.some((r) => r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) continue;
        if (d.pickAt(cx, cy) === key && document.elementFromPoint(x, y)?.closest(".vol-viewport")) return { id: q.id, x, y, window: d.state.window };
      }
      return { id: q.id, why: `no clickable voxel among ${pts.length} on the slice` };
    });
    if (spot.x === undefined) {
      failed++; console.log(`FAIL ${setId} q${i + 1} ${spot.id}: ${spot.why}`);
      await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[window.__app.quiz.index].accept[0]));
    } else {
      await page.mouse.click(spot.x, spot.y);
      console.log(`ok   ${setId} q${i + 1} ${spot.id}: real click at ${Math.round(spot.x)},${Math.round(spot.y)} (window ${spot.window})`);
    }
    await page.waitForSelector("#feedback:not([hidden])", { timeout: 5000 });
    if (shots && i < 3) await page.screenshot({ path: `${shots}/${setId.replace(/[^a-z0-9-]/gi, "_")}-q${i + 1}.png` });
    await page.click("#next");
  }
  await page.waitForSelector("#results:not([hidden])");
  const score = (await page.textContent("#final-score")).trim();
  ok(score === `You scored ${n}/${n}`, `results: ${score} (${n} questions, ${failed} unclickable)`);
  failures += failed;
  // Preset buttons change the window; drag W/L drops the preset.
  await page.click("#again");
  await page.waitForSelector("#question:not([hidden])", { timeout: 60000 });
  const w = await page.evaluate(() => {
    const d = window.__app.switch.debug; const before = { ...d.state };
    document.querySelector('.vol-btn[data-window="bright"]').click();
    const after = { ...d.state };
    return { before: [before.window, before.width, before.level], after: [after.window, after.width, after.level] };
  });
  ok(w.after[0] === "bright" && w.after[1] !== w.before[1], `Bright preset applied: ${w.before} -> ${w.after}`);
  await page.close();
}

await play("mri:abdomen", { title: "MRI: Abdomen", badge: "MRI · T1" });
// Every abdomen question, ten per run (the set above is a random ten).
const bank = (await (await fetch(url.split("?")[0] + "assets/questions/mri-abdomen.json")).json()).questions.map((q) => q.id);
for (let b = 0; b * 10 < bank.length; b++) await play("q=" + bank.slice(b * 10, b * 10 + 10).join(","), { badge: "MRI · T1" });
await play("mri:pelvis", { title: "MRI: Pelvis", badge: "MRI · T2" });
await play("mri:thorax", { title: "MRI: Thorax", badge: "MRI · 3D" });
await play("mri:head", { title: "MRI: Head", badge: "MRI · T1" });
// The TotalSegmentator series: every bank, played as its own set (badge follows each study's weighting).
for (const id of ["s0167", "s0237", "s0219", "s0256", "s0191", "s0153", "s0283", "s0056", "s0175"]) {
  const ids = (await (await fetch(url.split("?")[0] + `assets/questions/mri-ts-${id}.json`)).json()).questions.map((q) => q.id);
  await play("q=" + ids.join(","), {});
}
// The CT set must be untouched by the patch.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${url.split("?")[0]}?set=ct:abdomen`);
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
  await page.click("#start");
  await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
  const ui = await page.evaluate(() => ({ badge: document.querySelector(".vol-badge")?.textContent,
    wins: [...document.querySelectorAll(".vol-btn[data-window]")].map((b) => b.textContent).join(","),
    state: window.__app.switch.debug.state.window, attrCt: !document.getElementById("attr-ct").hidden, attrMr: !document.getElementById("attr-mr").hidden }));
  ok(ui.badge === "CT" && ui.wins === "Soft,Lung,Bone" && ["soft", "lung", "bone"].includes(ui.state) && ui.attrCt && !ui.attrMr, `CT set unchanged: ${JSON.stringify(ui)}`);
  await page.close();
}
await browser.close();
const errs = errors.filter((e) => !/favicon|analytics|events|signup/i.test(e));
if (errs.length) { console.log("page errors:", errs); failures += errs.length; }
console.log(failures ? `FAILURES: ${failures}` : "ALL OK");
process.exit(failures ? 1 : 0);
