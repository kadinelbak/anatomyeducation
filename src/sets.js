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

const isMesh = (q) => q.renderer !== "volume";
// Scan sets are titled by the modality the bank records carry in tags.modality ("CT", "MRI"); CT when absent.
const modalityOf = (qs) => qs.find((q) => q.tags?.modality)?.tags.modality || "CT";

export function buildSets(allQuestions) {
  const questions = allQuestions.filter(isMesh);
  const mk = (s) => ({ renderer: "mesh", ...s });
  const sets = [
    mk({ id: "daily", title: "Daily 10", pick: (qs) => shuffled(qs.filter(isMesh), utcDate()).slice(0, SIZE) }),
    mk({ id: "random", title: "Random 10", pick: (qs) => shuffled(qs.filter(isMesh), Math.random() + "" + Date.now()).slice(0, SIZE) }),
    mk({
      id: "kind:Clinical", title: "Clinical cases",
      pick: (qs) => shuffled(qs.filter((q) => isMesh(q) && q.kind === "Clinical"), Math.random() + "").slice(0, SIZE),
    }),
  ];
  const topics = [...new Set(questions.map((q) => q.tags?.topic).filter(Boolean))];
  for (const topic of topics) {
    sets.push(mk({
      id: `topic:${topic}`, title: TOPIC_LABELS[topic] || cap(topic),
      pick: (qs) => shuffled(qs.filter((q) => isMesh(q) && q.tags?.topic === topic), Math.random() + "").slice(0, SIZE),
    }));
  }
  // One CT set per volume study in the bank.
  const studies = [...new Set(allQuestions.filter((q) => q.renderer === "volume" && q.study).map((q) => q.study))];
  for (const study of studies) {
    const mine = allQuestions.filter((q) => q.renderer === "volume" && q.study === study);
    const mod = modalityOf(mine);
    const sameMod = studies.filter((s) => modalityOf(allQuestions.filter((q) => q.renderer === "volume" && q.study === s)) === mod);
    sets.push({
      id: `ct:${study}`, renderer: "volume", study, modality: mod,
      title: sameMod.length === 1 ? `${mod} scan` : `${mod}: ${cap(mine[0]?.tags?.region || study)}`,
      pick: (qs) => shuffled(qs.filter((q) => q.renderer === "volume" && q.study === study), Math.random() + "").slice(0, SIZE),
    });
  }
  // Sets with nothing to ask are hidden from the chooser.
  return sets.filter((s) => s.pick(allQuestions, "").length > 0);
}

// An explicit list of ids, used by share links. Mixed renderers are not supported:
// only questions that match the first question's renderer (and study) are kept.
export function explicitSet(ids, byId, title = "hand anatomy") {
  let list = ids.map((id) => byId.get(id)).filter(Boolean);
  const renderer = list[0]?.renderer || "mesh";
  const study = renderer === "volume" ? list[0].study : undefined;
  list = list.filter((q) => (q.renderer || "mesh") === renderer && (renderer !== "volume" || q.study === study));
  if (renderer === "volume" && title === "hand anatomy") title = `${modalityOf(list)} scan`;
  return list.length ? { id: "custom", title, renderer, study, pick: () => list } : null;
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
