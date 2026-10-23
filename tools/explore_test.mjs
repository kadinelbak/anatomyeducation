// Explore mode: models and studies open from the intro without a quiz, and set chips switch the backdrop.
import { chromium } from "playwright";
import { existsSync } from "node:fs";
const base = process.argv[2], exe = process.argv[3];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
// hero.glb comes from another build step; until it exists, trunk.glb stands in for it.
if (!existsSync(new URL("../assets/model/hero.glb", import.meta.url))) await page.route("**/assets/model/hero.glb", (route) => route.fulfill({ path: new URL("../assets/model/trunk.glb", import.meta.url).pathname, contentType: "model/gltf-binary" }));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const st = () => page.evaluate(() => ({
  intro: !document.getElementById("intro").hidden, bar: !document.getElementById("explore-bar").hidden,
  title: document.getElementById("explore-title").textContent, active: window.__app.switch.active,
  model: window.__app.switch.model, study: window.__app.switch.study, volume: document.body.classList.contains("mode-volume"),
  quiz: window.__app.quiz.state, loading: !document.getElementById("loading").hidden,
}));
const openMenu = async () => { if (await page.$eval("#region-menu", (e) => e.hidden)) await page.click("#region-crumb"); };
// Zones are single paths (two legs, two arms): click a point inside the fill, not the bounding-box centre.
const zoneClick = async (region) => {
  const pt = await page.evaluate((r) => {
    const el = document.querySelector(`#figure-slot .figure .zone[data-region='${r}']`), svg = el.ownerSVGElement, b = el.getBBox();
    const m = el.getScreenCTM();
    for (let y = b.y + b.height / 2, k = 0; k < 60; k++) for (const sgn of [1, -1]) {
      for (let x = b.x; x <= b.x + b.width; x += b.width / 40) {
        const q = new DOMPoint(x, y + sgn * k * b.height / 120);
        if (el.isPointInFill(q)) { const s = q.matrixTransform(m); if (document.elementFromPoint(s.x, s.y) === el) return { x: s.x, y: s.y }; }
      }
    }
    return null;
  }, region);
  if (!pt) throw new Error("no clickable point in zone " + region);
  await page.mouse.click(pt.x, pt.y);
};
const toMap = async () => { await page.click("#explore-back"); await page.click("#home-explore"); };
const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
await page.goto(base);
await page.waitForFunction(() => !document.getElementById("home-explore").disabled, null, { timeout: 90000 });
await page.click("#home-explore");
await idle();
const entries = await page.$$eval("#explore-row .chip", (b) => b.map((x) => x.firstChild.textContent));
console.log("regions:", entries.join(" | "));
check(entries.join() === "Head,Upper limb,Chest,Abdomen,Pelvis,Lower limb,Tissues and cells", "the body map lists the six regions plus tissues and cells");
check((await page.$$("#figure-slot .figure .zone[role=button]")).length === 6, "the figure has six clickable zones");
const modalities = () => page.$$eval("#explore-modalities .chip", (b) => b.map((x) => `${x.textContent}${x.getAttribute("aria-pressed") === "true" ? "*" : ""}`));
// Explore the lower limb from the figure.
await zoneClick('lower-limb');
await idle();
let s = await st();
check(!s.intro && s.bar && s.model === "lower-limb" && s.quiz === "intro" && s.title === "Lower limb", `explore lower limb: ${JSON.stringify(s)}`);
check(await page.evaluate(() => getComputedStyle(document.getElementById("controls")).display !== "none"), "layer controls visible while exploring a model");
await page.screenshot({ path: "docs/screenshots/explore-lower-limb.png" });
// Hover names work (pick disabled): click a bone and expect a label.
await openMenu(); await page.click("#zoom-row [data-focus='knee']"); await page.waitForTimeout(800);
await page.mouse.click(640, 400); await page.waitForTimeout(200);
console.log("hover label:", await page.evaluate(() => document.getElementById("hover-label").hidden ? "(none)" : document.getElementById("hover-label").textContent));
// Back, then the abdomen: the trunk 3D model first, then each scan modality from the bar.
await toMap();
s = await st(); check(s.intro && !s.bar, "back to the intro");
await page.click("#explore-row .chip[data-region='abdomen']");
await idle();
s = await st();
let mods = await modalities();
console.log("abdomen modalities:", mods.join(" | "));
check(!s.intro && s.bar && s.active === "mesh" && s.model === "trunk" && mods[0] === "3D model*", `abdomen opens on the trunk 3D model: ${JSON.stringify(s)}`);
check(mods.join() === "3D model*,CT,MRI,X-ray,Ultrasound", "abdomen offers 3D model, CT, MRI, X-ray and ultrasound");
await openMenu(); await page.click("#explore-modalities .chip:text-is('CT')"); await idle();
s = await st();
check(s.active === "volume" && s.study === "ts-s0513" && s.volume, `abdomen CT: ${JSON.stringify(s)}`);
check(await page.evaluate(() => !!document.querySelector(".vol-root:not([hidden]) .vol-toolbar")), "scan toolbar visible");
await openMenu(); await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st(); check(s.active === "volume" && s.study === "ts-mr-example-sm" && s.bar, `abdomen MRI: ${JSON.stringify(s)}`);
await openMenu(); await page.click("#explore-modalities .chip:text-is('X-ray')"); await idle();
s = await st(); check(s.active === "xray" && s.study === "ts-s0513", `abdomen X-ray: ${JSON.stringify(s)}`);
check(await page.evaluate(() => !document.getElementById("explore-study").hidden), "study picker shown for X-ray (several studies)");
await openMenu(); await page.selectOption("#explore-study", "ts-s1390"); await idle();
s = await st(); check(s.active === "xray" && s.study === "ts-s1390", `X-ray study switched: ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-abdomen-xray.png" });
await openMenu(); await page.click("#explore-modalities .chip:text-is('Ultrasound')"); await idle();
s = await st(); check(s.active === "ultrasound" && s.bar, `abdomen ultrasound: ${JSON.stringify(s)}`);
// Pelvis: the trunk model first, the hip bones as a second 3D entry, then the prostate MRI.
await toMap();
await zoneClick('pelvis'); await idle();
s = await st(); mods = await modalities();
check(s.active === "mesh" && s.model === "trunk" && mods.join() === "3D model*,3D: hip bones,MRI", `pelvis opens on the trunk model: ${mods.join()}`);
check(await page.$eval("#zoom-row [data-focus='pelvis']", (b) => b.getAttribute("aria-pressed")) === "true", "zoomed to the pelvis");
await openMenu(); await page.click("#explore-modalities .chip:text-is('3D: hip bones')"); await idle();
s = await st();
check(s.active === "mesh" && s.model === "lower-limb", `pelvis hip bones option: ${s.model}`);
check(await page.$eval("#zoom-row [data-focus='hip']", (b) => b.getAttribute("aria-pressed")) === "true", "zoomed to the hip");
await openMenu(); await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st(); check(s.active === "volume" && s.study === "ts-mr-s0237", `pelvis MRI (most questions first): ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-pelvis-mri.png" });
await toMap();
// Head: the hippocampus MRI; chest: CT first, with the heart MRI among the options.
await zoneClick('head'); await idle();
s = await st(); mods = await modalities();
check(s.active === "mesh" && s.model === "head" && mods.join() === "3D model*,3D: neck,MRI", `head opens on the head 3D model: ${s.model} ${mods.join()}`);
await openMenu(); await page.click("#explore-modalities .chip:text-is('3D: neck')"); await idle();
s = await st(); check(s.active === "mesh" && s.model === "neck", `head region neck option: ${s.model}`);
await openMenu(); await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st();
check(s.active === "volume" && s.study === "mni-brain-t1", `head MRI opens on the T1 brain MRI: ${s.study}`);
const weightings = await page.$$eval("#explore-study option", (o) => o.map((x) => x.textContent));
console.log("head studies:", weightings.join(" | "));
check(weightings.join() === "Study: T1 · brain t1,Study: T2 · brain t2,Study: T1 · hippocampus 01,Study: PD · brain pd,Study: T1 · mr s0283", "the head study picker offers the three weightings, the hippocampus crop and the head-and-neck series");
await openMenu(); await page.selectOption("#explore-study", "mni-brain-t2"); await idle();
s = await st(); check(s.study === "mni-brain-t2", `T2 brain selected: ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-head-mri.png" });
await toMap();
await page.click("#explore-row .chip[data-region='chest']"); await idle();
s = await st(); mods = await modalities();
check(s.active === "mesh" && s.model === "trunk" && mods.join() === "3D model*,CT,MRI,X-ray,Ultrasound", `chest opens on the trunk model and offers CT, MRI, X-ray, ultrasound: ${mods.join()}`);
await openMenu(); await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st(); check(s.active === "volume" && s.study === "ts-mr-s0153", `chest MRI opens on the thorax series (most questions first): ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-chest-mri.png" });
await page.click("#explore-back");
await page.screenshot({ path: "docs/screenshots/intro-bodymap.png" });
// Choosing a set chip switches the backdrop without starting.
await page.click("#home-quiz");
await page.click(".chip:text-is('CT: Chest')");
await idle();
s = await st();
check(s.intro && s.active === "volume" && s.quiz === "intro" && /^ts-s/.test(s.study), `chip switches backdrop to CT chest: ${JSON.stringify(s)}`);
await (await page.$$(".chip:text-is('Daily 10')"))[0].click();
await idle();
s = await st();
check(s.intro && s.active === "mesh" && s.model === "upper-limb", `chip switches back to the upper limb: ${s.model}`);
// And a quiz still starts from there, and can be left mid-way.
await page.click("#start");
await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
check((await st()).quiz === "asking", "quiz starts after exploring");
await page.click("#quit");
s = await st(); check(s.intro && s.quiz === "intro" && await page.evaluate(() => document.getElementById("question").hidden && document.getElementById("stats").hidden), `Leave set returns to the intro: ${JSON.stringify(s)}`);
// Modality-first chips open the first region that offers the modality.
await page.click("#explore-back"); await page.click("#home-explore");
const modRow = await page.$$eval("#modality-row .chip", (b) => b.map((x) => x.textContent));
console.log("modality row:", modRow.join(" | "));
check(modRow.includes("X-ray") && modRow.includes("Ultrasound") && modRow.includes("Histology"), "modality row lists X-ray, Ultrasound and Histology");
await page.click("#modality-row .chip:text-is('X-ray')"); await idle();
s = await st(); check(s.active === "xray" && s.bar && s.title === "Chest", `X-ray chip opens the chest X-ray: ${JSON.stringify(s)}`);
await toMap();
await page.screenshot({ path: "docs/screenshots/intro-bodymap.png" });
await browser.close();
console.log(fails ? `${fails} failure(s)` : "ALL OK");
process.exit(fails ? 1 : 0);
