#!/usr/bin/env python3
"""Milestone report. Usage: python3 tools/report.py [events.jsonl] [signups.jsonl]"""
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

HOUR_MS = 3600 * 1000
WEEK_MS = 7 * 24 * HOUR_MS
DATA = Path(__file__).resolve().parent.parent / "data"
DEFAULT_SET = "m1"


def load(path):
    rows = []
    p = Path(path)
    if not p.exists():
        print("(missing file: %s)" % path)
        return rows
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(o, dict):
            rows.append(o)
    return rows


def ts_ms(e):
    t = e.get("ts")
    if isinstance(t, (int, float)) and not isinstance(t, bool):
        return float(t)
    r = e.get("received")
    if isinstance(r, str):
        try:
            return datetime.fromisoformat(r.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            pass
    return None


def set_of(e):
    s = e.get("set")
    return s if isinstance(s, str) and s else DEFAULT_SET


def ratio(n, d):
    return n / d if d else None


def pct(x):
    return "n/a" if x is None else "%.1f%%" % (x * 100)


def verdict(x, bar):
    if x is None:
        return "n/a"
    return "GO" if x >= bar else "NO-GO"


def main():
    args = sys.argv[1:]
    ev_path = args[0] if len(args) > 0 else str(DATA / "events.jsonl")
    su_path = args[1] if len(args) > 1 else str(DATA / "signups.jsonl")
    events = load(ev_path)
    signups = load(su_path) if Path(su_path).exists() else []

    def vis(e):
        v = e.get("visitor")
        return v if isinstance(v, str) and v else None

    by_visitor = {}
    for e in events:
        v = vis(e)
        if v:
            by_visitor.setdefault(v, []).append(e)
    unique = set(by_visitor)

    def having(t):
        return {v for v, es in by_visitor.items() if any(e.get("type") == t for e in es)}

    starters = having("start")
    finishers = having("finish")
    share_clicks = sum(1 for e in events if e.get("type") == "share_click")
    share_arrivals = {v for v, es in by_visitor.items()
                      if any(e.get("type") == "visit" and e.get("via") == "share" for e in es)}

    returners = set()
    for v in finishers:
        times = [t for t in (ts_ms(e) for e in by_visitor[v]) if t is not None]
        if not times:
            continue
        first = min(times)
        for e in by_visitor[v]:
            t = ts_ms(e)
            if e.get("type") == "visit" and t is not None and HOUR_MS < t - first <= WEEK_MS:
                returners.add(v)
                break

    return_event_visitors = {vis(e) for e in events
                             if e.get("type") == "return_visit" and vis(e)}

    signup_visitors = {s.get("visitor") for s in signups if s.get("visitor")}
    signup_src = "signups file"
    if not signups:
        signup_visitors = having("signup")
        signup_src = "signup events"

    completion = ratio(len(finishers), len(starters))
    ros = ratio(len(returners) + len(share_arrivals), len(finishers))
    demand = ratio(len(signup_visitors), len(unique))

    print("Anatomy quiz milestone report")
    print("=" * 40)
    print("Unique visitors:     %d" % len(unique))
    print("Starters:            %d" % len(starters))
    print("Finishers:           %d" % len(finishers))
    print("Completion:          %s  (bar 33%%)  %s" % (pct(completion), verdict(completion, 0.33)))
    print("Share clicks:        %d" % share_clicks)
    print("Share-link arrivals: %d" % len(share_arrivals))
    print("Return visitors:     %d   Return visits (event): %d"
          % (len(returners), len(return_event_visitors)))
    print("Return or share:     %s  (bar 10%%)  %s" % (pct(ros), verdict(ros, 0.10)))
    print("Signups:             %d (%s)" % (len(signup_visitors), signup_src))
    print("Demand:              %s  (bar 5%%)  %s" % (pct(demand), verdict(demand, 0.05)))
    print()

    # Per set: starters, finishers and completion for each question set id.
    set_starters, set_finishers = {}, {}
    for e in events:
        v = vis(e)
        if not v:
            continue
        if e.get("type") == "start":
            set_starters.setdefault(set_of(e), set()).add(v)
        elif e.get("type") == "finish":
            set_finishers.setdefault(set_of(e), set()).add(v)
    set_ids = set(set_starters) | set(set_finishers)
    print("Per set")
    if not set_ids:
        print("  (no start or finish events)")
    else:
        ordered = sorted(set_ids, key=lambda s: (-len(set_starters.get(s, ())), s))
        w = max(len("Set"), max(len(s) for s in ordered))
        print("  %-*s  %8s  %9s  %11s  %s"
              % (w, "Set", "Starters", "Finishers", "Completion", "Bar 33%"))
        for s in ordered:
            st = len(set_starters.get(s, ()))
            fi = len(set_finishers.get(s, ()))
            c = ratio(fi, st)
            print("  %-*s  %8d  %9d  %11s  %s" % (w, s, st, fi, pct(c), verdict(c, 0.33)))
    print()

    print("Drop-off (distinct visitors answering question N)")
    per_q = {}
    for e in events:
        q, v = e.get("q"), vis(e)
        if e.get("type") == "answer" and v and isinstance(q, int) and not isinstance(q, bool):
            per_q.setdefault(q, set()).add(v)
    top = max([len(s) for s in per_q.values()] + [1])
    max_q = max(list(per_q) + [10])
    for q in range(1, max_q + 1):
        n = len(per_q.get(q, ()))
        print("  Q%-2d %4d %s" % (q, n, "#" * round(30 * n / top)))
    print()

    # Accuracy health: per question id, from answer events.
    acc = {}
    for e in events:
        qid = e.get("qid")
        if e.get("type") != "answer" or not isinstance(qid, str) or not qid:
            continue
        d = acc.setdefault(qid, {"n": 0, "graded": 0, "right": 0, "ms": []})
        d["n"] += 1
        c = e.get("correct")
        if isinstance(c, bool):
            d["graded"] += 1
            if c:
                d["right"] += 1
        m = e.get("ms")
        if isinstance(m, (int, float)) and not isinstance(m, bool):
            d["ms"].append(m)

    rows = []
    for qid, d in acc.items():
        right_pct = ratio(d["right"], d["graded"])
        broken = (d["n"] >= 20 and right_pct is not None
                  and (right_pct < 0.20 or right_pct > 0.90))
        med = statistics.median(d["ms"]) if d["ms"] else None
        rows.append((right_pct, qid, d["n"], med, broken))
    rows.sort(key=lambda r: (r[0] is None, r[0] or 0, r[1]))

    print("Accuracy health (flag: under 20% or over 90% correct, with at least 20 answers)")
    if not rows:
        print("  (no answer events with a qid)")
    else:
        w = max(len(r[1]) for r in rows)
        for right_pct, qid, n, med, broken in rows:
            print("  %-*s  answers %4d  correct %6s  median ms %7s%s"
                  % (w, qid, n, pct(right_pct),
                     "n/a" if med is None else "%.0f" % med,
                     " REWRITE" if broken else ""))
    if len(unique) < 200:
        print()
        print("WARNING: only %d unique visitors; too few visitors to read the numbers yet." % len(unique))


if __name__ == "__main__":
    main()
