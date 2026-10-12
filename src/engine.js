// Quiz engine: renderer-independent state machine. It never touches the DOM or
// three; the page passes in a renderer (see renderers/mesh.js) and ui callbacks.
export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function verdictLine(score, n) {
  if (score === n) return "Perfect. Your anatomy practical is in trouble.";
  if (score >= n * 0.8) return "Strong. A couple of nerves to revisit.";
  if (score >= n * 0.5) return "Solid start. The vignettes are where points go.";
  return "Lots to gain here. Try again with the layers panel.";
}

const FOCUS_BY_REGION = { hand: "hand", wrist: "hand", forearm: "forearm", elbow: "forearm", arm: "arm", shoulder: "shoulder",
  hip: "hip", thigh: "thigh", knee: "knee", leg: "leg", ankle: "ankle", foot: "foot" };

export function createEngine({ renderer, questions, sets, ui, track }) {
  // state: intro | asking | feedback | done
  const state = { state: "intro", index: 0, score: 0, seconds: 0, startedAt: 0, askedAt: 0, results: [] };
  let set = null;
  let current = [];
  let timer = null;

  const elapsed = () => (performance.now() - state.startedAt) / 1000;
  const setField = () => set.builtinId || set.id;
  const stats = () => ({
    number: Math.min(state.index + 1, current.length), total: current.length,
    score: state.score, seconds: elapsed(),
  });

  function showQuestion() {
    const q = current[state.index];
    renderer.clearHighlight();
    // `study` is for the volume renderer (it loads that scan on demand); the mesh renderer ignores it.
    renderer.show({ view: q.view, layers: q.layers, study: q.study, focus: q.focus || FOCUS_BY_REGION[q.tags?.region] || "all" });
    state.state = "asking";
    state.askedAt = performance.now();
    renderer.setPickEnabled(true);
    ui.showQuestion({ number: state.index + 1, total: current.length, kind: q.kind, prompt: q.prompt, hint: q.hint || "" });
    ui.updateStats(stats());
  }

  function finish() {
    clearInterval(timer);
    state.seconds = Math.round(elapsed());
    state.state = "done";
    renderer.setPickEnabled(false);
    renderer.clearHighlight();
    renderer.setDefaultLayers();
    ui.updateStats(stats());
    track("finish", { score: state.score, seconds: state.seconds, set: setField(), n: current.length });
    ui.showResults({
      score: state.score, total: current.length, seconds: state.seconds,
      verdictLine: verdictLine(state.score, current.length),
      review: state.results.map(({ q, clicked, correct }) => ({
        correct,
        text: correct
          ? `${renderer.name(q.accept[0])} ✓`
          : `${renderer.name(q.accept[0])} (you clicked ${renderer.name(clicked)})`,
      })),
    });
  }

  const engine = {
    state,
    get current() { return current; },
    get set() { return set; },
    sets,

    start(setId, replay = false) {
      const found = sets.find((s) => s.id === setId) || set || sets[0];
      set = found;
      if (!replay || !current.length) current = set.pick(questions, "");
      Object.assign(state, { state: "asking", index: 0, score: 0, seconds: 0, results: [], startedAt: performance.now() });
      clearInterval(timer);
      timer = setInterval(() => ui.updateStats(stats()), 250);
      track("start", { set: setField(), n: current.length });
      ui.started(current);
      showQuestion();
    },

    answer(id) {
      if (state.state !== "asking") return;
      const q = current[state.index];
      const correct = q.accept.includes(id);
      state.state = "feedback";
      renderer.setPickEnabled(false);
      if (correct) state.score += 1;
      state.results.push({ q, clicked: id, correct });
      track("answer", {
        q: state.index + 1, qid: q.id, correct, clicked: id,
        ms: Math.round(performance.now() - state.askedAt), set: setField(), n: current.length,
      });
      if (!correct) renderer.highlight(id, "bad");
      for (const s of q.accept) renderer.highlight(s, "good");
      ui.showFeedback({
        correct,
        verdict: correct
          ? `Correct: ${renderer.name(id)}.`
          : `Not quite. You clicked ${renderer.name(id)}; the answer (green) is ${renderer.name(q.accept[0])}.`,
        explain: q.explain,
        isLast: state.index + 1 >= current.length,
      });
      ui.updateStats(stats());
    },

    next() {
      if (state.state !== "feedback") return;
      state.index += 1;
      if (state.index < current.length) showQuestion();
      else finish();
    },

    // Back to the set chooser.
    intro() {
      clearInterval(timer);
      state.state = "intro";
      renderer.setPickEnabled(false);
      renderer.clearHighlight();
      renderer.setDefaultLayers();
      ui.showIntro();
    },

    shareUrl(base = globalThis.location.href) {
      const url = new URL(base);
      url.search = "";
      url.hash = "";
      url.searchParams.set("q", current.map((q) => q.id).join(","));
      url.searchParams.set("s", state.score);
      url.searchParams.set("t", state.seconds);
      if (set.builtinId || set.id !== "custom") url.searchParams.set("set", setField());
      return url.toString();
    },

    shareText() {
      const on = set.renderer === "mesh" ? `${set.title} in 3D` : `the ${set.title} set`;
      return `I scored ${state.score}/${current.length} on ${on}. Can you beat it?`;
    },
  };
  return engine;
}
