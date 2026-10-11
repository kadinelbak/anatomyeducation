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
