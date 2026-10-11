// End-to-end check: loads the page, plays a fixed set of questions by clicking each
// answer on screen, and checks the answer is visible and clickable from the
// question's starting view. Then checks results, share link and signup.
//
//   npm i -D playwright   (once)
//   python3 tools/serve.py --port 8123 &
//   node tools/smoke_test.mjs http://127.0.0.1:8123/ [chromium executable]
//   ALL=1 node tools/smoke_test.mjs ...   plays every question in the bank, 10 per set,
//                                         and lists the ones whose answer is not clickable
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8123/";
const executablePath = process.argv[3];
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const width = Number(process.env.W || 1280), height = Number(process.env.H || 800);
const errors = [];
async function openPage() {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: !!process.env.TOUCH });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text() + " " + (m.location().url || "")));
  page.on("response", (r) => r.status() >= 400 && console.log("http", r.status(), r.url()));
  return page;
}
let page = await openPage();

const ORIGINAL = "median-nerve-id,fcu-id,carpal-tunnel-apb,ulnar-nerve-id,froment-adductor,fdp-id,ain-fpl,humerus-superficial-radial,pin-syndrome,dorsal-interossei";
const base = url.split("?")[0];
let failures = 0;

// Plays the set that is loaded; returns its length.
async function playSet(page, label) {
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 90000 });
  await page.click("#start");
  const n = await page.evaluate(() => window.__app.QUESTIONS.length);
  let failed = 0;
  for (let i = 0; i < n; i++) {
    await page.waitForFunction(() => !window.__app.viewTween.active);
    await page.waitForTimeout(500); // let the last frame of the camera move render
    // Find on-screen pixels of the answer that pick() resolves to the answer.
    const spot = await page.evaluate(() => {
      const a = window.__app;
      const q = a.QUESTIONS[a.quiz.index];
      const cards = ["question", "controls", "intro"].map((id) => document.getElementById(id).getBoundingClientRect());
      const covered = (x, y) => cards.some((r) => r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      const v = new a.camera.position.constructor();
      let tried = 0;
      for (const s of q.accept) {
        for (const mesh of a.meshesByStructure.get(s) || []) {
          const pos = mesh.geometry.attributes.position;
          const step = Math.max(1, Math.floor(pos.count / 300));
          for (let k = 0; k < pos.count; k += step) {
            v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld).project(a.camera);
            const x = Math.round(((v.x + 1) / 2) * innerWidth), y = Math.round(((1 - v.y) / 2) * innerHeight);
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight || covered(x, y)) continue;
            tried++;
            if (q.accept.includes(a.pick(x, y))) return { x, y, id: q.id, tried };
          }
        }
      }
      return { id: q.id, tried };
    });
    if (spot.x === undefined) {
      failed++;
      console.log(`FAIL ${label}q${i + 1} ${spot.id}: answer not clickable from the starting view (${spot.tried} visible points tried)`);
      await page.evaluate(() => window.__app.answer(window.__app.QUESTIONS[window.__app.quiz.index].accept[0]));
    } else {
      await page.mouse.click(spot.x, spot.y);
      console.log(`ok   ${label}q${i + 1} ${spot.id}: clicked answer at ${Math.round(spot.x)},${Math.round(spot.y)}`);
    }
    await page.waitForSelector("#feedback:not([hidden])", { timeout: 5000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${label}q${i + 1}.png` });
    await page.click("#next");
  }
  await page.waitForSelector("#results:not([hidden])");
  return { n, failed };
}

if (process.env.ALL) {
  // Every question in the bank, ten per set.
  const bank = (await (await fetch(base + "assets/questions/upper-limb.json")).json()).questions;
  console.log(`bank: ${bank.length} questions`);
  for (let b = 0; b * 10 < bank.length; b++) {
    const ids = bank.slice(b * 10, b * 10 + 10).map((q) => q.id).join(",");
    if (b) { await page.close(); page = await openPage(); } // a fresh GL context per set
    await page.goto(`${base}?q=${ids}`);
    failures += (await playSet(page, `b${b + 1}.`)).failed;
  }
} else {
  await page.goto(`${base}?q=${ORIGINAL}`);
  const { n, failed } = await playSet(page, "");
  failures += failed;
  const score = await page.textContent("#final-score");
  console.log("results:", score);
  if (score.trim() !== `You scored ${n - failed}/${n}`) { failures++; console.log("FAIL score text"); }

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#share");
  await page.waitForSelector("#share-status:not([hidden])");
  const shareText = await page.textContent("#share-status");
  console.log("share:", shareText);

  const shareUrl = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  const link = (shareUrl.match(/https?:\S+/) || [])[0];
  if (link) {
    const p2 = await browser.newPage();
    await p2.goto(link);
    await p2.waitForSelector("#shared-banner:not([hidden])", { timeout: 90000 });
    const banner = await p2.textContent("#shared-banner");
    console.log("shared banner:", banner);
    if (!new RegExp(`scored ${n - failed}/${n} in`).test(banner)) { failures++; console.log("FAIL shared banner"); }
    await p2.close();
  } else {
    console.log("note: clipboard not readable here, skipped the shared-link check");
  }

  await page.click("#more");
  await page.fill("#signup-email", "smoke-test@example.com");
  await page.click("#signup-submit");
  await page.waitForSelector("#signup-status:not([hidden])");
  console.log("signup:", await page.textContent("#signup-status"));
}

if (errors.length) { failures++; console.log("page errors:\n  " + errors.join("\n  ")); }
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
