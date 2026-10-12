// Question sets: each is { id, title, pick(questions, seed) -> up to 10 questions }.
const SIZE = 10;

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, seed) {
  const rand = mulberry32(hashString(String(seed)));
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TOPIC_LABELS = {
  nerves: "Nerves", muscles: "Muscles", bones: "Bones", vessels: "Vessels",
  joints: "Joints", ligaments: "Ligaments", tendons: "Tendons",
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

const SCAN_RENDERERS = ["volume", "xray", "ultrasound"];
const isMesh = (q) => !SCAN_RENDERERS.includes(q.renderer);
// Scan sets are titled by the modality the bank records carry in tags.modality ("CT", "MRI"); CT when absent.
const modalityOf = (qs) => qs.find((q) => q.tags?.modality)?.tags.modality || "CT";

// `models` is CONFIG.models; each 3D model gets its own daily, random, clinical and topic sets,
// grouped under the model's title in the chooser. The first model keeps the original ids
// (daily, random, ...) so older share links still resolve; the others are prefixed "<model>:".
export function buildSets(allQuestions, models = { "upper-limb": { title: "Upper limb" } }) {
  const sets = [];
  const modelIds = Object.keys(models);
  for (const model of modelIds) {
    const mine = (q) => isMesh(q) && (q.model || modelIds[0]) === model;
    const questions = allQuestions.filter(mine);
    if (!questions.length) continue;
    const prefix = model === modelIds[0] ? "" : `${model}:`;
    const group = models[model].title || cap(model);
    const mk = (s) => ({ renderer: "mesh", model, group, ...s, id: prefix + s.id });
    sets.push(
      mk({ id: "daily", title: "Daily 10", pick: (qs) => shuffled(qs.filter(mine), utcDate() + prefix).slice(0, SIZE) }),
      mk({ id: "random", title: "Random 10", pick: (qs) => shuffled(qs.filter(mine), Math.random() + "" + Date.now()).slice(0, SIZE) }),
      mk({
        id: "kind:Clinical", title: "Clinical cases",
        pick: (qs) => shuffled(qs.filter((q) => mine(q) && q.kind === "Clinical"), Math.random() + "").slice(0, SIZE),
      }),
    );
    const topics = [...new Set(questions.map((q) => q.tags?.topic).filter(Boolean))];
    for (const topic of topics) {
      sets.push(mk({
        id: `topic:${topic}`, title: TOPIC_LABELS[topic] || cap(topic),
        pick: (qs) => shuffled(qs.filter((q) => mine(q) && q.tags?.topic === topic), Math.random() + "").slice(0, SIZE),
      }));
    }
  }
  // One scan set per modality and body region ("CT: Chest", "MRI: Pelvis"); a set may span several
  // studies, since the volume renderer loads each question's study on demand. `study` is the first
  // question's, so the page can fetch it while the student reads the intro.
  // X-ray and ultrasound questions get their own groups and ids ("xray:chest", "us:abdomen").
  const scanKey = (q) => {
    const region = q.tags?.region || q.study;
    if (q.renderer === "xray") return `xray:${region}`;
    if (q.renderer === "ultrasound") return `us:${region}`;
    return `${modalityOf([q]).toLowerCase()}:${region}`;
  };
  const GROUPS = { volume: "Scans", xray: "X-ray", ultrasound: "Ultrasound" };
  const scans = allQuestions.filter((q) => SCAN_RENDERERS.includes(q.renderer) && q.study);
  for (const key of [...new Set(scans.map(scanKey))]) {
    const mine = scans.filter((q) => scanKey(q) === key);
    const renderer = mine[0].renderer;
    const mod = renderer === "xray" ? "X-ray" : renderer === "ultrasound" ? "Ultrasound" : modalityOf(mine);
    sets.push({
      id: key, renderer, study: mine[0].study, modality: mod, group: GROUPS[renderer],
      title: `${mod}: ${cap(mine[0].tags?.region || mine[0].study)}`,
      pick: (qs) => shuffled(qs.filter((q) => scanKey(q) === key), Math.random() + "").slice(0, SIZE),
    });
  }
  // Sets with nothing to ask are hidden from the chooser.
  return sets.filter((s) => s.pick(allQuestions, "").length > 0);
}

// An explicit list of ids, used by share links. Mixed renderers are not supported:
// only questions that match the first question's renderer (and, for meshes, model) are kept;
// scan questions may come from any study.
export function explicitSet(ids, byId, title = "hand anatomy") {
  let list = ids.map((id) => byId.get(id)).filter(Boolean);
  const renderer = list[0]?.renderer || "mesh";
  const study = renderer !== "mesh" ? list[0]?.study : undefined;
  const model = renderer === "mesh" ? list[0]?.model : undefined;
  list = list.filter((q) => (q.renderer || "mesh") === renderer && (renderer !== "mesh" || q.model === model));
  if (renderer !== "mesh" && title === "hand anatomy") title = renderer === "xray" ? "X-ray set" : renderer === "ultrasound" ? "Ultrasound set" : `${modalityOf(list)} scan`;
  return list.length ? { id: "custom", title, renderer, study, model, pick: () => list } : null;
}

// ?q=id1,id2 wins over ?set=...; unknown or missing falls back to daily.
export function resolveSet(search, sets, byId) {
  const p = new URLSearchParams(search);
  if (p.get("q")) {
    const ex = explicitSet(p.get("q").split(",").map((s) => s.trim()).filter(Boolean), byId, titleFor(p.get("set"), sets));
    if (ex) return { ...ex, explicit: true, builtinId: sets.some((s) => s.id === p.get("set")) ? p.get("set") : null };
  }
  return sets.find((s) => s.id === p.get("set")) || sets.find((s) => s.id === "daily") || sets[0];
}

function titleFor(id, sets) {
  return sets.find((s) => s.id === id)?.title || "hand anatomy";
}
