// Wiring: boot, renderer, bank, sets, engine, share and signup.
import { CONFIG } from "./config.js";
import { track, visitor, checkReturnVisit } from "./analytics.js";
import { loadBank } from "./bank.js";
import { buildSets, resolveSet } from "./sets.js";
import { createEngine, fmtTime } from "./engine.js";
import { createMeshRenderer } from "./renderers/mesh.js";
import { WebGLUnavailableError, webglHelp } from "./webgl-probe.js";

const $ = (id) => document.getElementById(id);
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

const renderer = await createMeshRenderer({
  container: $("viewer"),
  modelUrl: CONFIG.modelUrl,
  structuresUrl: "assets/model/structures.json",
  onPick: (id) => engine.answer(id),
}).catch((err) => {
  console.error(err);
  if (err instanceof WebGLUnavailableError) showNoWebGL(err);
  else $("loading").textContent = `Couldn't load the 3D model. Please reload the page. (${err?.message || err})`;
  throw err;
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
  bank = await loadBank("assets/questions/upper-limb.json");
} catch (err) {
  console.error(err);
  $("loading").textContent = "Couldn't load the questions. Please reload the page.";
  throw err;
}

const builtin = buildSets(bank.questions);
const initial = resolveSet(window.location.search, builtin, bank.byId);
const sets = initial.explicit ? [...builtin, initial] : builtin;
selectedSet = initial.explicit ? builtin.find((s) => s.id === initial.builtinId)?.id || builtin[0].id : initial.id;

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
  chooser.replaceChildren(
    ...sets.filter((s) => s.id !== "custom").map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = s.title;
      b.setAttribute("aria-pressed", String(s.id === selectedSet));
      b.addEventListener("click", () => {
        selectedSet = s.id;
        renderChooser();
      });
      return b;
    })
  );
}
renderChooser();

// A shared link plays exactly its questions; otherwise the chosen set.
let pendingShared = initial.explicit;
$("start").addEventListener("click", () => {
  engine.start(pendingShared ? "custom" : selectedSet);
  pendingShared = false;
});
$("again").addEventListener("click", () => engine.start(engine.set.id, true));
$("new-set").addEventListener("click", () => {
  pendingShared = false;
  engine.intro();
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

// Exposed for automated checks (tools/smoke_test.mjs).
Object.assign(app, renderer.debug, { quiz: engine.state, answer: engine.answer, engine, renderer });
app.QUESTIONS ||= engine.current;
