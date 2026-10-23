// Live view shell check: opens Live with a fake camera, checks the feed plays and the pill has text,
// closes with the X, and checks nothing left 127.0.0.1 while Live was open.
//   python3 tools/serve.py --port 8131 &
//   node tools/live/view_test.mjs http://127.0.0.1:8131/ /opt/pw-browsers/chromium
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8131/";
const executablePath = process.argv[3] || "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera"] });
const page = await ctx.newPage();
const errors = [], external = [];
let live = false;
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const host = new URL(r.url()).hostname;
  if (live && host !== "127.0.0.1" && !/goatcounter|zgo\.at|kit\.com/.test(host) && r.url().startsWith("http")) external.push(r.url());
});
let failures = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) failures++; };

await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
live = true;
await page.click("#go-live");
await page.waitForSelector("#live:not([hidden])");
await page.click(".live-card button.primary"); // Turn on camera
await page.waitForFunction(() => { const v = document.querySelector("#live video"); return v && v.readyState >= 2 && !v.paused && v.videoWidth > 0; }, null, { timeout: 30000 });
check(true, "#live visible, video playing");
const pill = await page.waitForFunction(() => document.querySelector(".live-pill .text")?.textContent.trim() || null, null, { timeout: 15000 }).then((h) => h.jsonValue());
check(pill.length > 0, `status pill text: "${pill}"`);
check(await page.evaluate(() => getComputedStyle(document.querySelector("#live video")).transform !== "none"), "video is mirrored");
await page.waitForTimeout(1500);
check((await page.evaluate(() => location.hash)) === "#live", "history entry #live pushed");
const topbar = await page.evaluate(() => document.querySelector(".topbar").getBoundingClientRect().height);
check(topbar <= 44, `top bar height ${topbar}`);

await page.click(".live-x");
await page.waitForSelector("#live", { state: "hidden" });
check(await page.isVisible("#intro"), "#intro visible after X");
const live1 = await page.evaluate(() => document.querySelector("#live video").srcObject);
check(live1 === null, "stream released");
await page.waitForTimeout(500);
check((await page.evaluate(() => location.hash)) === "", "#live history entry popped");

// Reopen and leave through browser Back and through the brand button.
for (const how of ["back", "brand"]) {
  await page.click("#go-live");
  await page.click(".live-card button.primary");
  await page.waitForFunction(() => document.querySelector("#live video")?.srcObject);
  if (how === "back") await page.goBack(); else await page.click("#explore-back");
  await page.waitForSelector("#live", { state: "hidden" });
  check(await page.evaluate(() => document.querySelector("#live video").srcObject === null), `exit via ${how} stops the stream`);
  check(await page.isVisible("#intro"), `#intro visible after ${how}`);
}
check(external.length === 0, `no off-origin requests while Live was open${external.length ? ": " + external.join(", ") : ""}`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close();
process.exit(failures ? 1 : 0);
