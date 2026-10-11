// Anonymous analytics. Each browser gets a random visitor id (no personal data);
// events go to CONFIG.eventsUrl as JSON via sendBeacon. See tools/serve.py.
import { CONFIG } from "./config.js";

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
