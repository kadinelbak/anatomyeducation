// python3 tools/serve.py --port 8135 &
// node tools/live/usframes_test.mjs http://127.0.0.1:8135/ /opt/pw-browsers/chromium
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:8135/";
const executablePath = process.argv[3];
const browser = await chromium.launch({ executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => r.status() >= 400 && !r.url().includes("favicon") && errors.push(r.status() + " " + r.url()));
await page.goto(new URL("tools/live/usframes_page.html", base).href);
await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
const stats = () => page.evaluate(() => {
  const c = document.querySelector("canvas.usf-canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  return { w: c.width, h: c.height, lit, frame: window.r.debug.frameIndex, badge: document.querySelector(".usf-badge").textContent };
});
let s = await stats();
let bad = [];
if (!(s.w > 0 && s.lit > 500)) bad.push("canvas blank " + JSON.stringify(s));
if (s.frame !== 12 && s.frame !== 11) bad.push("frame " + s.frame);
if (!/^Ultrasound · real · /.test(s.badge)) bad.push("badge " + s.badge);
await page.evaluate(() => window.r.show({ view: { frac: 0 } }));
if ((await stats()).frame !== 0) bad.push("frac 0 not frame 0");
if (errors.length) bad.push("errors " + errors.join("; "));
await browser.close();
if (bad.length) { console.log("FAIL", bad); process.exit(1); }
console.log("usframes_test ok", s);
