// Wiring: boot, renderer, bank, sets, engine, share and signup.
import { CONFIG } from "./config.js";
import { track, visitor, checkReturnVisit } from "./analytics.js";
import { loadBanks } from "./bank.js";
import { buildSets, resolveSet } from "./sets.js";
import { buildBodyMap, buildFigure, studyLabel } from "./bodymap.js";
import { createEngine, fmtTime } from "./engine.js";
import { createRendererSwitch } from "./renderers/switch.js";
import { WebGLUnavailableError, webglHelp } from "./webgl-probe.js";

const $ = (id) => document.getElementById(id);
const SCAN_KINDS = ["volume", "xray", "ultrasound"];
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
  onPick: (id) => engine.answer(id),
  onChange: (kind, id, meta) => {
    // One attribution line per source: the mesh renderer shows its model's line when active,
    // and a scan shows the line for its modality (the study's manifest says which it is).
    // X-ray and ultrasound are computed from the CT studies, so they show the CT line with their own.
    const scan = SCAN_KINDS.includes(kind);
    if (scan) $("attr-bp3d").hidden = $("attr-o3d").hidden = true;
    $("attr-ct").hidden = !(scan && (kind !== "volume" || meta?.modality !== "MR"));
    $("attr-mr").hidden = !(kind === "volume" && meta?.modality === "MR");
    $("attr-xray").hidden = kind !== "xray";
    $("attr-us").hidden = kind !== "ultrasound";
    if (meta?.modality === "MR") { // the MRI line names the study's own source: MR studies come from more than one dataset
      const a = $("attr-mr-src");
      a.textContent = `${meta.attribution || meta.source || meta.id}${meta.license ? ", " + meta.license : ""}`;
      if (meta.sourceUrl) a.href = meta.sourceUrl; else a.removeAttribute("href");
    }
  },
});

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
    "assets/questions/upper-limb.json", "assets/questions/lower-limb.json",
    "assets/questions/ct-trunk.json", "assets/questions/ct-chest.json",
    "assets/questions/mri-abdomen.json", "assets/questions/mri-prostate.json", "assets/questions/mri-heart.json", "assets/questions/mri-hippocampus.json",
    "assets/questions/mri-brain-t1.json", "assets/questions/mri-brain-t2.json", "assets/questions/mri-brain-pd.json",
    "assets/questions/xray-chest.json", "assets/questions/xray-abdomen.json", "assets/questions/us-trunk.json",
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
    $("question").hidden = true;
    $("results").hidden = true;
    $("intro").hidden = false;
    STATS_HIDDEN();
  },
  started(list) {
    app.QUESTIONS = list;
    $("intro").hidden = true;
    $("results").hidden = true;
    $("stats").hidden = false;
  },
  showQuestion({ number, kind, prompt, hint }) {
    $("qkind").textContent = `Question ${number} · ${kind}`;
    $("qprompt").textContent = prompt;
    $("qhint").textContent = hint;
    $("qhint").hidden = !hint;
    $("feedback").hidden = true;
    $("question").hidden = false;
  },
  showFeedback({ correct, verdict, explain, isLast }) {
    const v = $("verdict");
    v.className = "verdict " + (correct ? "good" : "bad");
    v.textContent = verdict;
    $("explain").textContent = explain;
    $("next").textContent = isLast ? "See your score" : "Next question";
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
  },
};

engine = createEngine({ renderer, questions: bank.questions, sets, ui, track });

// ---------- Set chooser ----------

const chooser = $("set-chooser");
function renderChooser() {
  // Chips grouped by what they are asked on: each 3D model, then the scans.
  const groups = new Map();
  for (const s of sets) {
    if (s.id === "custom") continue;
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
$("explore-row").replaceChildren(...regions.map((r) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.dataset.region = r.id;
  b.textContent = r.title;
  b.title = r.options.map((o) => o.modality).join(", ");
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
  renderExploreBar();
  const ok = await showFor(option.renderer === "mesh" ? { renderer: "mesh", model: option.model } : { renderer: option.renderer, study });
  if (!ok || exploring?.option !== option || exploring.study !== study) return; // a later click won
  if (option.renderer === "mesh" && option.focus) renderer.mesh?.debug.setView?.("palmar", option.focus);
  $("intro").hidden = true;
  $("explore-bar").hidden = false;
  renderer.setPickEnabled(false); // clicks and hovers show names
  track("explore", { what: option.id, study });
}

// The explore bar: the region, one chip per modality, a study picker when a modality has several.
function renderExploreBar() {
  const { region, option, study } = exploring;
  $("explore-title").textContent = region.title;
  $("explore-modalities").replaceChildren(...region.options.map((o) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = o.label;
    b.setAttribute("aria-pressed", String(o === option));
    b.addEventListener("click", () => { if (o !== option) exploreOption(region, o); });
    return b;
  }));
  const pick = $("explore-study");
  if ((option.studies?.length || 0) > 1) {
    pick.replaceChildren(...option.studies.map((id) => {
      const op = document.createElement("option");
      op.value = id; op.textContent = `Study: ${studyLabel(id, option.sequences?.[id])}`; op.selected = id === study;
      return op;
    }));
    pick.hidden = false;
  } else pick.hidden = true;
}
$("explore-study").addEventListener("change", (e) => exploreOption(exploring.region, exploring.option, e.target.value));
$("explore-back").addEventListener("click", () => {
  exploring = null;
  $("explore-bar").hidden = true;
  engine.intro();
});

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
$("more").addEventListener("click", () => {
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

// Exposed for automated checks (tools/smoke_test.mjs). The mesh debug handles follow the active model.
for (const k of ["viewTween", "controls", "camera", "meshesByStructure", "pick", "setView", "setLayers"]) {
  Object.defineProperty(app, k, { get: () => renderer.mesh?.debug[k] });
}
Object.assign(app, { quiz: engine.state, answer: engine.answer, engine, renderer, switch: renderer });
app.QUESTIONS ||= engine.current;
