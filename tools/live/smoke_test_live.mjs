// End-to-end check of Live mode with Chromium's fake camera: opens Live from the home screen, records every
// request, fails on any host other than the local server (plus the analytics/signup hosts index.html loads),
// then leaves via the brand button and checks the camera is stopped.
//
//   python3 tools/serve.py --port 8137 &
//   node tools/live/smoke_test_live.mjs http://127.0.0.1:8137/ [chromium executable]
//   W=390 H=844 TOUCH=1 node tools/live/smoke_test_live.mjs ...   phone size
import { chromium } from "playwright";
import { openLive } from "./_open_live.mjs";

const url = process.argv[2] || "http://127.0.0.1:8137/";
const executablePath = process.argv[3];
const ALLOWED = new Set(["127.0.0.1", "localhost", "kadin.goatcounter.com", "gc.zgo.at", "kadin-el-bakkouri.kit.com", "kit.com"]);
const width = Number(process.env.W || 1280), height = Number(process.env.H || 800);
let failures = 0;
const fail = (m) => { failures++; console.log("FAIL", m); };
const ok = (m) => console.log("ok  ", m);

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
try {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: !!process.env.TOUCH, permissions: ["camera"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const hosts = new Map();
  let recording = false;
  page.on("request", (r) => {
    if (!recording || /^(data|blob):/.test(r.url())) return;
    const h = new URL(r.url()).hostname;
    if (!hosts.has(h)) hosts.set(h, r.url());
  });

  await page.goto(url, { waitUntil: "load" });
  if (!(await page.$("#go-live")) && !(await page.$("#home-live")) && !(await page.$("#home-explore"))) {
    fail("#go-live is not in the page (Live home button missing); cannot test Live");
  } else {
    recording = true;
    await openLive(page);
    try {
      await page.waitForSelector("#live", { state: "visible", timeout: 15000 });
      ok("#live visible");
    } catch { fail("#live did not become visible after clicking #go-live"); }
    await page.waitForTimeout(4000); // let the camera, tracker and models start
    // Dismiss the first-use calibration card if it appeared, without requiring it.
    if ((await page.textContent(".live-card h1").catch(() => "")) === "Calibrate pointing") await page.click(".live-card button:not(.primary)").catch(() => {});
    const bad = [...hosts].filter(([h]) => !ALLOWED.has(h));
    if (bad.length) fail("cross-origin requests while Live open: " + bad.map(([, u]) => u).join(", "));
    else ok("no requests outside the allow-list (" + [...hosts.keys()].join(", ") + ")");

    await page.click("#explore-back");
    try {
      await page.waitForSelector("#live", { state: "hidden", timeout: 10000 });
      ok("#live hidden after brand button");
    } catch { fail("#live still visible after #explore-back"); }
    await page.waitForTimeout(500);
    const cam = await page.evaluate(() => {
      const v = document.querySelector("#live video");
      const s = v?.srcObject;
      return { hasVideo: !!v, live: s ? s.getTracks().filter((t) => t.readyState !== "ended").length : 0 };
    });
    if (cam.live) fail(`${cam.live} camera track(s) still live after leaving Live`);
    else ok(cam.hasVideo ? "camera tracks ended / srcObject null" : "no video element left");
  }
  if (errors.length) fail("page errors: " + errors.slice(0, 5).join(" | "));
} catch (e) {
  fail(String(e.message || e));
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
