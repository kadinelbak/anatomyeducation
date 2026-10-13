// Render a cell diagram SVG to PNG for review, on the same paper background the app uses.
//   node tools/diagram_shot.mjs <study-id> [out.png] [--nolabels] [--hits]
// --hits paints every clickable region (data-part) in a translucent random colour, to check coverage and overlap.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [sid, outArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const noLabels = process.argv.includes("--nolabels"), hits = process.argv.includes("--hits");
const svg = fs.readFileSync(path.join(root, "assets/cells", sid, "diagram.svg"), "utf8");
const out = outArg || path.join(root, "tools/shots", `diagram-${sid}${hits ? "-hits" : ""}.png`);
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.setContent(`<!doctype html><style>html,body{margin:0;background:#f6f3ec}svg{display:block;width:1200px;height:800px}
${noLabels ? ".dg-labels{display:none}" : ""}</style>${svg}`);
if (hits) await page.evaluate(() => {
  let h = 0;
  for (const g of document.querySelectorAll("[data-part]")) {
    h = (h + 67) % 360;
    for (const s of g.querySelectorAll("*")) { s.style.fill = `hsla(${h},80%,50%,.55)`; s.style.stroke = `hsla(${h},80%,40%,.8)`; }
  }
});
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out });
await browser.close();
console.log(out);
