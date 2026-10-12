// Explore mode: models and studies open from the intro without a quiz, and set chips switch the backdrop.
import { chromium } from "playwright";
const base = process.argv[2], exe = process.argv[3];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const st = () => page.evaluate(() => ({
  intro: !document.getElementById("intro").hidden, bar: !document.getElementById("explore-bar").hidden,
  title: document.getElementById("explore-title").textContent, active: window.__app.switch.active,
  model: window.__app.switch.model, study: window.__app.switch.study, volume: document.body.classList.contains("mode-volume"),
  quiz: window.__app.quiz.state, loading: !document.getElementById("loading").hidden,
}));
const idle = () => page.waitForFunction(() => document.getElementById("loading").hidden && !document.getElementById("start").disabled, null, { timeout: 120000 });
await page.goto(base);
await idle();
const entries = await page.$$eval("#explore-row .chip", (b) => b.map((x) => x.textContent));
console.log("regions:", entries.join(" | "));
check(entries.join() === "Head,Upper limb,Chest,Abdomen,Pelvis,Lower limb,Tissues and cells", "the body map lists the six regions plus tissues and cells");
check((await page.$$(".figure .zone[role=button]")).length === 6, "the figure has six clickable zones");
const modalities = () => page.$$eval("#explore-modalities .chip", (b) => b.map((x) => `${x.textContent}${x.getAttribute("aria-pressed") === "true" ? "*" : ""}`));
// Explore the lower limb from the figure.
await page.click(".figure .zone[data-region='lower-limb'] path");
await idle();
let s = await st();
check(!s.intro && s.bar && s.model === "lower-limb" && s.quiz === "intro" && s.title === "Lower limb", `explore lower limb: ${JSON.stringify(s)}`);
check(await page.evaluate(() => getComputedStyle(document.getElementById("controls")).display !== "none"), "layer controls visible while exploring a model");
await page.screenshot({ path: "docs/screenshots/explore-lower-limb.png" });
// Hover names work (pick disabled): click a bone and expect a label.
await page.click("#zoom-row [data-focus='knee']"); await page.waitForTimeout(800);
await page.mouse.click(640, 400); await page.waitForTimeout(200);
console.log("hover label:", await page.evaluate(() => document.getElementById("hover-label").hidden ? "(none)" : document.getElementById("hover-label").textContent));
// Back, then the abdomen: CT first, then each other modality from the bar.
await page.click("#explore-back");
s = await st(); check(s.intro && !s.bar, "back to the intro");
await page.click("#explore-row .chip:text-is('Abdomen')");
await idle();
s = await st();
let mods = await modalities();
console.log("abdomen modalities:", mods.join(" | "));
check(!s.intro && s.bar && s.active === "volume" && s.study === "ts-s0513" && s.volume && mods[0] === "CT*", `abdomen opens on CT: ${JSON.stringify(s)}`);
check(await page.evaluate(() => !!document.querySelector(".vol-root:not([hidden]) .vol-toolbar")), "scan toolbar visible");
check(mods.join() === "CT*,MRI,X-ray,Ultrasound", "abdomen offers CT, MRI, X-ray and ultrasound");
await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st(); check(s.active === "volume" && s.study === "ts-mr-example-sm" && s.bar, `abdomen MRI: ${JSON.stringify(s)}`);
await page.click("#explore-modalities .chip:text-is('X-ray')"); await idle();
s = await st(); check(s.active === "xray" && s.study === "ts-s0513", `abdomen X-ray: ${JSON.stringify(s)}`);
check(await page.evaluate(() => !document.getElementById("explore-study").hidden), "study picker shown for X-ray (several studies)");
await page.selectOption("#explore-study", "ts-s1390"); await idle();
s = await st(); check(s.active === "xray" && s.study === "ts-s1390", `X-ray study switched: ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-abdomen-xray.png" });
await page.click("#explore-modalities .chip:text-is('Ultrasound')"); await idle();
s = await st(); check(s.active === "ultrasound" && s.bar, `abdomen ultrasound: ${JSON.stringify(s)}`);
// Pelvis: the hip bones in 3D, then the prostate MRI.
await page.click("#explore-back");
await page.click(".figure .zone[data-region='pelvis'] path"); await idle();
s = await st(); mods = await modalities();
check(s.active === "mesh" && s.model === "lower-limb" && mods.join() === "3D: hip bones*,MRI", `pelvis opens on the hip bones: ${mods.join()}`);
check(await page.$eval("#zoom-row [data-focus='hip']", (b) => b.getAttribute("aria-pressed")) === "true", "zoomed to the hip");
await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st(); check(s.active === "volume" && s.study === "msd-prostate-04", `pelvis MRI: ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-pelvis-mri.png" });
await page.click("#explore-back");
// Head: the hippocampus MRI; chest: CT first, with the heart MRI among the options.
await page.click(".figure .zone[data-region='head'] circle"); await idle();
s = await st(); mods = await modalities();
check(s.active === "volume" && s.study === "mni-brain-t1" && mods.join() === "MRI*", `head opens on the T1 brain MRI: ${s.study} ${mods.join()}`);
const weightings = await page.$$eval("#explore-study option", (o) => o.map((x) => x.textContent));
console.log("head studies:", weightings.join(" | "));
check(weightings.join() === "Study: T1 · brain t1,Study: T2 · brain t2,Study: T1 · hippocampus 01,Study: PD · brain pd", "the head study picker offers the three weightings and the hippocampus crop");
await page.selectOption("#explore-study", "mni-brain-t2"); await idle();
s = await st(); check(s.study === "mni-brain-t2", `T2 brain selected: ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-head-mri.png" });
await page.click("#explore-back");
await page.click("#explore-row .chip:text-is('Chest')"); await idle();
s = await st(); mods = await modalities();
check(s.active === "volume" && mods.join() === "CT*,MRI,X-ray,Ultrasound", `chest offers CT, MRI, X-ray, ultrasound: ${mods.join()}`);
await page.click("#explore-modalities .chip:text-is('MRI')"); await idle();
s = await st(); check(s.active === "volume" && s.study === "msd-heart-03", `chest MRI is the heart: ${s.study}`);
await page.screenshot({ path: "docs/screenshots/explore-chest-mri.png" });
await page.click("#explore-back");
await page.screenshot({ path: "docs/screenshots/intro-bodymap.png" });
// Choosing a set chip switches the backdrop without starting.
await page.click(".chip:text-is('CT: Chest')");
await idle();
s = await st();
check(s.intro && s.active === "volume" && s.quiz === "intro" && /^ts-s/.test(s.study), `chip switches backdrop to CT chest: ${JSON.stringify(s)}`);
await (await page.$$(".chip:text-is('Daily 10')"))[0].click();
await idle();
s = await st();
check(s.intro && s.active === "mesh" && s.model === "upper-limb", `chip switches back to the upper limb: ${s.model}`);
// And a quiz still starts from there.
await page.click("#start");
await page.waitForSelector("#question:not([hidden])", { timeout: 120000 });
check((await st()).quiz === "asking", "quiz starts after exploring");
await browser.close();
console.log(fails ? `${fails} failure(s)` : "ALL OK");
process.exit(fails ? 1 : 0);
