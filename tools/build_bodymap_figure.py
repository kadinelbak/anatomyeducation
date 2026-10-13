#!/usr/bin/env python3
"""Build assets/bodymap/figure.svg: the front-view body figure of the explore body map.

Source data
  - Outline: the whole-body skin mesh of BodyParts3D 3.0 (FMA7163 "skin"), (c) DBCLS,
    CC BY 4.0, from the GitHub mirror Kevin-Mattheus-Moerman/BodyParts3D (the same mirror the
    trunk model was built from; see /mnt/project-files/trunk/docs/PIPELINE.md). Fetch it with
        git clone --filter=blob:none --no-checkout https://github.com/Kevin-Mattheus-Moerman/BodyParts3D bp3d
        git -C bp3d checkout HEAD -- assets/BodyParts3D_data/stl/FMA7163.stl
  - Region boundaries and the faint rib cage / pelvis / clavicle hints: BodyParts3D 3.0 bone
    meshes (ribs, costal cartilages, sternum, clavicle, scapula, hip bones, sacrum, femur), CC BY 4.0,
    as kept in /mnt/project-files/trunk/source/bodyparts3d and lower-limb/source/bodyparts3d.
  All of these share one BodyParts3D frame (mm, x = patient left, y = posterior, z = up), so no
  alignment is needed. The app's GLB models (Open3DModel limbs, CC BY-SA 4.0; BodyParts3D trunk,
  CC BY 4.0; Z-Anatomy head and neck, CC BY-SA 4.0) are not used: they are in different frames and
  have no skin, and the BodyParts3D skin covers the whole body in one piece.

Method (numpy + Pillow only): orthographic anterior projection of the skin, rasterised at 1 px/mm;
cut lines from bone landmarks (jugular notch, acromioclavicular end of the clavicle, axilla,
costal margin, iliac crest, greater trochanter, crotch); flood fills split the silhouette into
zones; each zone's pixel boundary is traced, smoothed and simplified into an SVG path.
Zones carry class="zone" and data-region; the bone hints carry class="inert hint" and no colours.

Usage: python3 tools/build_bodymap_figure.py --stl-dir DIR [--stl-dir DIR ...] [--out assets/bodymap/figure.svg]
Each --stl-dir is searched for FMA<id>.stl files (the skin clone dir, the trunk and lower-limb
BodyParts3D source dirs). Add --debug PNG to write the label image.
"""
import argparse, os, sys
import numpy as np
from PIL import Image, ImageDraw

SKIN = "FMA7163"
RIBS_R = ["FMA7857", "FMA7882", "FMA7909", "FMA7957", "FMA8066", "FMA8175", "FMA8229", "FMA8283", "FMA8364", "FMA8445"]
RIBS_L = ["FMA7987", "FMA8012", "FMA8039", "FMA8148", "FMA8093", "FMA8202", "FMA8256", "FMA8310", "FMA8391", "FMA8472"]
CARTILAGE = ["BP24", "BP28"]
STERNUM = ["FMA7486", "FMA7487", "FMA7488"]  # manubrium, body, xiphoid
CLAVICLE_R, SCAPULA_R = "FMA13322", "FMA13395"
HIP = ["FMA16586", "FMA16587", "FMA16202"]  # right, left hip bone, sacrum
FEMUR_R = "FMA24474"

R = 1.0      # raster px per mm
PAD = 4      # raster padding, px
OUT_H = 400  # viewBox height


def load_stl(dirs, fid):
    for d in dirs:
        for name in (f"{fid}.stl", f"{fid}nsn.stl"):
            p = os.path.join(d, name)
            if os.path.exists(p):
                data = open(p, "rb").read()
                if data[:5] == b"solid" and b"facet" in data[:400]:
                    v = [list(map(float, l.split()[1:4])) for l in data.decode(errors="ignore").splitlines() if l.strip().startswith("vertex")]
                    return np.array(v, np.float32).reshape(-1, 3, 3)
                n = int(np.frombuffer(data, np.uint32, 1, 80)[0])
                rec = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
                return np.frombuffer(data, rec, n, 84)["v"].astype(np.float32)
    sys.exit(f"missing {fid}.stl in {dirs}")


class Frame:
    def __init__(self, skin):
        v = skin.reshape(-1, 3)
        self.x0, self.z1 = float(v[:, 0].min()), float(v[:, 2].max())
        self.W = int((v[:, 0].max() - self.x0) * R) + 2 * PAD + 1
        self.H = int((self.z1 - v[:, 2].min()) * R) + 2 * PAD + 1

    def px(self, x, z):
        return ((x - self.x0) * R + PAD, (self.z1 - z) * R + PAD)


def raster(frame, tris):
    im = Image.new("L", (frame.W, frame.H), 0)
    dr = ImageDraw.Draw(im)
    cx, cy = frame.px(tris[:, :, 0], tris[:, :, 2])
    for t in np.stack([cx, cy], -1).tolist():
        dr.polygon([tuple(p) for p in t], fill=255)
    return np.array(im) > 0


def fill_holes(mask):
    im = Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).copy()  # copy: floodfill on a fromarray view is lost
    ImageDraw.floodfill(im, (0, 0), 128)
    return np.array(im) != 128


def flood(mask, seed):
    """Connected (4-neighbour) part of mask containing seed (col, row)."""
    im = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8)).copy()  # copy: floodfill on a fromarray view is lost
    ImageDraw.floodfill(im, seed, 128, thresh=0)
    return np.array(im) == 128


def line_mask(shape, pts, width=3):
    im = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(im).line([tuple(map(float, p)) for p in pts], fill=255, width=width)
    return np.array(im) > 0


def trace(mask):
    """Closed boundary loops (pixel-corner coordinates) of a binary mask, fg on the left."""
    m = np.pad(mask, 1)
    edges = {}
    H, W = m.shape
    # horizontal cracks: between rows r-1 and r
    a, b = m[:-1, :], m[1:, :]
    for r, c in zip(*np.nonzero(a & ~b)):   # fg above, bg below: edge on row r+1 going left (fg on left when walking -x? choose consistent)
        edges.setdefault((c + 1, r + 1), []).append((c, r + 1))
    for r, c in zip(*np.nonzero(~a & b)):
        edges.setdefault((c, r + 1), []).append((c + 1, r + 1))
    a, b = m[:, :-1], m[:, 1:]
    for r, c in zip(*np.nonzero(a & ~b)):   # fg left, bg right
        edges.setdefault((c + 1, r), []).append((c + 1, r + 1))
    for r, c in zip(*np.nonzero(~a & b)):
        edges.setdefault((c + 1, r + 1), []).append((c + 1, r))
    loops = []
    while edges:
        start = next(iter(edges))
        loop, p, prev = [start], start, None
        while True:
            outs = edges.get(p)
            if not outs:
                break
            if len(outs) > 1 and prev is not None:  # saddle: turn consistently
                d = (p[0] - prev[0], p[1] - prev[1])
                outs.sort(key=lambda q: ((q[0] - p[0]) * d[1] - (q[1] - p[1]) * d[0]))
            q = outs.pop(0)
            if not outs:
                del edges[p]
            prev, p = p, q
            if p == start:
                break
            loop.append(p)
        if len(loop) > 8:
            loops.append(np.array(loop, float) - 1.0)  # undo padding
    return loops


def smooth(loop, win, iters):
    p = loop.copy()
    k = np.ones(win) / win
    for _ in range(iters):
        ext = np.concatenate([p[-win:], p, p[:win]])
        p = np.stack([np.convolve(ext[:, i], k, "same")[win:-win] for i in range(2)], -1)
    return p


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    d = b - a
    n = np.hypot(*d)
    dist = np.abs(d[0] * (pts[:, 1] - a[1]) - d[1] * (pts[:, 0] - a[0])) / n if n else np.hypot(*(pts - a).T)
    i = int(np.argmax(dist))
    if dist[i] > eps:
        return np.concatenate([rdp(pts[: i + 1], eps)[:-1], rdp(pts[i:], eps)])
    return np.array([a, b])


def closed_rdp(loop, eps):
    i = int(np.argmax(np.hypot(*(loop - loop[0]).T)))
    return np.concatenate([rdp(loop[: i + 1], eps)[:-1], rdp(np.concatenate([loop[i:], loop[:1]]), eps)[:-1]])


def path_d(loops, scale, ox, oy, min_area=0):
    out = []
    for lp in loops:
        q = (lp - [ox, oy]) * scale
        out.append("M" + " ".join(f"{x:.1f} {y:.1f}" for x, y in q) + "Z")
    return "".join(out).replace(" -", "-")


def area(lp):
    x, y = lp.T
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stl-dir", action="append", required=True)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "assets", "bodymap", "figure.svg"))
    ap.add_argument("--debug")
    a = ap.parse_args()
    dirs = a.stl_dir
    L = lambda fid: load_stl(dirs, fid)

    skin = L(SKIN)
    F = Frame(skin)
    body = fill_holes(raster(F, skin))
    H, W = body.shape
    rows = np.arange(H)

    sternum = np.concatenate([L(f) for f in STERNUM])
    xc = float(sternum[:, :, 0].mean())
    clav_r = L(CLAVICLE_R)
    notch_z = float(L("FMA7486")[:, :, 2].max())
    cage = np.concatenate([L(f) for f in RIBS_R + RIBS_L + CARTILAGE] + [sternum])
    hips = [L(f) for f in HIP]
    femur_r = L(FEMUR_R)
    crest_z = float(max(h[:, :, 2].max() for h in hips[:2]))
    troch_z = float(femur_r[:, :, 2].max())
    mirror = lambda t: np.concatenate([t, t * [-1, 1, 1] + [2 * xc, 0, 0]])

    cx, notch_r = F.px(xc, notch_z)
    cx = int(round(cx)); notch_r = int(round(notch_r))

    def run_at(r, c):
        """[left, right) of the foreground run on row r containing column c."""
        row = body[r]
        if not row[c]:
            return None
        l = c
        while l > 0 and row[l - 1]: l -= 1
        rr = c
        while rr < W - 1 and row[rr + 1]: rr += 1
        return l, rr + 1

    # Neck: narrowest central run between notch and chin; the neck cut leaves it where the run
    # has widened by 35 % on the way down (trapezius), then dips to the jugular notch.
    widths = {r: (lambda s: s[1] - s[0])(run_at(r, cx)) for r in range(notch_r - 220, notch_r)}
    neck_r = min(range(notch_r - 140, notch_r - 20), key=lambda r: widths[r])
    side_r = next(r for r in range(neck_r, notch_r) if widths[r] > widths[neck_r] * 1.35)
    nl, nr = run_at(side_r, cx)
    neck_cut = [(nl - 3, side_r), (cx, notch_r + 6), (nr + 2, side_r)]

    # Shoulders: the cut runs from the axilla up to the skin above the acromioclavicular joint.
    ac_x = float(clav_r[:, :, 0].min())  # lateral end of the right clavicle
    def axilla(sign):
        for r in range(notch_r, H):
            row = body[r]
            c = cx
            while 0 < c < W - 1 and row[c]: c += sign  # leave the trunk
            g = c
            while 0 < c < W - 1 and not row[c]: c += sign  # cross the gap
            if 0 < c < W - 1 and abs(c - cx) < abs(F.px(ac_x, 0)[0] - cx) * 1.4:
                return (g + c) / 2, r
        raise RuntimeError("no axilla")
    def top_at(c):
        c = int(round(c))
        return int(np.argmax(body[:, c]))
    shoulder_cuts = []
    for sign in (-1, 1):
        ax, ar = axilla(sign)
        tx = cx + sign * abs(F.px(ac_x, 0)[0] - cx) * 0.88
        tr = top_at(tx)
        # extend a little beyond both ends so the cut fully crosses the skin
        d = np.array([tx - ax, tr - ar]); d /= np.hypot(*d)
        shoulder_cuts.append([(ax - d[0] * 4, ar - d[1] * 4), (tx + d[0] * 8, tr + d[1] * 8)])

    # Groin: from the skin at the level of the greater trochanter to the crotch.
    crotch_r = next(r for r in range(int(F.px(0, crest_z)[1]), H) if not body[r, cx])
    troch_r = int(round(F.px(0, troch_z)[1]))
    tl, trr = run_at(troch_r, cx)
    groin_cuts = [[(tl - 6, troch_r - 2), (cx, crotch_r + 1)], [(trr + 5, troch_r - 2), (cx, crotch_r + 1)]]

    cut = line_mask(body.shape, neck_cut, 3)
    for c in shoulder_cuts + groin_cuts:
        cut |= line_mask(body.shape, c, 3)
    pieces = body & ~cut

    def seed_low(sign, frac):
        """A body pixel low on the given side (hand or foot)."""
        r = int(H * frac)
        cols = np.nonzero(body[r])[0]
        c = cols.min() if sign < 0 else cols.max()
        return (int(c - sign * 3), r)
    arms = flood(pieces, seed_low(-1, 0.52)) | flood(pieces, seed_low(1, 0.52))
    legs = flood(pieces, seed_low(-1, 0.97)) | flood(pieces, seed_low(1, 0.97))
    head = flood(pieces, (cx, int(body[:, cx].argmax()) + 20))
    trunk = flood(pieces, (cx, notch_r + 60))
    assert not (arms & legs).any() and not (arms & trunk).any() and not (head & trunk).any(), "a cut leaked"

    # Chest / abdomen: the lower edge of the projected rib cage (costal margin); abdomen / pelvis:
    # the iliac crests.
    cage_m = raster(F, cage)
    cage_cols = np.nonzero(cage_m.any(0))[0]
    low = np.full(W, -1.0)
    low[cage_cols] = [rows[cage_m[:, c]].max() for c in cage_cols]
    good = low >= 0
    low = np.interp(np.arange(W), np.nonzero(good)[0], low[good])
    # flatten outward from the midline so the flanks below the cage edge stay chest down to the margin
    c0 = int(cx)
    low[c0:] = np.maximum.accumulate(low[c0:]); low[:c0 + 1] = np.maximum.accumulate(low[:c0 + 1][::-1])[::-1]
    low = np.convolve(np.pad(low, 15, mode="edge"), np.ones(31) / 31, "valid")
    crest_r = F.px(0, crest_z)[1]
    trunk_lbl = np.where(rows[:, None] <= low[None, :], 1, np.where(rows[:, None] <= crest_r, 2, 3))

    lbl = np.zeros(body.shape, np.uint8)  # 0 bg, 1 chest, 2 abdomen, 3 pelvis, 4 head, 5 arm, 6 leg
    lbl[trunk] = trunk_lbl[trunk]
    lbl[head] = 4; lbl[arms] = 5; lbl[legs] = 6
    # give the cut-line pixels to the nearest labelled neighbour
    for _ in range(6):
        hole = body & (lbl == 0)
        if not hole.any(): break
        for dr, dc in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nb = np.roll(np.roll(lbl, dr, 0), dc, 1)
            take = hole & (nb > 0) & (lbl == 0)
            lbl[take] = nb[take]
    names = {1: "chest", 2: "abdomen", 3: "pelvis", 4: "head", 5: "upper-limb", 6: "lower-limb"}
    titles = {"chest": "Chest", "abdomen": "Abdomen", "pelvis": "Pelvis", "head": "Head and neck", "upper-limb": "Upper limb", "lower-limb": "Lower limb"}

    if a.debug:
        pal = np.array([[15, 20, 25], [200, 90, 90], [90, 200, 90], [90, 90, 200], [200, 200, 90], [90, 200, 200], [200, 90, 200]], np.uint8)
        dbg = pal[lbl]
        dbg[cage_m] = dbg[cage_m] // 2 + 100
        Image.fromarray(dbg).save(a.debug)

    # output transform
    ys, xs = np.nonzero(body)
    ox, oy = xs.min() - 1.5, ys.min() - 1.5
    scale = (OUT_H - 3) / (ys.max() - ys.min() + 1)
    vbw = (xs.max() - xs.min() + 1) * scale + 3
    eps = 0.18 / scale  # simplification tolerance: 0.18 viewBox units

    def shape_loops(mask, win=5, iters=2, min_area=30):
        loops = [lp for lp in trace(mask) if area(lp) >= min_area]
        return [closed_rdp(smooth(lp, win, iters), eps) for lp in loops]

    parts = []
    for k in (4, 1, 2, 3, 5, 6):
        n = names[k]
        d = path_d(shape_loops(lbl == k), scale, ox, oy)
        parts.append(f'<path class="zone" data-region="{n}" d="{d}"><title>{titles[n]}</title></path>')

    # Faint bone hints: rib cage and pelvis outlines (holes included), clavicles.
    hints = []
    pelvis_m = raster(F, np.concatenate(hips))
    clav_m = raster(F, mirror(clav_r))
    for m, mn in ((cage_m, 400), (pelvis_m, 150), (clav_m, 100)):
        d = path_d(shape_loops(m, 3, 2, mn), scale, ox, oy)
        hints.append(d)
    hint = f'<path class="inert hint" style="fill:none;pointer-events:none" d="{"".join(hints)}"/>'

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vbw:.0f} {OUT_H}" class="figure" role="group" aria-label="Body regions">\n'
           f'<!-- Generated by tools/build_bodymap_figure.py from BodyParts3D 3.0 (DBCLS, CC BY 4.0): skin FMA7163 and bone meshes. -->\n'
           + "\n".join(parts) + "\n" + hint + "\n</svg>\n")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    open(a.out, "w").write(svg)
    print(f"wrote {a.out}: {len(svg)/1024:.1f} KB, viewBox 0 0 {vbw:.0f} {OUT_H}")


if __name__ == "__main__":
    main()
