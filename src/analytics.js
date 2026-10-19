// Anonymous analytics. Every event is counted by GoatCounter (the count.js tag in
// index.html; counts only, no visitor data). When CONFIG.eventsUrl is set, a JSON copy
// with a random visitor id (no personal data) also goes there via sendBeacon, which
// tools/serve.py writes to data/events.jsonl for tools/report.py.
import { CONFIG } from "./config.js";

// GoatCounter event name and title for an app event. Returns null for events the
// pageview already covers. Event names carry the one or two fields worth counting;
// GoatCounter keeps counts per name, not per event.
function goatEvent(type, f) {
  switch (type) {
    case "visit": return f.via && f.via !== "direct" ? [`visit-${f.via}`, `Visit via ${f.via}`] : null;
    case "answer": return [f.correct ? "answer-correct" : "answer-wrong", f.correct ? "Answer: correct" : "Answer: wrong"];
    case "finish": return [`finish-${f.score}of${f.n}`, `Quiz finished ${f.score}/${f.n}`];
    case "start": return ["start", "Quiz started"];
    case "quit": return ["quit", "Quiz quit"];
    case "share_click": return ["share-click", "Share your score"];
    case "signup_open": return ["signup-open", "Signup form opened"];
    case "signup": return ["signup", "Signup submitted"];
    case "return_visit": return ["return-visit", "Return visit"];
    case "quiz_fab": return ["quiz-fab", "Quiz me button"];
    default: return [type.replace(/_/g, "-"), type];
  }
}

const pending = [];
function goatCount(path, title) {
  const gc = window.goatcounter;
  if (gc && typeof gc.count === "function") {
    gc.count({ path, title, event: true });
    return;
  }
  // count.js is async and may not be in yet; flush once it has loaded.
  pending.push([path, title]);
  if (pending.length === 1) {
    const tag = document.querySelector("script[data-goatcounter]");
    const flush = () => { while (pending.length && window.goatcounter?.count) { const [p, t] = pending.shift(); window.goatcounter.count({ path: p, title: t, event: true }); } };
    if (tag) tag.addEventListener("load", flush, { once: true });
    const poll = setInterval(() => { flush(); if (!pending.length) clearInterval(poll); }, 500);
    setTimeout(() => clearInterval(poll), 30000);
  }
}

function randomId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stored(storage, key) {
  try {
    let v = storage.getItem(key);
    if (!v) {
      v = randomId();
      storage.setItem(key, v);
    }
    return v;
  } catch {
    return randomId();
  }
}

export const visitor = stored(window.localStorage, "hn3d_visitor");
const session = stored(window.sessionStorage, "hn3d_session");

export function track(type, fields = {}) {
  try {
    const ev = goatEvent(type, fields);
    if (ev) goatCount(ev[0], ev[1]);
  } catch {
    /* analytics must never break the page */
  }
  if (!CONFIG.eventsUrl) return;
  const event = { type, visitor, session, ts: Date.now(), ...fields };
  const body = JSON.stringify(event);
  try {
    if (!navigator.sendBeacon || !navigator.sendBeacon(CONFIG.eventsUrl, body)) {
      fetch(CONFIG.eventsUrl, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* analytics must never break the page */
  }
}

// Fires once per session when someone comes back between 1 hour and 7 days after their first visit.
export function checkReturnVisit() {
  try {
    const now = Date.now();
    const first = Number(window.localStorage.getItem("hn3d_first_visit"));
    if (!first) {
      window.localStorage.setItem("hn3d_first_visit", String(now));
      return;
    }
    const age = now - first;
    if (age > 3600e3 && age < 7 * 86400e3 && !window.sessionStorage.getItem("hn3d_return_sent")) {
      window.sessionStorage.setItem("hn3d_return_sent", "1");
      track("return_visit", { days: Math.round((age / 86400e3) * 10) / 10 });
    }
  } catch {
    /* storage can be blocked */
  }
}
