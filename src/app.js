// Wiring: boot, renderer, bank, sets, engine, share and signup.
import { CONFIG } from "./config.js";
import { track, visitor, checkReturnVisit } from "./analytics.js";
import { loadBanks } from "./bank.js";
import { buildSets, resolveSet } from "./sets.js";
import { buildBodyMap, buildFigure, upgradeFigure, studyLabel } from "./bodymap.js";
import { createEngine, fmtTime } from "./engine.js";
import { createRendererSwitch } from "./renderers/switch.js";
import { WebGLUnavailableError, webglHelp } from "./webgl-probe.js";

const $ = (id) => document.getElementById(id);
const SCAN_KINDS = ["volume", "xray", "ultrasound", "slide", "cell"];
window.__CONFIG_TEXT_ASSETS = CONFIG.textAssets; // the slide renderer reads this to fetch .b64.txt tiles
window.__CONFIG_TILE_BUNDLES = CONFIG.tileBundles === true; // ...or one bundle per pyramid level (hosts that cap file counts)
// Zoom index (organ -> tissue -> cell); filled by loadZoomIndex() once the banks are in.
const cellStudies = new Map(); // CL id -> cell study id
const slideStudies = new Map(); // slide study id -> true
const slideMeta = new Map(); // slide id -> manifest
const fmaModel = new Map(); // model structure key (e.g. biceps_brachii) -> model id
const structureLayer = new Map(); // model structure key -> its layer, for the details panel's tissue fallback
const studyTitles = new Map(); // slide or cell study id -> its manifest title, for the study picker and zoom chips
let zoomReady = false;
const STATS_HIDDEN = () => ($("stats").hidden = true);

// ---------- Shared score ----------

function readSharedScore(n) {
  const p = new URLSearchParams(window.location.search);
  if (!p.has("q") || !p.has("s")) return null;
  const s = Number(p.get("s"));
  const t = Number(p.get("t"));
  if (!Number.isInteger(s) || s < 0 || s > n) return null;
  return { s, n, t: Number.isFinite(t) && t > 0 && t < 86400 ? t : null };
}

// ---------- Boot ----------

const app = (window.__app = {});
let engine = null;
let selectedSet = "daily";

const renderer = createRendererSwitch({
  viewer: $("viewer"),
  models: CONFIG.models,
  onPick: (id) => proposeAnswer(id),
  onSelect: (id) => onStructureClick(id),
  onChange: (kind, id, meta) => {
    // One attribution line per source: the mesh renderer shows its model's line when active,
    // and a scan shows the line for its modality (the study's manifest says which it is).
    // X-ray and ultrasound are computed from the CT studies, so they show the CT line with their own.
    const scan = SCAN_KINDS.includes(kind);
    if (scan) $("attr-bp3d").hidden = $("attr-o3d").hidden = $("attr-za").hidden = true;
    $("attr-ct").hidden = !(scan && (kind !== "volume" || meta?.modality !== "MR"));
    $("attr-mr").hidden = !(kind === "volume" && meta?.modality === "MR");
    $("attr-xray").hidden = kind !== "xray";
    $("attr-us").hidden = kind !== "ultrasound";
    $("attr-ct").hidden = $("attr-ct").hidden || kind === "slide" || kind === "cell";
    $("attr-hist").hidden = kind !== "slide";
    $("attr-cell").hidden = kind !== "cell";
    if (kind === "slide") { // one line per study: the manifest names its source and licence
      const a = $("attr-hist-src");
      a.textContent = `${meta?.attribution || meta?.source || id}, ${meta?.license || ""}${meta?.synthetic ? " (stylised placeholder, not a micrograph)" : ""}`;
      if (meta?.sourceUrl) a.href = meta.sourceUrl; else a.removeAttribute("href");
    }
    if (kind === "cell") cellAttribution(meta, id);
    renderZoomChips(kind, id, meta);
    if (meta?.modality === "MR") { // the MRI line names the study's own source: MR studies come from more than one dataset
      const a = $("attr-mr-src");
      a.textContent = `${meta.attribution || meta.source || meta.id}${meta.license ? ", " + meta.license : ""}`;
      if (meta.sourceUrl) a.href = meta.sourceUrl; else a.removeAttribute("href");
    }
  },
});

// The cell line follows the study and the cell renderer's view: a labelled diagram credits the diagram, 3D the model.
function cellAttribution(meta, id) {
  const a = $("attr-cell-src"), diagram = renderer.cell?.mode === "diagram" && meta?.diagram;
  const src = diagram ? meta.diagram : meta;
  a.textContent = `${src?.attribution || src?.source || id}, ${src?.license || ""}${meta?.synthetic && !diagram ? " (stylised placeholder, not a micrograph)" : ""}`;
  if (!diagram && meta?.sourceUrl) a.href = meta.sourceUrl; else a.removeAttribute("href");
  $("attr-cell-note").textContent = diagram ? "Teaching illustration, not a micrograph"
    : meta?.synthetic === false
      ? "Surfaces reconstructed from the segmented microscope image of one real cell (membrane, nucleus and the tagged structure); other organelles are not shown"
      : "Stylised 3D model built from primitives, not a reconstruction";
}
$("viewer").addEventListener("cellmode", () => { if (renderer.active === "cell") cellAttribution(renderer.cell?.meta, renderer.study); });

// No WebGL: say why, and offer a way out of an embedded viewer.
function showNoWebGL(err) {
  const box = $("loading");
  box.replaceChildren();
  const h = document.createElement("p");
  h.textContent = "Couldn't start the 3D view.";
  box.append(h);
  for (const line of webglHelp(err)) {
    const p = document.createElement("p");
    p.className = "fine";
    p.textContent = line;
    box.append(p);
  }
  if (window.top !== window) {
    const a = document.createElement("a");
    a.href = window.location.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open this page in its own tab";
    box.append(a);
  }
}

let bank;
try {
  bank = await loadBanks([
    "assets/questions/upper-limb.json", "assets/questions/lower-limb.json", "assets/questions/trunk.json",
    "assets/questions/neck.json", "assets/questions/head.json",
    "assets/questions/ct-trunk.json", "assets/questions/ct-chest.json",
    "assets/questions/mri-abdomen.json", "assets/questions/mri-prostate.json", "assets/questions/mri-heart.json", "assets/questions/mri-hippocampus.json",
    "assets/questions/mri-brain-t1.json", "assets/questions/mri-brain-t2.json", "assets/questions/mri-brain-pd.json",
    "assets/questions/mri-ts-s0167.json", "assets/questions/mri-ts-s0237.json", "assets/questions/mri-ts-s0219.json", "assets/questions/mri-ts-s0256.json", "assets/questions/mri-ts-s0191.json", "assets/questions/mri-ts-s0153.json", "assets/questions/mri-ts-s0283.json", "assets/questions/mri-ts-s0056.json", "assets/questions/mri-ts-s0175.json",
    "assets/questions/xray-chest.json", "assets/questions/xray-abdomen.json", "assets/questions/us-trunk.json",
    "assets/questions/histology-limb.json", "assets/questions/cells-limb.json", "assets/questions/cells-real.json",
  ]);
} catch (err) {
  console.error(err);
  $("loading").textContent = "Couldn't load the questions. Please reload the page.";
  throw err;
}

const builtin = buildSets(bank.questions, CONFIG.models);
const initial = resolveSet(window.location.search, builtin, bank.byId);
const sets = initial.explicit ? [...builtin, initial] : builtin;
selectedSet = initial.explicit ? builtin.find((s) => s.id === initial.builtinId)?.id || builtin[0].id : initial.id;

// The model behind the chooser: the one a shared link or ?set= asks for, else the default.
await renderer.activate("mesh", initial.renderer === "mesh" ? initial.model : undefined).catch((err) => {
  console.error(err);
  if (err instanceof WebGLUnavailableError) showNoWebGL(err);
  else $("loading").textContent = `Couldn't load the 3D model. Please reload the page. (${err?.message || err})`;
  throw err;
});

const ui = {
  showIntro() {
    clearAnswerProposal();
    $("question").hidden = true;
    $("results").hidden = true;
    STATS_HIDDEN();
    showLanding();
  },
  started(list) {
    app.QUESTIONS = list;
    exploring = null;
    closeDetails();
    $("intro").hidden = true;
    $("results").hidden = true;
    $("explore-bar").hidden = true;
    $("explore-zoom").hidden = true;
    $("stats").hidden = false;
    setMode("quiz", { stay: true });
    setChrome();
  },
  showQuestion({ number, kind, prompt, hint }) {
    clearAnswerProposal();
    $("qkind").textContent = `Question ${number} · ${kind}`;
    $("qprompt").textContent = prompt;
    $("qhint").textContent = hint;
    $("qhint").hidden = !hint;
    $("feedback").hidden = true;
    $("question").hidden = false;
    setChrome();
  },
  showFeedback({ correct, verdict, explain, isLast }) {
    const v = $("verdict");
    v.className = "verdict " + (correct ? "good" : "bad");
    v.textContent = verdict;
    $("explain").textContent = explain;
    $("next").textContent = isLast ? "See your score" : "Next question";
    renderQuestionZoom(engine.current[engine.state.index]);
    $("feedback").hidden = false;
  },
  updateStats({ number, total, score, seconds }) {
    $("qcount").textContent = `${number}/${total}`;
    $("score").textContent = `${score} pts`;
    $("timer").textContent = fmtTime(seconds);
  },
  showResults({ score, total, seconds, verdictLine, review }) {
    $("question").hidden = true;
    $("final-score").textContent = `You scored ${score}/${total}`;
    $("final-time").textContent = `Time: ${fmtTime(seconds)}. ` + verdictLine;
    $("review").replaceChildren(
      ...review.map(({ correct, text }) => {
        const li = document.createElement("li");
        li.className = correct ? "good" : "bad";
        li.textContent = text;
        return li;
      })
    );
    $("share-status").hidden = true;
    $("results").hidden = false;
    setChrome();
  },
};

engine = createEngine({ renderer, questions: bank.questions, sets, ui, track });

// ---------- Set chooser ----------

const chooser = $("set-chooser");
function renderChooser() {
  // Chips grouped by what they are asked on: each 3D model, then the scans.
  const groups = new Map();
  for (const s of sets) {
    if (s.id === "custom" || s.id === "focus") continue;
    const g = s.group || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  chooser.replaceChildren(...[...groups].flatMap(([group, list]) => {
    const h = document.createElement("div");
    h.className = "chooser-group";
    h.textContent = group;
    const row = document.createElement("div");
    row.className = "chooser-row";
    row.append(...list.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = s.title;
      b.setAttribute("aria-pressed", String(s.id === selectedSet));
      b.addEventListener("click", () => {
        selectedSet = s.id;
        renderChooser();
        showFor(s); // the chosen set's model or scan appears behind the card right away
      });
      return b;
    }));
    return group ? [h, row] : [row];
  }));
}
renderChooser();

// Make a set's renderer the active one (building a model or scan viewer on first use).
// Returns false when it could not load; the page then shows why.
async function showFor(set) {
  const isScan = SCAN_KINDS.includes(set.renderer);
  const wanted = isScan ? set.study : set.model;
  const needsBuild = isScan ? renderer.study !== set.study : renderer.model !== set.model;
  const buttons = ["start", "again"].map($);
  buttons.forEach((b) => (b.disabled = true));
  if (needsBuild) {
    $("loading").textContent = isScan ? "Loading the scan…" : "Loading the model…";
    $("loading").hidden = false;
  }
  try {
    await renderer.activate(set.renderer || "mesh", wanted);
  } catch (err) {
    console.error(err);
    $("loading").textContent = `Couldn't load the ${isScan ? "scan" : "model"}. Please reload the page. (${err?.message || err})`;
    $("loading").hidden = false;
    buttons.forEach((b) => (b.disabled = false));
    return false;
  }
  $("loading").hidden = true;
  buttons.forEach((b) => (b.disabled = false));
  return true;
}

// ---------- Explore (no questions) ----------
// A body map: click a region of the figure (or its name), then choose what to look at there:
// the 3D model, or a CT, MRI, X-ray or ultrasound study of that region. The viewer keeps its
// layers, zoom buttons, cross-section or slice tools, and hover names, without a quiz.
const regions = buildBodyMap(bank.questions, CONFIG.models);
let exploring = null; // { region, option, study }
const figure = buildFigure(regions);
$("figure-slot").replaceChildren(figure);
upgradeFigure(figure, regions);
$("explore-row").replaceChildren(...regions.map((r) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.dataset.region = r.id;
  b.textContent = r.title;
  const small = document.createElement("small");
  small.textContent = r.options.map((o) => o.modality).join(" · ");
  b.append(small);
  return b;
}));
// Modality-first: one chip per modality, opening the first region that offers it (the region's
// other modalities stay one click away on the explore bar).
const MODALITY_ORDER = ["3D", "CT", "MRI", "X-ray", "Ultrasound", "Histology", "Cell"];
const modalities = [...new Set(regions.flatMap((r) => r.options.map((o) => o.modality)))].sort((a, b) => MODALITY_ORDER.indexOf(a) - MODALITY_ORDER.indexOf(b));
$("modality-row").replaceChildren(...modalities.map((m) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = m;
  b.title = regions.filter((r) => r.options.some((o) => o.modality === m)).map((r) => r.title).join(", ");
  b.addEventListener("click", () => {
    const region = regions.find((r) => r.options.some((o) => o.modality === m));
    figure.querySelectorAll(".zone").forEach((z) => z.classList.toggle("selected", z.dataset.region === region.id));
    exploreOption(region, region.options.find((o) => o.modality === m));
  });
  return b;
}));
const regionOf = (el) => regions.find((r) => r.id === el?.closest?.("[data-region]")?.dataset.region);
figure.addEventListener("click", (e) => { const r = regionOf(e.target); if (r) exploreRegion(r); });
figure.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { const r = regionOf(e.target); if (r) { e.preventDefault(); exploreRegion(r); } } });
$("explore-row").addEventListener("click", (e) => { const r = regionOf(e.target); if (r) exploreRegion(r); });

// Open a region on its first option (the 3D model where there is one, else the first modality).
function exploreRegion(region) {
  figure.querySelectorAll(".zone").forEach((z) => z.classList.toggle("selected", z.dataset.region === region.id));
  exploreOption(region, region.options[0]);
}

async function exploreOption(region, option, study = option.studies?.[0]) {
  exploring = { region, option, study };
  closeDetails();
  closeMenus();
  renderExploreBar();
  const ok = await showFor(option.renderer === "mesh" ? { renderer: "mesh", model: option.model } : { renderer: option.renderer, study });
  if (!ok || exploring?.option !== option || exploring.study !== study) return; // a later click won
  if (option.renderer === "mesh") { renderer.mesh?.showAll?.(); if (option.focus) renderer.mesh?.debug.setView?.("palmar", option.focus); }
  enterExplore();
  renderZoomChips(renderer.active, renderer.study || renderer.model, renderer.slide?.meta ?? renderer.cell?.meta);
  track("explore", { what: option.id, study });
}

// Leave the landing card for a viewer in explore mode: breadcrumb on, quiz off, hover and click show names.
function enterExplore() {
  $("intro").hidden = true;
  $("explore-bar").hidden = false;
  renderer.setPickEnabled(false);
  renderCrumbs();
  setChrome();
}

// The breadcrumb's region menu: what to look at in this region, a study picker, the model's zoom
// regions (filled by the mesh renderer) and the other regions of the body.
function renderExploreBar() {
  const { region, option, study } = exploring;
  $("explore-title").textContent = region.title;
  $("explore-modalities").replaceChildren(...region.options.map((o) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = o.label;
    b.setAttribute("aria-pressed", String(o === option));
    b.addEventListener("click", () => { if (o !== option || deep) exploreOption(region, o); });
    return b;
  }));
  const pick = $("explore-study");
  if ((option.studies?.length || 0) > 1) {
    pick.replaceChildren(...option.studies.map((id) => {
      const op = document.createElement("option");
      op.value = id; op.textContent = `Study: ${studyTitles.get(id) || studyLabel(id, option.sequences?.[id])}`; op.selected = id === study;
      return op;
    }));
    pick.hidden = false;
  } else pick.hidden = true;
  $("region-list").replaceChildren(...regions.filter((r) => r !== region).map((r) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = r.title;
    b.addEventListener("click", () => exploreRegion(r));
    return b;
  }));
}
$("explore-study").addEventListener("change", (e) => exploreOption(exploring.region, exploring.option, e.target.value));
$("explore-back").addEventListener("click", () => {
  exploring = null;
  deep = null;
  closeDetails();
  if (engine.state.state !== "intro") track("quit", { set: engine.set?.id, at: engine.state.index });
  setMode("explore", { stay: true });
  engine.intro();
});

// ---------- Confirming an answer ----------
// A tap on a structure does not answer yet: the structure is highlighted and a small bar along the
// bottom edge asks to confirm, so a slip of the finger can be undone. Confirm sends the answer; the X
// clears it and the question stays, and tapping another structure moves the highlight to that one.
// The bar does not name the structure, so it never gives the answer away.
let pendingAnswer = null;
function proposeAnswer(id) {
  if (engine.state.state !== "asking") return;
  pendingAnswer = id;
  renderer.clearHighlight();
  try { renderer.highlight(id, "select"); } catch { /* not every renderer can tint every key */ }
  $("answer-confirm").hidden = false;
}
function clearAnswerProposal() {
  if (pendingAnswer !== null) renderer.clearHighlight();
  pendingAnswer = null;
  $("answer-confirm").hidden = true;
}
$("answer-confirm-ok").addEventListener("click", () => {
  const id = pendingAnswer;
  if (id === null) return;
  clearAnswerProposal();
  engine.answer(id);
});
$("answer-confirm-close").addEventListener("click", () => clearAnswerProposal());

// ---------- Zoom between levels (organ -> tissue -> cell) ----------
// A slide study lists the structures it is a section of (`sections`, structure keys of the limb models) and the cell types on it
// (`cells`, CL ids); a cell study lists its slides. Those links become chips on the explore bar and,
// after an answer, buttons under the explanation. Each opens the linked study (or model, with the
// structure highlighted) in explore mode; from a question that leaves the quiz, so the button says so.
for (const q of bank.questions) {
  if (q.renderer === "cell" && q.study) cellStudies.set(q.tags?.cl || q.study, q.study);
  if (q.renderer === "slide" && q.study) slideStudies.set(q.study, true);
}
const explorableTitle = (kind, id) => kind === "mesh" ? CONFIG.models[id]?.title || id : studyTitles.get(id) || id;
// Open a model (with a structure highlighted) or a slide or cell study in explore mode, on the body-map
// entry that lists it, so the explore bar shows the right region, modality chips and study picker.
async function openExplore(kind, id, highlightKey) {
  const region = regions.find((r) => r.options.some((o) => (kind === "mesh" ? o.model === id : o.renderer === kind && o.studies?.includes(id)))) || regions[0];
  const option = region.options.find((o) => (kind === "mesh" ? o.model === id : o.renderer === kind && o.studies?.includes(id))) ||
    { id: `${kind}:${id}`, label: explorableTitle(kind, id), modality: kind, renderer: kind, model: kind === "mesh" ? id : undefined, studies: kind === "mesh" ? undefined : [id] };
  if (engine.state.state !== "intro") engine.intro();
  figure.querySelectorAll(".zone").forEach((z) => z.classList.toggle("selected", z.dataset.region === region.id));
  exploring = { region, option, study: kind === "mesh" ? undefined : id };
  renderExploreBar();
  if (!(await showFor(kind === "mesh" ? { renderer: "mesh", model: id } : { renderer: kind, study: id }))) return;
  if (exploring?.option !== option) return; // a later click won
  closeDetails();
  if (kind === "mesh") deep = null;
  enterExplore();
  if (highlightKey && kind === "mesh") { openDetails(highlightKey); renderer.mesh?.fit?.(highlightKey); }
  else if (highlightKey) { try { renderer.highlight(highlightKey, "good"); } catch { /* the id may not be in this model */ } }
  renderZoomChips(renderer.active, renderer.study || renderer.model, renderer.slide?.meta ?? renderer.cell?.meta);
  track("explore", { what: `${kind}:${id}`, via: "zoom" });
}
// Links out of a study: [{ dir: "in"|"out", kind, id, label, key }]
function zoomLinks(kind, id, meta) {
  const links = [];
  if (kind === "slide" && meta) {
    for (const cl of meta.cells || []) { const sid = cellStudies.get(cl); if (sid) links.push({ dir: "in", kind: "cell", id: sid, label: explorableTitle("cell", sid) }); }
    const fma = (meta.sections || [])[0];
    if (fma) { const model = modelForFma(fma); links.push({ dir: "out", kind: "mesh", id: model, label: CONFIG.models[model]?.title || model, key: fma }); }
  } else if (kind === "cell" && meta) {
    for (const sid of meta.slides || []) if (slideStudies.has(sid)) links.push({ dir: "out", kind: "slide", id: sid, label: explorableTitle("slide", sid) });
  } else if (kind === "mesh" && meta?.sections === undefined) {
    // From a model, every slide that sections something in it.
    for (const [sid] of slideStudies) { const m = slideMeta.get(sid); if (m && (m.sections || []).some((f) => modelForFma(f) === id)) links.push({ dir: "in", kind: "slide", id: sid, label: explorableTitle("slide", sid) }); }
  }
  return links;
}
async function loadZoomIndex() {
  for (const [model, m] of Object.entries(CONFIG.models)) {
    try {
      const st = await fetch(m.structuresUrl).then((r) => r.json());
      for (const k of Object.keys(st.structures || st)) fmaModel.set(k, fmaModel.get(k) || model);
      for (const n of st.nodes || []) if (n.structure && n.layer && !structureLayer.has(n.structure)) structureLayer.set(n.structure, n.layer);
    } catch { /* optional */ }
  }
  for (const [sid] of slideStudies) {
    try { const m = await fetch(`assets/slides/${sid}/study.json`).then((r) => r.json()); slideMeta.set(sid, m); studyTitles.set(sid, m.title || sid); } catch { /* optional */ }
  }
  for (const [, cid] of cellStudies) {
    try { const m = await fetch(`assets/cells/${cid}/study.json`).then((r) => r.json()); studyTitles.set(cid, m.title || cid); } catch { /* optional */ }
  }
  zoomReady = true;
  if (exploring) renderExploreBar(); // the study picker can now show manifest titles
  renderZoomChips(renderer.active, renderer.study || renderer.model, renderer.slide?.meta ?? renderer.cell?.meta);
}
const modelForFma = (fma) => fmaModel.get(fma) || Object.keys(CONFIG.models)[0];
function chipFor(l) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "chip zoom-chip";
  // "Zoom" is kept for the camera; moving between scales says where it goes.
  b.textContent = l.kind === "cell" ? `Zoom to a cell: ${l.label}` : l.kind === "slide" ? `Slide: ${l.label}` : `See it in 3D: ${l.label}`;
  b.addEventListener("click", () => openExplore(l.kind, l.id, l.key));
  return b;
}
function renderZoomChips(kind, id, meta) {
  const row = $("explore-zoom");
  if (!row || !zoomReady) return;
  const m = kind === "mesh" ? {} : meta || slideMeta.get(id);
  row.replaceChildren(...(kind === "mesh" ? [] : zoomLinks(kind, id, m).map(chipFor)));
  row.hidden = !row.children.length || !$("intro").hidden || engine.state.state !== "intro";
}
// Under the explanation: the question's own zoom field ("model:upper-limb#biceps_brachii", "cell:cl-0008002", "slide:muscle-ls").
function renderQuestionZoom(q) {
  const row = $("feedback-zoom");
  if (!row) return;
  row.replaceChildren();
  for (const dir of ["in", "out"]) {
    const ref = q?.zoom?.[dir];
    if (!ref) continue;
    const [kind, rest] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    const [id, key] = rest.split("#");
    const k = kind === "model" ? "mesh" : kind;
    const label = k === "mesh" ? CONFIG.models[id]?.title || id : explorableTitle(k, id);
    row.append(chipFor({ dir, kind: k, id, key, label: `${label} (leaves the quiz)` }));
  }
  row.hidden = !row.children.length;
}
loadZoomIndex();

// ---------- Page chrome: landing, modes, menus ----------
// One landing card with two panes: the body map (Explore) and the set chooser with search (Quiz).
// Everything else on screen depends on what is showing; setChrome() keeps it in step.
let mode = "explore";
let deep = null; // { kind, id, from: { model, key, camera } } while a slide, cell or scan opened from a structure is showing
let selected = null; // structure key open in the details panel
function setMode(m, { stay = false } = {}) {
  mode = m;
  $("mode-explore").setAttribute("aria-pressed", String(m === "explore"));
  $("mode-quiz").setAttribute("aria-pressed", String(m === "quiz"));
  $("explore-home").hidden = m !== "explore";
  $("quiz-home").hidden = m !== "quiz";
  if (stay) return;
  if (engine.state.state !== "intro") { track("quit", { set: engine.set?.id, at: engine.state.index }); }
  exploring = null; deep = null;
  closeDetails();
  engine.intro(); // stops any quiz and shows the landing card in this mode
  if (m === "quiz") setTimeout(() => $("quiz-search").focus(), 0);
}
$("mode-explore").addEventListener("click", () => setMode("explore"));
$("mode-quiz").addEventListener("click", () => setMode("quiz"));

function showLanding() {
  $("intro").hidden = false;
  $("explore-bar").hidden = true;
  $("explore-zoom").hidden = true;
  closeDetails();
  closeMenus();
  setMode(mode, { stay: true });
  setChrome();
}

// Body classes the stylesheet keys on: landing (the card is up), quizzing (a question or the results).
function setChrome() {
  const landing = !$("intro").hidden;
  const quizzing = !$("question").hidden || !$("results").hidden;
  document.body.classList.toggle("landing", landing);
  document.body.classList.toggle("quizzing", quizzing);
  $("quiz-fab").hidden = landing || quizzing || !quizSetForView();
  if (landing || quizzing) $("slice-bar").hidden = true;
}

function closeMenus(except) {
  for (const [btn, menu] of MENUS) if (menu !== except) { $(menu).hidden = true; $(btn).setAttribute("aria-expanded", "false"); }
}
const MENUS = [["region-crumb", "region-menu"], ["views-toggle", "views-menu"], ["controls-toggle", "layers-menu"]];
for (const [btn, menu] of MENUS) {
  $(btn).addEventListener("click", () => {
    const open = $(menu).hidden;
    closeMenus(menu);
    $(menu).hidden = !open;
    $(btn).setAttribute("aria-expanded", String(open));
  });
}
// A click outside every menu closes them (clicks inside still bubble to the mesh renderer's view and zoom handler).
document.addEventListener("click", (e) => { if (!e.target.closest?.(".menu-wrap")) closeMenus(); });
// A view or zoom choice closes its menu (the mesh renderer moves the camera on the same click).
$("views-menu").addEventListener("click", (e) => { if (e.target.closest("[data-view]")) setTimeout(() => closeMenus(), 0); });
$("zoom-row").addEventListener("click", (e) => { if (e.target.closest("[data-focus]")) setTimeout(() => closeMenus(), 0); });

$("credits-toggle").addEventListener("click", () => {
  const open = $("credits").hidden;
  $("credits").hidden = !open;
  $("credits-toggle").setAttribute("aria-expanded", String(open));
});
$("credits-close").addEventListener("click", () => { $("credits").hidden = true; $("credits-toggle").setAttribute("aria-expanded", "false"); });

// ---------- 3D toolbar ----------
$("zoom-in").addEventListener("click", () => renderer.mesh?.zoomBy?.(0.8));
$("zoom-out").addEventListener("click", () => renderer.mesh?.zoomBy?.(1.25));
$("fit").addEventListener("click", () => renderer.mesh?.fit?.(selected));
function setSlice(on) {
  $("slice-bar").hidden = !on;
  $("slice-toggle").setAttribute("aria-pressed", String(on));
  if (!on) { $("slice").value = 0; $("slice").dispatchEvent(new Event("input")); }
}
$("slice-toggle").addEventListener("click", () => setSlice($("slice-bar").hidden));
$("show-all").addEventListener("click", () => { renderer.mesh?.showAll?.(); updateShowAll(); });
const updateShowAll = () => { $("show-all").hidden = !renderer.mesh?.hiddenCount; };

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const mesh = renderer.active === "mesh" && $("intro").hidden;
  if (e.key === "Escape") {
    if (MENUS.some(([, m]) => !$(m).hidden)) closeMenus();
    else if (!$("credits").hidden) $("credits").hidden = true;
    else if (deep) backToStructure();
    else if (selected) closeDetails();
    return;
  }
  if (!mesh) return;
  if (e.key === "f" || e.key === "F") renderer.mesh?.fit?.(selected);
  else if (e.key === "l" || e.key === "L") $("controls-toggle").click();
  else if (e.key === "+" || e.key === "=") renderer.mesh?.zoomBy?.(0.8);
  else if (e.key === "-" || e.key === "_") renderer.mesh?.zoomBy?.(1.25);
});

// ---------- Breadcrumb ----------
// Region › structure › deeper view (a slide, cell or scan opened from that structure).
function renderCrumbs() {
  const s = selected || deep?.from.key;
  const name = s ? (deep ? deep.from.name : renderer.name(s)) : "";
  $("crumb-structure").textContent = name;
  $("crumb-structure").hidden = $("crumb-structure-sep").hidden = !name;
  $("crumb-structure").disabled = !deep;
  $("crumb-structure").title = deep ? `Back to ${name} on the 3D model (Esc)` : "";
  $("crumb-deep").textContent = deep?.label || "";
  $("crumb-deep").hidden = $("crumb-deep-sep").hidden = !deep;
}
$("crumb-structure").addEventListener("click", () => { if (deep) backToStructure(); });

// ---------- Details panel ----------
const LAYER_LABELS = { skin: "Skin", muscle: "Muscle", tendon: "Tendon", ligament: "Ligament", nerve: "Nerve", vessel: "Vessel", bone: "Bone", organ: "Organ" };
const modelTitle = (id) => CONFIG.models[id]?.title || id;

function onStructureClick(key) {
  if (!$("intro").hidden || engine.state.state !== "intro") return; // the landing card is up, or a quiz is running
  if (!key) { closeDetails(); return; }
  openDetails(key);
}

function openDetails(key) {
  if (selected && selected !== key) renderer.clearHighlight();
  selected = key;
  const mesh = renderer.mesh;
  renderer.highlight(key, "select");
  const layer = mesh?.layerOf?.(key);
  $("details-name").textContent = renderer.name(key);
  $("details-meta").textContent = [LAYER_LABELS[layer] || layer, modelTitle(renderer.model)].filter(Boolean).join(" · ");
  const hist = slidesFor(key, layer), img = imagingFor(key);
  setGo($("go-histology"), hist.slides.length, "No slide yet for this tissue");
  setGo($("go-imaging"), img.length, "Not visible on the scans we have");
  $("details-list").hidden = true;
  $("details-note").hidden = true;
  $("act-quiz").hidden = !questionsAbout(key).length;
  $("details").hidden = false;
  document.body.classList.add("details-open");
  renderCrumbs();
  track("select", { model: renderer.model, structure: key });
}
function setGo(btn, n, why) {
  btn.disabled = !n;
  btn.title = n ? "" : why;
  btn.setAttribute("aria-pressed", "false");
}
function closeDetails() {
  if (selected && renderer.active === "mesh") renderer.clearHighlight();
  selected = null;
  $("details").hidden = true;
  document.body.classList.remove("details-open");
  if ($("explore-bar") && !$("explore-bar").hidden) renderCrumbs();
}
$("details-close").addEventListener("click", closeDetails);
$("act-isolate").addEventListener("click", () => {
  const m = renderer.mesh; if (!m || !selected) return;
  m.isolate(m.isolated === selected ? null : selected);
  $("act-isolate").textContent = m.isolated ? "Show everything" : "Isolate";
  updateShowAll();
});
$("act-hide").addEventListener("click", () => {
  const m = renderer.mesh; if (!m || !selected) return;
  m.hide(selected);
  closeDetails();
  updateShowAll();
});
$("act-quiz").addEventListener("click", () => {
  if (!selected) return;
  const list = questionsAbout(selected);
  startFocus({ title: renderer.name(selected), renderer: "mesh", model: renderer.model, list });
});

// A list under the two buttons: one row per destination, grouped under small headings.
function showList(groups, note) {
  const box = $("details-list");
  box.replaceChildren(...groups.flatMap(({ heading, items }) => {
    const out = [];
    if (heading) { const h = document.createElement("div"); h.className = "menu-label"; h.textContent = heading; out.push(h); }
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "list-item"; b.textContent = it.label;
      if (it.sub) { const sm = document.createElement("small"); sm.textContent = it.sub; b.append(sm); }
      b.addEventListener("click", it.go);
      out.push(b);
    }
    return out;
  }));
  box.hidden = false;
  $("details-note").textContent = note || "";
  $("details-note").hidden = !note;
}

// Histology: slides that section this structure; failing that, a slide of the same tissue (by layer).
function slidesFor(key, layer) {
  const direct = [...slideMeta].filter(([, m]) => (m.sections || []).includes(key)).map(([id]) => id);
  if (direct.length) return { slides: direct, representative: false };
  const byLayer = [...slideMeta].filter(([, m]) => (m.sections || []).some((k) => layerOfAny(k) === layer)).map(([id]) => id);
  return { slides: layer ? byLayer : [], representative: true };
}
// The layer of a structure key in whichever loaded model has it.
function layerOfAny(key) {
  return renderer.mesh?.layerOf?.(key) || structureLayer.get(key) || null;
}
$("go-histology").addEventListener("click", () => {
  if (!selected) return;
  const { slides, representative } = slidesFor(selected, renderer.mesh?.layerOf?.(selected));
  const note = representative ? "Representative tissue: no slide of this exact structure yet." : "";
  if (slides.length === 1 && !representative) { openDeep("slide", slides[0]); return; }
  $("go-histology").setAttribute("aria-pressed", "true"); $("go-imaging").setAttribute("aria-pressed", "false");
  showList([{ items: slides.map((id) => ({ label: studyTitles.get(id) || id, go: () => openDeep("slide", id) })) }], note);
});

// Imaging: every study whose labels include this structure, as CT or MRI, plus X-ray and ultrasound
// for the CT studies those viewers use.
let crosswalk = { map: {}, studies: {} };
fetch("assets/imaging-crosswalk.json").then((r) => r.json()).then((x) => { crosswalk = x; if (selected) openDetails(selected); }).catch(() => {});
const xrayStudies = new Set(bank.questions.filter((q) => q.renderer === "xray").map((q) => q.study));
const usStudies = new Set(bank.questions.filter((q) => q.renderer === "ultrasound").map((q) => q.study));
function imagingFor(key) {
  const keys = crosswalk.map[key] || [];
  if (!keys.length) return [];
  const out = [];
  for (const [study, st] of Object.entries(crosswalk.studies)) {
    const here = keys.filter((k) => st.keys.includes(k));
    if (!here.length) continue;
    const label = studyTitles.get(study) || (st.modality === "CT" ? `Study ${studyLabel(study)}` : st.title);
    out.push({ modality: st.modality, kind: "volume", study, keys: here, label });
    if (st.modality === "CT" && xrayStudies.has(study)) out.push({ modality: "X-ray", kind: "xray", study, keys: here, label: `Radiograph from study ${studyLabel(study)}` });
    if (st.modality === "CT" && usStudies.has(study)) out.push({ modality: "Ultrasound", kind: "ultrasound", study, keys: here, label: `Simulated from study ${studyLabel(study)}` });
  }
  return out;
}
$("go-imaging").addEventListener("click", () => {
  if (!selected) return;
  const list = imagingFor(selected);
  $("go-imaging").setAttribute("aria-pressed", "true"); $("go-histology").setAttribute("aria-pressed", "false");
  const groups = ["CT", "MRI", "X-ray", "Ultrasound"].map((m) => ({ heading: m, items: list.filter((x) => x.modality === m).map((x) => ({ label: x.label, go: () => openDeep(x.kind, x.study, x.keys) })) })).filter((g) => g.items.length);
  showList(groups);
});

// Open a slide or scan from the selected structure, remembering the 3D view to come back to.
async function openDeep(kind, id, scanKeys = []) {
  const m = renderer.mesh;
  const from = deep?.from || { model: renderer.model, key: selected, name: renderer.name(selected),
    camera: m && { pos: m.debug.camera.position.clone(), target: m.debug.controls.target.clone(), up: m.debug.camera.up.clone() } };
  const label = kind === "slide" ? `Histology: ${studyTitles.get(id) || id}` : kind === "cell" ? `Cell: ${studyTitles.get(id) || id}`
    : `${{ volume: crosswalk.studies[id]?.modality || "CT", xray: "X-ray", ultrasound: "Ultrasound" }[kind]}: ${renderer.name(from.key)}`;
  deep = { kind, id, from, label };
  closeDetails();
  if (!(await showFor({ renderer: kind, study: id }))) return;
  if (deep?.id !== id) return; // a later click won
  renderer.setPickEnabled(false);
  renderer.clearHighlight();
  for (const k of scanKeys) { try { renderer.highlight(k, "good"); } catch { /* not in this study */ } }
  enterExplore();
  renderZoomChips(renderer.active, renderer.study || renderer.model, renderer.slide?.meta ?? renderer.cell?.meta);
  track("explore", { what: `${kind}:${id}`, via: "details", structure: from.key });
}
async function backToStructure() {
  const from = deep?.from;
  deep = null;
  if (!from?.model) { renderCrumbs(); return; }
  if (!(await showFor({ renderer: "mesh", model: from.model }))) return;
  const m = renderer.mesh;
  if (from.camera && m) {
    m.debug.camera.position.copy(from.camera.pos);
    m.debug.camera.up.copy(from.camera.up);
    m.debug.controls.target.copy(from.camera.target);
    m.debug.controls.update();
  }
  enterExplore();
  $("explore-zoom").hidden = true;
  if (from.key) openDetails(from.key);
}

// ---------- Quiz: search, focus sets, the quiz button in each view ----------
// A "focus" set is built on the fly (one structure, one search result, one view) and replaces the last one.
function startFocus({ title, renderer: r, model, study, list }) {
  if (!list.length) return;
  const set = { id: "focus", title, renderer: r, model, study: study || list[0].study, group: "", pick: () => shuffle(list).slice(0, 10) };
  const i = sets.findIndex((s) => s.id === "focus");
  if (i >= 0) sets[i] = set; else sets.push(set);
  exploring = null; deep = null;
  begin("focus");
}
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const isMeshQ = (q) => !SCAN_KINDS.includes(q.renderer);
const qModel = (q) => q.model || Object.keys(CONFIG.models)[0];
function questionsAbout(key) {
  return bank.questions.filter((q) => isMeshQ(q) && qModel(q) === renderer.model && (q.target === key || (q.accept || []).includes(key)));
}

// The set the quiz button starts for what is on screen: the model's random 10, or the set asked on this scan.
function quizSetForView() {
  if (renderer.active === "mesh") {
    const prefix = renderer.model === Object.keys(CONFIG.models)[0] ? "" : `${renderer.model}:`;
    return sets.find((s) => s.id === `${prefix}random`) || null;
  }
  const study = renderer.study;
  return sets.find((s) => s.renderer === renderer.active && s.study === study)
    || sets.find((s) => s.renderer === renderer.active && bank.questions.some((q) => q.renderer === s.renderer && q.study === study && s.pick([q], "").length))
    || sets.find((s) => s.renderer === renderer.active) || null;
}
$("quiz-fab").addEventListener("click", () => {
  const set = quizSetForView();
  if (!set) return;
  track("quiz_fab", { set: set.id });
  exploring = null; deep = null;
  closeDetails();
  selectedSet = set.id;
  renderChooser();
  begin(set.id);
});

// Search: every word must appear in a question's prompt, target, topic, region or kind.
// Results are grouped by where the questions are asked (a 3D model, or a modality and region).
const RENDERER_LABEL = { xray: "X-ray", ultrasound: "Ultrasound", slide: "Histology", cell: "Cells" };
const haystack = new Map(bank.questions.map((q) => [q, [q.prompt, q.target, ...(q.accept || []), q.tags?.topic, q.tags?.region, q.kind, q.tags?.modality].filter(Boolean).join(" ").toLowerCase().replaceAll("_", " ")]));
function searchQuestions(text) {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const groups = new Map();
  for (const [q, h] of haystack) {
    if (!words.every((w) => h.includes(w))) continue;
    const mesh = isMeshQ(q);
    const key = mesh ? `mesh:${qModel(q)}` : `${q.renderer}:${q.tags?.modality || ""}:${q.tags?.region || q.study}`;
    if (!groups.has(key)) {
      const region = q.tags?.region ? q.tags.region[0].toUpperCase() + q.tags.region.slice(1) : q.study;
      groups.set(key, { title: mesh ? `${modelTitle(qModel(q))} in 3D` : `${RENDERER_LABEL[q.renderer] || q.tags?.modality || "CT"}: ${region}`, renderer: mesh ? "mesh" : q.renderer, model: mesh ? qModel(q) : undefined, list: [] });
    }
    groups.get(key).list.push(q);
  }
  return [...groups.values()].sort((a, b) => b.list.length - a.list.length);
}
function renderSearch() {
  const text = $("quiz-search").value.trim();
  const box = $("quiz-results");
  if (text.length < 2) { box.hidden = true; $("set-chooser").hidden = false; $("start").hidden = false; return; }
  const lower = text.toLowerCase();
  const setHits = sets.filter((s) => s.id !== "custom" && s.id !== "focus" && `${s.group} ${s.title}`.toLowerCase().includes(lower));
  const groups = searchQuestions(text);
  const rows = [];
  for (const s of setHits.slice(0, 6)) rows.push({ label: s.group ? `${s.group}: ${s.title}` : s.title, sub: "Question set", go: () => { selectedSet = s.id; renderChooser(); begin(s.id); } });
  for (const g of groups.slice(0, 8)) rows.push({ label: g.title, sub: `${g.list.length} question${g.list.length === 1 ? "" : "s"} about “${text}”`, go: () => startFocus({ title: `${text} · ${g.title}`, renderer: g.renderer, model: g.model, list: g.list }) });
  box.replaceChildren(...(rows.length ? rows.map((it) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "list-item"; b.textContent = it.label;
    const sm = document.createElement("small"); sm.textContent = it.sub; b.append(sm);
    b.addEventListener("click", it.go);
    return b;
  }) : [Object.assign(document.createElement("p"), { className: "fine", textContent: "No questions match that yet." })]));
  box.hidden = false;
  $("set-chooser").hidden = true;
  $("start").hidden = true;
}
$("quiz-search").addEventListener("input", renderSearch);
$("quiz-search").addEventListener("keydown", (e) => { if (e.key === "Enter") $("quiz-results").querySelector(".list-item")?.click(); });

// A shared link plays exactly its questions; otherwise the chosen set.
let pendingShared = initial.explicit;

// Load what the set is asked on, then play.
async function begin(setId, replay = false) {
  const set = sets.find((s) => s.id === setId) || sets[0];
  if (await showFor(set)) engine.start(setId, replay);
}
$("start").addEventListener("click", () => {
  const id = pendingShared ? "custom" : selectedSet;
  pendingShared = false;
  begin(id);
});
$("again").addEventListener("click", () => begin(engine.set.id, true));
$("new-set").addEventListener("click", () => {
  pendingShared = false;
  engine.intro(); // the last model or scan stays behind the chooser
});
$("next").addEventListener("click", () => engine.next());
$("quit").addEventListener("click", () => {
  track("quit", { set: engine.set?.id, at: engine.state.index });
  engine.intro(); // stops the clock, clears highlights, shows the body map and sets again
});

// ---------- Share ----------

$("share").addEventListener("click", async () => {
  const url = engine.shareUrl();
  const text = engine.shareText();
  track("share_click", { score: engine.state.score, set: engine.set.builtinId || engine.set.id });
  const status = $("share-status");
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: "Hand Nerves 3D Challenge", text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url}`);
    status.textContent = "Link copied. Paste it anywhere.";
  } catch {
    status.textContent = url;
  }
  status.hidden = false;
});

// ---------- Email signup ----------

const dialog = $("signup");
if (!CONFIG.signupEnabled) $("more").hidden = true;
if (CONFIG.kitFormUid) {
  // Kit's runtime (loaded by the data-uid script tag in index.html) opens its modal form on
  // any click of an element with data-formkit-toggle, so the button needs no handler of its own.
  $("more").dataset.formkitToggle = CONFIG.kitFormUid;
  $("more").addEventListener("click", () => {
    track("signup_open", { score: engine.state.score });
    // If the Kit script was blocked or has not loaded, open the form page instead.
    if (!document.querySelector(`form[data-uid="${CONFIG.kitFormUid}"]`) && CONFIG.kitFormUrl) window.open(CONFIG.kitFormUrl, "_blank", "noopener");
  });
  // Kit fires this (bubbling) when a subscription was accepted.
  document.addEventListener("ckjs:submission:complete", () => track("signup", { score: engine.state.score }));
}
$("more").addEventListener("click", () => {
  if (!CONFIG.signupEnabled || CONFIG.kitFormUid) return;
  track("signup_open", { score: engine.state.score });
  $("signup-status").hidden = true;
  dialog.showModal();
});
$("signup-cancel").addEventListener("click", () => dialog.close());
$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("signup-email").value.trim();
  const status = $("signup-status");
  $("signup-submit").disabled = true;
  if (!CONFIG.signupUrl) {
    status.textContent = "Signups aren't connected on this copy of the page.";
    status.hidden = false;
    $("signup-submit").disabled = false;
    return;
  }
  try {
    const r = await fetch(CONFIG.signupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, visitor, score: engine.state.score }),
    });
    if (!r.ok) throw new Error(String(r.status));
    track("signup", { score: engine.state.score });
    status.textContent = "You're on the list. Thanks!";
    status.hidden = false;
    setTimeout(() => dialog.close(), 1400);
  } catch {
    status.textContent = "Couldn't save that just now. Please try again.";
    status.hidden = false;
  } finally {
    $("signup-submit").disabled = false;
  }
});

// ---------- Visit ----------

const shared = initial.explicit ? readSharedScore(initial.pick().length) : null;
if (shared) {
  const b = $("shared-banner");
  b.textContent = `A friend scored ${shared.s}/${shared.n}${shared.t ? ` in ${fmtTime(shared.t)}` : ""}. Can you beat it?`;
  b.hidden = false;
}
track("visit", { via: shared ? "share" : document.referrer ? "referral" : "direct", ref: document.referrer ? new URL(document.referrer).hostname : "" });
checkReturnVisit();

$("loading").hidden = true;
$("start").disabled = false;
// A shared score or a ?set= link opens on the quiz; everything else on the body map.
setMode(initial.explicit || new URLSearchParams(window.location.search).has("set") ? "quiz" : "explore", { stay: true });
setChrome();

// Exposed for automated checks (tools/smoke_test.mjs). The mesh debug handles follow the active model.
for (const k of ["viewTween", "controls", "camera", "meshesByStructure", "pick", "setView", "setLayers"]) {
  Object.defineProperty(app, k, { get: () => renderer.mesh?.debug[k] });
}
Object.assign(app, { quiz: engine.state, answer: engine.answer, engine, renderer, switch: renderer, openExplore, openDetails, openDeep, backToStructure, setMode, imagingFor, slidesFor: (k) => slidesFor(k, layerOfAny(k)) });
app.QUESTIONS ||= engine.current;
