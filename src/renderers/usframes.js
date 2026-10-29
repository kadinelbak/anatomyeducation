// Real ultrasound frame-stack renderer (format: docs/live/frame-format.md). A 2D canvas shows the frame
// nearest to view.frac, scaled to fit, with a badge and optional label outlines. Same surface as xray.js.
try {
  if (typeof document !== "undefined" && !document.querySelector('link[href*="usframes.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("./usframes.css", import.meta.url).href;
    document.head.append(l);
  }
} catch { /* styling is cosmetic */ }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function inPoly(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export async function createUsFramesRenderer({ container, stacksBase = "assets/usframes/", initialStack, onPick } = {}) {
  const base = new URL(stacksBase.endsWith("/") ? stacksBase : stacksBase + "/", document.baseURI);
  const root = el("div", "usf-root");
  const canvas = el("canvas", "usf-canvas");
  const badge = el("div", "usf-badge");
  root.append(canvas, badge);
  container.append(root);
  const ctx = canvas.getContext("2d");

  let meta = null, studyId = null, idx = 0, showLabels = false, pickOn = false, hl = null, active = true;
  const imgs = new Map(); // `${id}/${i}` -> Promise<ImageBitmap|HTMLImageElement>
  let token = 0;

  const frameUrl = (id, i) => new URL(`${id}/frames/${String(i).padStart(3, "0")}.${meta.ext || "jpg"}`, base).href;
  function getImg(id, i) {
    const k = `${id}/${i}`;
    let p = imgs.get(k);
    if (!p) {
      p = new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("frame " + k)); im.src = frameUrl(id, i); });
      imgs.set(k, p);
    }
    return p;
  }

  async function loadStudy(id) {
    if (id === studyId && meta) return meta;
    const r = await fetch(new URL(`${id}/stack.json`, base));
    if (!r.ok) throw new Error(`usframes: no stack ${id}`);
    meta = await r.json();
    studyId = id; idx = 0; hl = null;
    badge.textContent = `Ultrasound · real · ${meta.title || id}`;
    return meta;
  }

  function fit() {
    const w = Math.max(1, container.clientWidth || root.clientWidth), h = Math.max(1, container.clientHeight || root.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const s = Math.min(w / meta.width, h / meta.height);
    return { w, h, dpr, s, ox: (w - meta.width * s) / 2, oy: (h - meta.height * s) / 2 };
  }

  async function draw() {
    if (!meta) return;
    const my = ++token, i = idx;
    const im = await getImg(studyId, i);
    if (my !== token) return;
    const f = fit();
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    ctx.fillStyle = "#05080c"; ctx.fillRect(0, 0, f.w, f.h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(im, f.ox, f.oy, meta.width * f.s, meta.height * f.s);
    const labs = meta.labels?.[i] || [];
    for (const L of labs) {
      const on = L.key === hl;
      if (!showLabels && !on) continue;
      ctx.beginPath();
      L.poly.forEach(([x, y], n) => { const px = f.ox + x * meta.width * f.s, py = f.oy + y * meta.height * f.s; n ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath();
      ctx.lineWidth = on ? 3 : 1.5;
      ctx.strokeStyle = on ? "#ffd24a" : "#4fb3ff";
      ctx.stroke();
    }
  }

  const hasLabels = (layers) => Array.isArray(layers) ? layers.includes("labels") : !!layers?.labels;

  canvas.addEventListener("click", (e) => {
    if (!pickOn || !meta) return;
    const rc = canvas.getBoundingClientRect(), f = fit();
    const x = (e.clientX - rc.left - f.ox) / (meta.width * f.s), y = (e.clientY - rc.top - f.oy) / (meta.height * f.s);
    const hit = (meta.labels?.[idx] || []).find((L) => inPoly(L.poly, x, y));
    if (hit) onPick?.(hit.key);
  });
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => active && draw()) : null;
  ro?.observe(container);

  if (initialStack) await loadStudy(initialStack);

  return {
    async show({ study, view, layers } = {}) {
      if (study) await loadStudy(study);
      if (!meta) return;
      if (layers !== undefined) showLabels = hasLabels(layers);
      const fr = view?.frac;
      if (Number.isFinite(Number(fr))) idx = clamp(Math.round(clamp(Number(fr), 0, 1) * (meta.frames - 1)), 0, meta.frames - 1);
      await draw();
    },
    loadStudy,
    get studyId() { return studyId; },
    get meta() { return meta; },
    highlight(key) { hl = key; draw(); },
    clearHighlight() { hl = null; draw(); },
    name(key) { for (const l of meta?.labels || []) for (const L of l) if (L.key === key) return L.name || key; return key; },
    setDefaultLayers() { showLabels = false; draw(); },
    setPickEnabled(on) { pickOn = !!on; },
    setActive(on) { active = !!on; if (on) draw(); },
    get debug() { return { root, canvas, get frameIndex() { return idx; }, get meta() { return meta; } }; },
  };
}
