// Writes tools/live/fixtures/trunk-sweep.json from trunk-probe.json: the left hand holds on the chest
// (trunk frac 0.25) for 1.5 s so the trunk locks, then slides straight down to frac 0.85 and back up
// over 6 s, finger kept level. Used by scrub_test.mjs: a locked scan must follow the finger's height.
//   node tools/live/make_sweep_fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const src = JSON.parse(readFileSync(join(dir, "trunk-probe.json"), "utf8"));
const { fps } = src;
const round = (v) => Math.round(v * 1e5) / 1e5;
const HOLD = 1.5, SWEEP = 6;            // seconds
const Y0 = 0.3625, Y1 = 0.30 + 0.85 * 0.25;   // trunk frac 0.25 -> 0.85 (shoulders y 0.30, hips y 0.55)
const frames = [];
for (let n = 0; n < Math.round((HOLD + SWEEP) * fps); n++) {
  const t = n / fps;
  const f = JSON.parse(JSON.stringify(src.frames[n % src.frames.length]));
  let y = Y0;
  if (t >= HOLD) { const u = (t - HOLD) / SWEEP; y = Y0 + (Y1 - Y0) * (u < 0.5 ? 2 * u : 2 - 2 * u); }
  const left = f.hands.find((h) => h.side === "left");
  const dy = y - left.landmarks[8].y;
  for (const l of left.landmarks) l.y = round(l.y + dy);
  // On the way back up the finger tilts 60 degrees toward vertical (pixel space, about the tip), the way a
  // hand reaching low on the belly points upward. The scan must keep stepping, not jump to another plane.
  if (t >= HOLD + SWEEP / 2) {
    const W = src.width, H = src.height, a = (-60 * Math.PI) / 180, tip = left.landmarks[8];
    const cx = tip.x * W, cy = tip.y * H, c = Math.cos(a), s = Math.sin(a);
    for (const l of left.landmarks) {
      const x = l.x * W - cx, yy = l.y * H - cy;
      l.x = round((cx + x * c - yy * s) / W); l.y = round((cy + x * s + yy * c) / H);
    }
  }
  if (left.world) for (const l of left.world) l.y = round(l.y + dy);
  frames.push(f);
}
writeFileSync(join(dir, "trunk-sweep.json"), JSON.stringify({ ...src, name: "trunk-sweep", frames }));
console.log("wrote trunk-sweep.json", frames.length, "frames");
