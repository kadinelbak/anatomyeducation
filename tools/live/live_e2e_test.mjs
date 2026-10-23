// Live mode end to end with recorded tracker frames (no camera): forearm pointing with CT (vh-forearm) and simulated Ultrasound,
// then a trunk point with CT (chest study in .viewer-volume) and simulated Ultrasound.
//   python3 tools/serve.py --port 8138 &
//   node tools/live/live_e2e_test.mjs http://127.0.0.1:8138/ /opt/pw-browsers/chromium
// (playwright is resolved from the working directory's node_modules)
import { chromium } from "playwright";
import { openLive as openLiveFromHome } from "./_open_live.mjs";

const base = process.argv[2] || "http://127.0.0.1:8138/";
const executablePath = process.argv[3] || "/opt/pw-browsers/chromium";
const CHEST = ["ts-s1042", "ts-s1164", "ts-s1337"];
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
let failures = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) failures++; };

async function openLive(fixture) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera"] });
  const page = await ctx.newPage();
  const errors = [], mp = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/mediapipe|assets\/ml/.test(r.url())) mp.push(r.url()); });
  await page.goto(`${base}?live-fixture=tools/live/fixtures/${fixture}.json`, { waitUntil: "load" });
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
  await openLiveFromHome(page);
  await page.waitForSelector("#live:not([hidden])");
  await page.click(".live-card button.primary");
  return { ctx, page, errors, mp };
}

// 1. Two hands, forearm.
{
  const { ctx, page, errors, mp } = await openLive("two-hands-probe");
  const label = await page.waitForFunction(() => { const t = document.querySelector(".live-pill .text")?.textContent || ""; return /forearm/i.test(t) ? t : null; }, null, { timeout: 20000 })
    .then((h) => h.jsonValue()).catch(() => null);
  check(!!label, `region label names a forearm: "${label}"`);
  await page.waitForSelector(".live-structs li", { timeout: 10000 });
  const names = await page.$$eval(".live-structs li", (l) => l.length);
  check(names >= 4, `structures panel lists ${names} structures (>= 4)`);
  // Each listed structure's key exists in structures.json: click-through uses the key, so compare names to the file.
  const known = await page.evaluate(async () => { const j = await (await fetch("assets/model/structures.json")).json(); return Object.values(j.structures); });
  const listed = await page.$$eval(".live-structs li button span:first-child", (s) => s.map((x) => x.textContent));
  check(listed.length >= 4 && listed.every((n) => known.includes(n)), `listed structures exist in structures.json (${listed.slice(0, 5).join(", ")})`);
  await page.click('.live-toolbar .tool[data-id="ct"]');
  const fstudy = await page.waitForFunction(() => { const c = document.querySelector("#live .viewer-volume:not([hidden]) canvas"); const v = document.querySelector(".live-scan-view"); return c && v?.dataset.kind === "volume" ? v.dataset.study : null; }, null, { timeout: 90000 })
    .then((h) => h.jsonValue()).catch(() => null);
  check(fstudy === "vh-forearm", `CT on the right forearm opens a canvas in .viewer-volume with study ${fstudy}`);
  await page.click('.live-toolbar .tool[data-id="ultrasound"]');
  const fus = await page.waitForFunction(() => { const b = document.querySelector("#live .viewer-ultrasound:not([hidden])"); return b && b.querySelector("canvas") && /simulated/i.test(document.querySelector(".live-caption")?.textContent || ""); }, null, { timeout: 90000 })
    .then(() => true, () => false);
  check(fus, `Ultrasound on the forearm shows a simulated caption: "${await page.textContent(".live-caption").catch(() => "")}"`);
  check(mp.length === 0, `fixture path loads no MediaPipe files${mp.length ? ": " + mp[0] : ""}`);
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// 2. Trunk: CT then Ultrasound.
{
  const { ctx, page, errors } = await openLive("trunk-probe");
  const label = await page.waitForFunction(() => { const t = document.querySelector(".live-pill .text")?.textContent || ""; return /thora|chest|trunk/i.test(t) ? t : null; }, null, { timeout: 20000 })
    .then((h) => h.jsonValue()).catch(() => null);
  check(!!label, `trunk region label: "${label}"`);
  await page.waitForSelector(".live-toolbar .tool:not(.unavailable)", { timeout: 10000 });
  await page.click('.live-toolbar .tool[data-id="ct"]');
  const study = await page.waitForFunction(() => { const c = document.querySelector("#live .viewer-volume:not([hidden]) canvas"); const v = document.querySelector(".live-scan-view"); return c && v.dataset.kind === "volume" ? v.dataset.study : null; }, null, { timeout: 90000 })
    .then((h) => h.jsonValue()).catch(() => null);
  check(CHEST.includes(study), `CT opens a canvas in .viewer-volume with chest study ${study}`);
  await page.click('.live-toolbar .tool[data-id="ultrasound"]');
  const ok = await page.waitForFunction(() => { const b = document.querySelector("#live .viewer-ultrasound:not([hidden])"); return b && b.querySelector("canvas") && /simulated/i.test(document.querySelector(".live-caption")?.textContent || ""); }, null, { timeout: 90000 })
    .then(() => true, () => false);
  const cap = await page.textContent(".live-caption");
  check(ok, `Ultrasound viewer visible, caption: "${cap}"`);
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
