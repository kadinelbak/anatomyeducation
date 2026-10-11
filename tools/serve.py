#!/usr/bin/env python3
"""Static server + tiny event/signup collector for the anatomy quiz.

Usage: python3 tools/serve.py [--port 8000] [--host 127.0.0.1]
"""
import argparse
import json
import re
import sys
import threading
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MAX_BODY = 16 * 1024
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LOCK = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_lines(name, objs):
    with LOCK:
        DATA.mkdir(exist_ok=True)
        with open(DATA / name, "a", encoding="utf-8") as f:
            for o in objs:
                f.write(json.dumps(o, separators=(",", ":"), ensure_ascii=False) + "\n")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def log_message(self, fmt, *args):
        if self.command == "GET":
            return  # quiet static logging
        super().log_message(fmt, *args)

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        if obj is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _read_json(self):
        """Return parsed JSON or raise ValueError with a message."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("bad content-length")
        if n <= 0:
            raise ValueError("empty body")
        if n > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("invalid JSON")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/event", "/api/signup"):
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            data = self._read_json()
            if path == "/api/event":
                return self._event(data)
            return self._signup(data)
        except ValueError as e:
            sys.stderr.write("API error %s: %s\n" % (path, e))
            return self._send(400, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa
            sys.stderr.write("API failure %s: %r\n" % (path, e))
            return self._send(500, {"ok": False, "error": "server error"})

    def _event(self, data):
        items = data if isinstance(data, list) else [data]
        if not items or len(items) > 100:
            raise ValueError("bad event list")
        out = []
        stamp = now_iso()
        for ev in items:
            if not isinstance(ev, dict):
                raise ValueError("event must be an object")
            t = ev.get("type")
            if not isinstance(t, str) or not t or len(t) > 32:
                raise ValueError("invalid type")
            ev = {k: v for k, v in ev.items() if k != "email"}
            ev["received"] = stamp
            out.append(ev)
        append_lines("events.jsonl", out)
        self.send_response(204)
        self.end_headers()

    def _signup(self, data):
        if not isinstance(data, dict):
            raise ValueError("body must be an object")
        email = data.get("email")
        if not isinstance(email, str) or len(email) > 254 or not EMAIL_RE.match(email.strip()):
            raise ValueError("invalid email")
        visitor = data.get("visitor")
        if visitor is not None and (not isinstance(visitor, str) or len(visitor) > 64):
            raise ValueError("invalid visitor")
        score = data.get("score")
        if score is not None and (isinstance(score, bool) or not isinstance(score, (int, float))):
            raise ValueError("invalid score")
        append_lines("signups.jsonl", [{
            "email": email.strip(), "visitor": visitor, "score": score, "received": now_iso(),
        }])
        self._send(200, {"ok": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    handler = partial(Handler, directory=str(ROOT))
    srv = ThreadingHTTPServer((a.host, a.port), handler)
    print("Serving %s on http://%s:%d" % (ROOT, a.host, a.port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
