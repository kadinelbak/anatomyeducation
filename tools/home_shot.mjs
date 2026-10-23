// Screenshots the home screen: tools/shots/home-desktop.png (1280x800) and home-phone.png (375x812).
//   node tools/home_shot.mjs [base url]      serves the app itself when no url is given
// If assets/model/hero.glb is not there yet, trunk.glb stands in for it (the page asks for hero.glb either way).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "tools", "shots");
mkdirSync(out, { recursive: true });

let server = null;
let base = process.argv[2];
if (!base) {
  const port = 8200 + Math.floor(Math.random() * 500);
  server = spawn("python3", [path.join(root, "tools", "serve.py"), "--port", String(port)], { cwd: root, stdio: "ignore" });
  base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}
const fallback = !existsSync(path.join(root, "assets/model/hero.glb"));
if (fallback) console.log("note: assets/model/hero.glb is missing; using trunk.glb in its place");

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let code = 0;
try {
  for (const [name, width, height] of [["home-desktop", 1280, 800], ["home-phone", 375, 812]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("pageerror", (e) => console.log("page error:", e.message));
    if (fallback) await page.route("**/assets/model/hero.glb", (route) => route.fulfill({ path: path.join(root, "assets/model/trunk.glb"), contentType: "model/gltf-binary" }));
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById("home-explore").disabled, null, { timeout: 90000 });
    await page.waitForSelector("#hero.hero-ready", { timeout: 60000 }).catch(() => console.log(`note: ${name}: 3D figure did not load, placeholder shown`));
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) { console.log(`FAIL ${name}: horizontal scroll`); code = 1; }
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log("wrote", path.join(out, `${name}.png`));
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}
process.exit(code);
