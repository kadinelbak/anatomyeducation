// Body map for explore mode: the student clicks a region of a figure (or its name), then picks what
// to look at there: the 3D model, or a CT, MRI, X-ray or ultrasound study of that region.
//
// buildBodyMap(questions, models) -> [{ id, title, options: [{ id, label, renderer, model?, focus?, studies? }] }]
// Scan options come from the question banks: every study a bank asks about, grouped by region
// (tags.region) and modality; the study with most questions comes first. Model options are fixed:
// each limb model covers its own limb, and the lower-limb model's hip region doubles as the pelvis.

const REGIONS = [
  { id: "head", title: "Head", short: "Head" },
  { id: "upper-limb", title: "Upper limb", short: "Arm" },
  { id: "chest", title: "Chest", short: "Chest" },
  { id: "abdomen", title: "Abdomen", short: "Abdomen" },
  { id: "pelvis", title: "Pelvis", short: "Pelvis" },
  { id: "lower-limb", title: "Lower limb", short: "Leg" },
  { id: "tissue", title: "Tissues and cells", short: "Cells" }, // histology slides and 3D cells (no zone on the figure)
];

// Which 3D model (and zoom) shows each region, when the model is configured.
const MODEL_OPTIONS = {
  "upper-limb": [{ model: "upper-limb", focus: "all", label: "3D model" }],
  "lower-limb": [{ model: "lower-limb", focus: "all", label: "3D model" }],
  pelvis: [{ model: "lower-limb", focus: "hip", label: "3D: hip bones" }],
};

// Bank region tags that belong to a figure region under another name.
const ALIAS = { thorax: "chest", neck: "head",
  // Histology and cell questions are tagged by tissue; they all live under one body-map entry.
  "skeletal muscle": "tissue", bone: "tissue", nerve: "tissue", vessel: "tissue", "connective tissue": "tissue", generic: "tissue" };
const regionOfQuestion = (q) => { const r = q.tags?.region; return ALIAS[r] || r; };

const MODALITY = { volume: (q) => q.tags?.modality || "CT", xray: () => "X-ray", ultrasound: () => "Ultrasound", slide: () => "Histology", cell: () => "Cell" };
const ORDER = ["3D", "CT", "MRI", "X-ray", "Ultrasound", "Histology", "Cell"];

export function buildBodyMap(questions, models) {
  return REGIONS.map((r) => {
    const options = [];
    for (const m of MODEL_OPTIONS[r.id] || []) {
      if (!models[m.model]) continue;
      options.push({ id: `model:${m.model}:${m.focus}`, label: m.label, modality: "3D", renderer: "mesh", model: m.model, focus: m.focus });
    }
    // Scan studies of this region, per modality, most-asked study first.
    const byModality = new Map();
    const sequences = new Map(); // study -> MR weighting (T1, T2, PD), shown in the study picker
    for (const q of questions) {
      const mod = MODALITY[q.renderer];
      if (!mod || !q.study || regionOfQuestion(q) !== r.id) continue;
      const name = mod(q);
      if (!byModality.has(name)) byModality.set(name, { renderer: q.renderer, counts: new Map() });
      const c = byModality.get(name).counts;
      c.set(q.study, (c.get(q.study) || 0) + 1);
      if (q.tags?.sequence) sequences.set(q.study, q.tags.sequence);
    }
    for (const [name, { renderer, counts }] of byModality) {
      const studies = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      options.push({ id: `${renderer}:${r.id}:${name}`, label: name, modality: name, renderer, studies, sequences: Object.fromEntries(studies.map((id) => [id, sequences.get(id)])) });
    }
    options.sort((a, b) => ORDER.indexOf(a.modality) - ORDER.indexOf(b.modality));
    return { ...r, options };
  }).filter((r) => r.options.length);
}

// A short name for a study in the study picker ("s0513", "mr sample", "T1 · brain t1", "T2 · brain t2").
export function studyLabel(id, sequence) {
  const name = id.replace(/^ts-/, "").replace(/^msd-|^mni-/, "").replace(/-?example-sm$/, " sample").replace(/-/g, " ");
  return sequence ? `${sequence} · ${name}` : name;
}

// The figure: a front-facing outline whose zones carry data-region. Zones with nothing to show are
// drawn but inert (greyed). Returns the <svg> element.
export function buildFigure(regions) {
  const has = new Set(regions.map((r) => r.id));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 120 250");
  svg.setAttribute("class", "figure");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Body regions");
  const zone = (region, shapes, title) => {
    const g = document.createElementNS(ns, "g");
    if (region) {
      g.dataset.region = region;
      g.classList.add("zone");
      if (has.has(region)) { g.setAttribute("tabindex", "0"); g.setAttribute("role", "button"); g.setAttribute("aria-label", title); }
      else g.classList.add("inert");
    } else g.classList.add("inert");
    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      g.append(el);
    }
    if (title) { const t = document.createElementNS(ns, "title"); t.textContent = title; g.prepend(t); }
    svg.append(g);
  };
  zone("head", [["circle", { cx: 60, cy: 18, r: 14 }], ["rect", { x: 54, y: 31, width: 12, height: 10, rx: 3 }]], "Head");
  zone("chest", [["path", { d: "M34 42 h52 a6 6 0 0 1 6 6 v38 h-64 v-38 a6 6 0 0 1 6 -6 z" }]], "Chest");
  zone("abdomen", [["rect", { x: 30, y: 88, width: 60, height: 36 }]], "Abdomen");
  zone("pelvis", [["path", { d: "M30 126 h60 v22 a8 8 0 0 1 -8 8 h-44 a8 8 0 0 1 -8 -8 z" }]], "Pelvis");
  zone("upper-limb", [
    ["path", { d: "M26 44 a7 7 0 0 1 7 7 l-4 54 l-6 34 a6 6 0 0 1 -12 -2 l6 -34 l2 -52 a7 7 0 0 1 7 -7 z" }],
    ["path", { d: "M94 44 a7 7 0 0 0 -7 7 l4 54 l6 34 a6 6 0 0 0 12 -2 l-6 -34 l-2 -52 a7 7 0 0 0 -7 -7 z" }],
  ], "Upper limb");
  zone("lower-limb", [
    ["path", { d: "M33 158 h24 l-2 50 l-2 36 a7 7 0 0 1 -14 0 l-2 -36 z" }],
    ["path", { d: "M63 158 h24 l-4 50 l-2 36 a7 7 0 0 1 -14 0 l-2 -36 z" }],
  ], "Lower limb");
  return svg;
}
