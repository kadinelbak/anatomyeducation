// Tracker test: fixture replay + real MediaPipe models on a fake camera (test pattern, no person).
//   python3 tools/serve.py --port 8132 &
//   node tools/live/tracking_test.mjs http://127.0.0.1:8132/ /opt/pw-browsers/chromium
// (If no server answers on the URL's port, one is started on 8132 and stopped afterwards.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8132/";
const executablePath = process.argv[3];
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let server = null;
const up = await fetch(url).then((r) => r.ok, () => false);
if (!up) {
  server = spawn("python3", ["tools/serve.py", "--port", new URL(url).port || "8132"], { cwd: root, stdio: "ignore" });
  for (let i = 0; i < 50 && !(await fetch(url).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
}

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failures++; };

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
try {
  const ctx = await browser.newContext({ permissions: ["camera"] });
  const page = await ctx.newPage();
  const errors = [];
  const hosts = new Set();
  page.on("request", (r) => { try { const u = new URL(r.url()); if (u.protocol.startsWith("http")) hosts.add(u.host); } catch (e) { /* ignore */ } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.location().url || "")) errors.push(m.text()); if (process.env.VERBOSE) console.log("page:", m.text()); });
  page.on("response", (r) => r.status() >= 400 && console.log("http", r.status(), r.url()));
  await page.goto(new URL("tools/live/tracking_page.html", url).href);
  await page.waitForFunction(() => window.__tracking && window.__tracking.done, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__tracking);

  const fx = r.fixture;
  check(fx && !fx.error, "fixture tracker created" + (fx && fx.error ? ": " + fx.error : ""));
  if (fx && !fx.error) {
    check(fx.frames >= 10, `fixture frames arrived (${fx.frames})`);
    check(fx.pose === 33 && fx.world === 33, "fixture pose has 33 landmarks and 33 world landmarks");
    check(fx.hands.length === 2 && fx.hands.every((h) => h.n === 21 && h.world === 21), "fixture has two hands with 21 landmarks each");
    check(fx.hands[0].side === "left" && fx.hands[1].side === "right", "hands ordered left, right");
    check(fx.statuses.includes("loading") && fx.statuses.includes("tracking"), "fixture statuses: " + fx.statuses.join(","));
  }

  const re = r.real;
  check(re && !re.error, "real tracker initialised" + (re && re.error ? ": " + re.error : ""));
  if (re && !re.error) {
    console.log("     backend:", re.stats.backend, "| fps", re.stats.fps.toFixed(1), "| poseMs", re.stats.poseMs.toFixed(0), "| handMs", re.stats.handMs.toFixed(0), "| statuses:", re.statuses.join(" > "));
    check(re.frames >= 15, `real frames processed (${re.frames})`);
    check(re.statuses.some((s) => s === "tracking" || s === "no-person"), "status reached tracking or no-person");
    check(!re.statuses.some((s) => s.startsWith("error")), "no error status");
  }
  const wantHost = new URL(url).host;
  const foreign = [...hosts].filter((h) => h !== wantHost);
  check(foreign.length === 0, "only " + wantHost + " contacted" + (foreign.length ? ": " + foreign.join(", ") : ""));
  const bad = errors.filter((e) => !/favicon/.test(e));
  check(bad.length === 0, "no page errors" + (bad.length ? ": " + bad.slice(0, 3).join(" | ") : ""));
} finally {
  await browser.close();
  if (server) server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
