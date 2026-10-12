#!/usr/bin/env python3
"""Validate scan question banks against study manifests.
usage: python3 tools/check_questions.py assets/questions/*.json   (run from imaging/)"""
import json, os, re, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PLANES = {'axial', 'coronal', 'sagittal'}
_cache = {}
_us_views = None  # assets/ultrasound/views.json, loaded once; False when absent
_warned = set()
KV = re.compile(r'^[a-z]+=-?[0-9.]+(,[a-z]+=-?[0-9.]+)*$')
def study(sid):
    if sid not in _cache:
        p = os.path.join(ROOT, 'assets', 'volumes', str(sid), 'study.json')
        try:
            d = json.load(open(p))
            _cache[sid] = ({v['key'] for v in d['structures'].values()}, d.get('views', {}), set(d.get('windows', {})))
        except (OSError, ValueError, KeyError):
            _cache[sid] = None
    return _cache[sid]
def check_view(view, st, errs, qid):
    keys, views, windows = st  # window names are the study's own (CT: soft/lung/bone; MR studies name theirs)
    if not isinstance(view, str): errs.append(f'{qid}: view missing'); return
    if ':' not in view:
        if view not in views: errs.append(f'{qid}: named view {view!r} not in study views')
        return
    parts = view.split(':')
    if len(parts) not in (2, 3): errs.append(f'{qid}: bad inline view {view!r}'); return
    if parts[0] not in PLANES: errs.append(f'{qid}: bad plane in {view!r}')
    try:
        if not 0 <= float(parts[1]) <= 1: errs.append(f'{qid}: frac out of range in {view!r}')
    except ValueError: errs.append(f'{qid}: bad frac in {view!r}')
    if len(parts) == 3 and parts[2] not in windows: errs.append(f'{qid}: bad window in {view!r}')
def check_xray_view(view, errs, qid):
    # "ap" | "lateral", optionally followed by ":k=v,k=v" (zoom, cx, cy, ...)
    if not isinstance(view, str): errs.append(f'{qid}: view missing'); return
    base, _, params = view.partition(':')
    if base not in ('ap', 'lateral'): errs.append(f'{qid}: bad x-ray view {view!r}')
    elif ':' in view and not KV.match(params): errs.append(f'{qid}: bad x-ray view parameters in {view!r}')
def check_us_view(view, sid, errs, qid):
    # "us:..." is an inline probe pose; otherwise a name from assets/ultrasound/views.json for the study
    global _us_views
    if not isinstance(view, str): errs.append(f'{qid}: view missing'); return
    if view.startswith('us:'): return
    if _us_views is None:
        try: _us_views = json.load(open(os.path.join(ROOT, 'assets', 'ultrasound', 'views.json')))
        except (OSError, ValueError): _us_views = False
    if _us_views is False:
        if 'us' not in _warned: print('  warning: assets/ultrasound/views.json not found; skipping ultrasound view name checks'); _warned.add('us')
        return
    v = _us_views.get(str(sid), _us_views)
    names = set(v.get('views', v)) if isinstance(v, dict) else set()
    if view not in names: errs.append(f'{qid}: ultrasound view {view!r} not found for {sid}')
def main(paths):
    seen, total = {}, 0
    for path in paths:
        errs = []
        try: bank = json.load(open(path))
        except (OSError, ValueError) as e:
            print(f'{path}: ERROR cannot load ({e})'); total += 1; continue
        qs = bank.get('questions', [])
        for q in qs:
            qid = q.get('id', '?')
            if qid in seen: errs.append(f'{qid}: duplicate id (also in {seen[qid]})')
            seen[qid] = os.path.basename(path)
            if q.get('kind') not in ('Identify', 'Clinical'): errs.append(f'{qid}: bad kind {q.get("kind")!r}')
            rend = q.get('renderer')
            if rend not in ('volume', 'xray', 'ultrasound'): errs.append(f'{qid}: renderer {rend!r} not volume, xray or ultrasound')
            sid = q.get('study')
            st = study(sid) if sid else None
            if not st: errs.append(f'{qid}: study {sid!r} missing'); continue
            for k in [q.get('target')] + list(q.get('accept', [])):
                if k not in st[0]: errs.append(f'{qid}: key {k!r} not in {sid}')
            if q.get('target') not in q.get('accept', []): errs.append(f'{qid}: target not in accept')
            if rend == 'xray': check_xray_view(q.get('view'), errs, qid)
            elif rend == 'ultrasound': check_us_view(q.get('view'), sid, errs, qid)
            else: check_view(q.get('view'), st, errs, qid)
        if bank.get('study') and not study(bank['study']): errs.append(f'file-level study {bank["study"]!r} missing')
        n = lambda k: sum(1 for q in qs if q.get('kind') == k)
        print(f'{os.path.basename(path)}: {len(qs)} questions ({n("Identify")} Identify, {n("Clinical")} Clinical), {len(errs)} errors')
        for e in errs: print('  ' + e)
        total += len(errs)
    return 1 if total else 0
if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
