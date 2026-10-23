// Writes tools/live/fixtures/trunk-probe.json: a person facing the camera, one hand (left, image right) pointing
// at the chest at trunk frac 0.25, the other hand (right, image left) holding its finger across the chest.
//   node tools/live/make_trunk_fixture.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./record_fixture.mjs";

const desc = {
  name: "trunk-probe", frames: 60, fps: 30,
  elbows: { left: [0.62, 0.50], right: [0.38, 0.50] }, restWrist: { left: [0.60, 0.62], right: [0.40, 0.62] },
  hands: { left: { dir: [-1, 0] }, right: { dir: [1, 0] } },
};
const fx = buildFixture(desc);
// Trunk frac 0 = shoulder line (y 0.30), 1 = hip line (y 0.55): frac 0.25 is y 0.3625.
const goal = { left: [0.53, 0.3625], right: [0.46, 0.43] };
for (const f of fx.frames) {
  f.hands.forEach((h) => {
    const [gx, gy] = goal[h.side], t = h.landmarks[8];
    const dx = gx - t.x, dy = gy - t.y;
    for (const l of h.landmarks) { l.x = Math.round((l.x + dx) * 1e5) / 1e5; l.y = Math.round((l.y + dy) * 1e5) / 1e5; }
    const w = h.landmarks[0], i = h.side === "left" ? 15 : 16;
    f.pose.landmarks[i].x = w.x; f.pose.landmarks[i].y = w.y;
  });
}
const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "trunk-probe.json");
writeFileSync(out, JSON.stringify(fx));
console.log("wrote", out);
