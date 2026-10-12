// Screenshot check for the X-ray renderer. Usage: node tools/xray_shot.mjs   (from the app root)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8765 + Math.floor(Math.random() * 100);
const srv = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await pw.chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on("pageerror", (e) => { console.log("PAGEERROR", e.message); bad++; });
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text()); });
  await page.goto(`http://127.0.0.1:${port}/tools/xray_page.html`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  await page.waitForFunction(() => !window.__xr.debug.loading, null, { timeout: 120000 });
  const shot = async (n) => { await page.evaluate(() => window.__xr.debug.render()); await page.waitForTimeout(150); await page.screenshot({ path: `${root}/tools/shots/${n}.png` }); };
  await page.evaluate(() => window.__xr.show({ view: "ap", layers: ["labels"] }));
  await shot("xray-ap");
  const checks = async (names) => {
    for (const k of names) {
      const r = await page.evaluate((k) => { const d = window.__xr.debug, c = d.canvasOf(k); return { c, got: c ? d.pickAt(c[0], c[1]) : null }; }, k);
      const pass = r.got === k; if (!pass) bad++;
      console.log(`pick ${k}: canvas=${r.c && r.c.map((v) => v.toFixed(1))} -> ${r.got} ${pass ? "PASS" : "FAIL"}`);
    }
  };
  await checks(["heart", "liver", "clavicula_left"]);
  await page.evaluate(() => { window.__xr.show({ view: "ap", layers: ["labels"] }); window.__xr.debug.setGroup("bones"); });
  await checks(["clavicula_left", "rib_left_7"]);
  await page.evaluate(() => { const d = window.__xr.debug, c = d.canvasOf("rib_left_7"); d.onTap({ clientX: c[0] + d.vpEl.getBoundingClientRect().left, clientY: c[1] + d.vpEl.getBoundingClientRect().top, pointerType: "mouse" }); });
  await shot("xray-bones");
  await page.evaluate(() => window.__xr.debug.setGroup("all"));
  await page.evaluate(() => window.__xr.show({ view: "lateral", layers: ["labels"] }));
  await shot("xray-lat");
  await page.evaluate(() => window.__xr.show({ view: "ap" }));
  await checks(["heart", "liver", "clavicula_left"]);
  await page.evaluate(() => window.__xr.highlight("heart", "good"));
  await shot("xray-hl");
  console.log(await page.evaluate(() => JSON.stringify(window.__xr.debug.state)));
  const tb = await page.evaluate(() => { const r = document.querySelector(".xr-toolbar").getBoundingClientRect(); return [r.top, r.bottom]; });
  console.log("toolbar y", tb.map(Math.round));
} finally { await browser.close(); srv.kill(); }
process.exit(bad ? 1 : 0);
