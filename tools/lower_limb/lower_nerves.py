"""Schematic nerves and vessels for the right lower limb.

BodyParts3D 3.0 has no lower-limb nerves and no arteries below the iliacs, so
this module draws them as tubes, the way anatomy-app/tools/nerves.py does for
the forearm. Here the control points are not typed in by hand: they are
derived in code from landmarks of this model's bones (anterior superior iliac
spine, pubic tubercle, ischial tuberosity, greater trochanter, condyles,
fibular neck, malleoli, calcaneus, metatarsals) and from cross-sections and
surfaces of its muscles, then any sample that would sit inside or touch a bone
is pushed clear of it. Frame: BodyParts3D mm; x = patient left (the right limb
is at x < 0, lateral = more negative x), y = posterior (anterior = more
negative y), z = up. The tubes show routes, not exact diameters or branching,
and need a clinician's review (COURSES_MD).

Run `python3 tools/lower_nerves.py` to build the paths against the source STLs
and print a validation table (bone clearance, distance from the muscles).
"""
import numpy as np
import trimesh
from trimesh.intersections import mesh_plane


BONES = ["hip_bone", "sacrum", "femur", "patella", "tibia", "fibula", "talus", "calcaneus", "navicular",
         "medial_cuneiform", "intermediate_cuneiform", "lateral_cuneiform", "cuboid",
         "metatarsal_1", "metatarsal_2", "metatarsal_3", "metatarsal_4", "metatarsal_5",
         "phalanges_hallux", "phalanges_toe_2", "phalanges_toe_3", "phalanges_toe_4", "phalanges_toe_5"]
FOOT_BONES = BONES[6:]
THIGH_MUSCLES = ["sartorius", "rectus_femoris", "vastus_lateralis", "vastus_medialis", "vastus_intermedius",
                 "adductor_longus", "adductor_brevis", "adductor_magnus", "gracilis", "pectineus",
                 "biceps_femoris", "semitendinosus", "semimembranosus", "tensor_fasciae_latae"]
LEG_MUSCLES = ["tibialis_anterior", "extensor_hallucis_longus", "extensor_digitorum_longus", "fibularis_tertius",
               "fibularis_longus", "fibularis_brevis", "gastrocnemius", "soleus", "plantaris", "popliteus",
               "tibialis_posterior", "flexor_digitorum_longus", "flexor_hallucis_longus", "calcaneal_tendon"]
FOOT_MUSCLES = ["extensor_digitorum_brevis", "extensor_hallucis_brevis", "abductor_hallucis",
                "flexor_digitorum_brevis", "abductor_digiti_minimi_foot", "flexor_digiti_minimi_brevis_foot",
                "flexor_hallucis_brevis", "adductor_hallucis", "lumbricals_foot", "plantar_interossei_foot",
                "dorsal_interossei_foot", "extensor_digitorum_longus", "extensor_hallucis_longus"]

MED, LAT, ANT, POST = (1.0, 0.0), (-1.0, 0.0), (0.0, -1.0), (0.0, 1.0)


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _lerp(p, q, t):
    return np.asarray(p, float) + (np.asarray(q, float) - np.asarray(p, float)) * t


def _off(p, dx=0.0, dy=0.0, dz=0.0):
    return np.asarray(p, float) + np.array([dx, dy, dz])


# ---------------------------------------------------------------- geometry (numpy only: no scipy/rtree)

def _ray_hits(tris, axis, p):
    """Coordinates along `axis` where the axis-parallel line through p crosses the triangles."""
    a, b = [i for i in range(3) if i != axis]
    q = np.array([p[a], p[b]], float)
    t2 = tris[:, :, [a, b]]
    sel = np.all((t2.min(1) <= q) & (t2.max(1) >= q), axis=1)
    t = tris[sel]
    if not len(t):
        return np.empty(0)
    v0, v1, v2 = t[:, 0], t[:, 1], t[:, 2]
    d1, d2, dq = v1[:, [a, b]] - v0[:, [a, b]], v2[:, [a, b]] - v0[:, [a, b]], q - v0[:, [a, b]]
    den = d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = (dq[:, 0] * d2[:, 1] - dq[:, 1] * d2[:, 0]) / den
        w = (d1[:, 0] * dq[:, 1] - d1[:, 1] * dq[:, 0]) / den
    ok = (np.abs(den) > 1e-12) & (u >= 0) & (w >= 0) & (u + w <= 1)
    c = v0[:, axis] + u * (v1[:, axis] - v0[:, axis]) + w * (v2[:, axis] - v0[:, axis])
    return np.sort(c[ok])


def _closest_on_tris(p, tris):
    """Closest point on each triangle to points p: p (P,3), tris (T,3,3) -> (P,T,3). Ericson's method."""
    a, b, c = tris[None, :, 0], tris[None, :, 1], tris[None, :, 2]
    p = p[:, None, :]
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(-1), (ac * ap).sum(-1)
    bp = p - b
    d3, d4 = (ab * bp).sum(-1), (ac * bp).sum(-1)
    cp = p - c
    d5, d6 = (ab * cp).sum(-1), (ac * cp).sum(-1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    with np.errstate(divide="ignore", invalid="ignore"):
        denom = 1.0 / (va + vb + vc)
        v = vb * denom
        w = vc * denom
        res = a + ab * v[..., None] + ac * w[..., None]
        # edge regions
        t_ab = d1 / (d1 - d3)
        e_ab = a + ab * t_ab[..., None]
        t_ac = d2 / (d2 - d6)
        e_ac = a + ac * t_ac[..., None]
        t_bc = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        e_bc = b + (c - b) * t_bc[..., None]
    m = ((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[..., None]
    res = np.where(m, e_bc, res)
    m = ((vb <= 0) & (d2 >= 0) & (d6 <= 0))[..., None]
    res = np.where(m, e_ac, res)
    m = ((vc <= 0) & (d1 >= 0) & (d3 <= 0))[..., None]
    res = np.where(m, e_ab, res)
    m = ((d6 >= 0) & (d5 <= d6))[..., None]
    res = np.where(m, np.broadcast_to(c, res.shape), res)
    m = ((d3 >= 0) & (d4 <= d3))[..., None]
    res = np.where(m, np.broadcast_to(b, res.shape), res)
    m = ((d1 <= 0) & (d2 <= 0))[..., None]
    res = np.where(m, np.broadcast_to(a, res.shape), res)
    return res


def _winding(p, tris):
    """Generalised winding number of points p (P,3) w.r.t. a triangle soup (T,3,3)."""
    out = np.zeros(len(p))
    for i in range(0, len(p), 16):
        q = p[i:i + 16, None, None, :]
        r = tris[None] - q                       # (P,T,3,3)
        la = np.linalg.norm(r, axis=-1)          # (P,T,3)
        a, b, c = r[..., 0, :], r[..., 1, :], r[..., 2, :]
        num = (a * np.cross(b, c)).sum(-1)
        den = (la[..., 0] * la[..., 1] * la[..., 2] + (a * b).sum(-1) * la[..., 2]
               + (a * c).sum(-1) * la[..., 1] + (b * c).sum(-1) * la[..., 0])
        out[i:i + 16] = (2 * np.arctan2(num, den)).sum(-1) / (4 * np.pi)
    return out


class _Solid:
    """A bone for clearance queries (numpy only; per-point search with a vertex-distance bound)."""

    def __init__(self, mesh):
        self.tris = np.asarray(mesh.vertices[mesh.faces], float)
        self.normals = np.asarray(mesh.face_normals, float)
        self.verts = np.asarray(mesh.vertices, float)
        self.tlo, self.thi = self.tris.min(1), self.tris.max(1)
        self.lo, self.hi = mesh.bounds[0], mesh.bounds[1]

    def near(self, p, margin):
        return np.all((p > self.lo - margin) & (p < self.hi + margin), axis=1)

    def _one(self, q):
        # bound: distance to the nearest vertex; only faces whose box is within it can be closer
        bound = np.sqrt(((self.verts - q) ** 2).sum(1).min()) + 1e-6
        cand = np.nonzero(np.all((self.tlo - bound <= q) & (self.thi + bound >= q), axis=1))[0]
        cp = _closest_on_tris(q[None], self.tris[cand])[0]
        d = np.linalg.norm(cp - q, axis=1)
        k = np.argmin(d)
        # inside if an upward ray crosses the surface an odd number of times, or if the nearest
        # face is seen from behind (covers points inside a marrow core inside the bone)
        hits = _ray_hits(self.tris, 2, q)
        inside = (np.sum(hits > q[2]) % 2 == 1) or np.dot(q - cp[k], self.normals[cand[k]]) < -1e-9
        if inside:
            facing = ((cp - q) * self.normals[cand]).sum(1) > 0
            if facing.any():
                k = np.nonzero(facing)[0][np.argmin(d[facing])]
            v = cp[k] - q
        else:
            v = q - cp[k]
        n = np.linalg.norm(v)
        u = v / n if n > 1e-6 else self.normals[cand[k]]
        return (-d[k] if inside else d[k]), u, cp[k]

    def signed(self, p):
        """(signed distance, unit direction out of the bone, closest point) for points p."""
        p = np.asarray(p, float)
        res = [self._one(q) for q in p]
        return (np.array([r[0] for r in res]), np.array([r[1] for r in res]).reshape(-1, 3),
                np.array([r[2] for r in res]).reshape(-1, 3))


class _Model:
    """Section, surface and landmark queries on the parts in BodyParts3D space."""

    def __init__(self, by_structure):
        self.bs = by_structure
        self._tris = {}
        self._sec = {}
        self.L = {}
        self._landmarks()

    def tris(self, key):
        if key not in self._tris:
            m = self.bs[key]
            self._tris[key] = np.asarray(m.vertices[m.faces], float)
        return self._tris[key]

    def verts(self, key):
        return np.asarray(self.bs[key].vertices, float)

    # sections ---------------------------------------------------------
    def sec(self, key, z):
        k = (key, round(float(z), 2))
        if k not in self._sec:
            m = self.bs.get(key)
            pts = np.empty((0, 2))
            if m is not None and m.bounds[0, 2] < z < m.bounds[1, 2]:
                s = mesh_plane(m, [0, 0, 1], [0, 0, z])
                if len(s):
                    pts = s.reshape(-1, 3)[:, :2]
            self._sec[k] = pts
        return self._sec[k]

    def secs(self, keys, z):
        keys = [keys] if isinstance(keys, str) else keys
        return np.vstack([self.sec(k, z) for k in keys])

    def c(self, keys, z):
        s = self.secs(keys, z)
        if not len(s):
            raise ValueError(f"no section of {keys} at z={z}")
        return np.array([*s.mean(0), z])

    def ext(self, keys, z, d, gap=0.0):
        """Extreme point of the section in 2D direction d, moved `gap` mm further along d."""
        s = self.secs(keys, z)
        d = _unit(d)
        q = s[np.argmax(s @ d)] + gap * d
        return np.array([q[0], q[1], z])

    def between(self, a, b, z, t=0.5, near=None, tol=2.5):
        """Point between the closest edges of two sections (an intermuscular plane). Where the two
        are in contact along a long interface, `near` picks the part of it closest to that point."""
        sa, sb = self.secs(a, z), self.secs(b, z)
        d = np.sqrt(((sa[:, None] - sb[None]) ** 2).sum(-1))
        if near is None:
            i, j = np.unravel_index(np.argmin(d), d.shape)
        else:
            ii, jj = np.nonzero(d < d.min() + tol)
            mid = 0.5 * (sa[ii] + sb[jj])
            k = np.argmin(np.linalg.norm(mid - np.asarray(near, float)[:2], axis=1))
            i, j = ii[k], jj[k]
        q = sa[i] + (sb[j] - sa[i]) * t
        return np.array([q[0], q[1], z])

    def gap_x(self, key, z, lo, hi):
        """Centre of the widest gap in x of a section between x=lo and x=hi (e.g. between two heads)."""
        xs = np.sort(self.sec(key, z)[:, 0])
        xs = xs[(xs > lo) & (xs < hi)]
        if len(xs) < 2:
            return 0.5 * (lo + hi)
        k = np.argmax(np.diff(xs))
        return 0.5 * (xs[k] + xs[k + 1])

    # surfaces ---------------------------------------------------------
    def surf(self, keys, p, axis, sign, gap=0.0, default=None):
        """Outermost crossing of the line through p along axis ('x','y','z'), on the `sign` side,
        moved `gap` mm beyond it. E.g. surf('sartorius', p, 'y', -1) = anterior surface."""
        keys = [keys] if isinstance(keys, str) else keys
        ax = "xyz".index(axis)
        hits = np.concatenate([_ray_hits(self.tris(k), ax, p) for k in keys if k in self.bs])
        q = np.array(p, float)
        if not len(hits):
            if default is None:
                raise ValueError(f"no surface of {keys} along {axis} at {np.round(p)}")
            q[ax] = default
            return q
        q[ax] = (hits.max() + gap) if sign > 0 else (hits.min() - gap)
        return q

    def hits(self, keys, p, axis):
        keys = [keys] if isinstance(keys, str) else keys
        ax = "xyz".index(axis)
        return np.sort(np.concatenate([_ray_hits(self.tris(k), ax, p) for k in keys if k in self.bs]))

    def outer(self, keys, z, d, gap=2.0, cone=12.0, center=None):
        """Point on the outside of a group of sections at level z, in 2D direction d from their centre."""
        s = self.secs(keys, z)
        cen = s.mean(0) if center is None else np.asarray(center, float)[:2]
        d = _unit(d)
        r = s - cen
        n = np.linalg.norm(r, axis=1)
        cosang = (r @ d) / np.maximum(n, 1e-9)
        ok = cosang > np.cos(np.radians(cone))
        if not ok.any():
            ok = cosang > 0
        k = np.argmax(np.where(ok, r @ d, -np.inf))
        q = s[k] + gap * d
        return np.array([q[0], q[1], z])

    # landmarks --------------------------------------------------------
    def _landmarks(self):
        L = self.L
        hb, fe, ti, fi = self.verts("hip_bone"), self.verts("femur"), self.verts("tibia"), self.verts("fibula")

        def pick(v, mask, key):
            w = v[mask]
            return w[np.argmin(key(w))]

        hz = hb[:, 2]
        top, bot = hz.max(), hz.min()
        # anterior superior iliac spine: most anterior point of the upper (iliac) third
        L["asis"] = pick(hb, hz > top - 0.35 * (top - bot), lambda w: w[:, 1])
        # pubic symphysis: most medial point of the hip bone; pubic tubercle: most anterior point
        # of the medial fifth of the bone, below the ASIS
        xmin, xmax = hb[:, 0].min(), hb[:, 0].max()
        L["symphysis"] = pick(hb, hz < L["asis"][2] - 40, lambda w: -w[:, 0])
        L["pubic_tubercle"] = pick(hb, (hb[:, 0] > xmax - 0.15 * (xmax - xmin)) & (hz < L["asis"][2] - 40),
                                   lambda w: w[:, 1])
        L["ischial_tuberosity"] = pick(hb, hz < bot + 40, lambda w: w[:, 2] - 0.05 * w[:, 1])
        fz = fe[:, 2]
        ftop, fbot = fz.max(), fz.min()
        L["greater_trochanter"] = pick(fe, fz > ftop - 0.15 * (ftop - fbot), lambda w: w[:, 0])
        h = fe[(fz > ftop - 0.12 * (ftop - fbot)) & (fe[:, 0] > L["greater_trochanter"][0] + 45)]
        A = np.c_[2 * h, np.ones(len(h))]
        sol = np.linalg.lstsq(A, (h ** 2).sum(1), rcond=None)[0]
        L["femoral_head"] = sol[:3]
        low = fz < fbot + 0.1 * (ftop - fbot)
        L["medial_condyle"] = pick(fe, low, lambda w: -w[:, 0])
        L["lateral_condyle"] = pick(fe, low, lambda w: w[:, 0])
        mc = L["medial_condyle"]
        L["adductor_tubercle"] = pick(fe, (fz > mc[2] + 12) & (fz < mc[2] + 45), lambda w: -w[:, 0])
        L["knee_joint_z"] = 0.5 * (fbot + ti[:, 2].max())
        pa = self.verts("patella")
        L["patella_medial"] = pick(pa, pa[:, 2] > -1e9, lambda w: -w[:, 0])
        fz2 = fi[:, 2]
        L["fibular_head"] = fi[np.argmax(fz2)]
        neck_z = fz2.max() - 25
        L["fibular_neck"] = self.c("fibula", neck_z)
        tz = ti[:, 2]
        L["medial_malleolus"] = pick(ti, tz < tz.min() + 30, lambda w: -w[:, 0])
        L["lateral_malleolus"] = pick(fi, fz2 < fz2.min() + 25, lambda w: w[:, 0])
        L["ankle_z"] = tz.min()
        ca = self.verts("calcaneus")
        L["heel"] = ca[np.argmax(ca[:, 1])]
        for i in range(1, 6):
            v = self.verts(f"metatarsal_{i}")
            L[f"mt{i}_head"] = v[np.argmin(v[:, 1])]
            L[f"mt{i}_base"] = v[np.argmax(v[:, 1])]
        # end of the external iliac artery mesh (the femoral artery continues it)
        ea = self.verts("external_iliac_artery")
        L["eia_end"] = ea[ea[:, 2] < ea[:, 2].min() + 4].mean(0)
        L["obturator_canal"] = self._obturator_canal()
        # inguinal ligament: point along it 15 mm medial to the ASIS
        L["inguinal_lateral"] = self._ligament_at(L["asis"][0] + 15)
        L["mid_inguinal"] = _lerp(L["asis"], L["symphysis"], 0.5)

    def _ligament_at(self, x):
        v = self.verts("inguinal_ligament")
        sel = np.abs(v[:, 0] - x) < 3
        return np.array([x, *v[sel].mean(0)[1:]])

    def _obturator_canal(self):
        """Upper (anterosuperior) part of the obturator foramen: the hole in the hip bone
        below the acetabulum, found by casting medio-lateral rays on a y-z grid."""
        tris = self.tris("hip_bone")
        it = self.L["ischial_tuberosity"]
        ys = np.arange(self.L["pubic_tubercle"][1], it[1], 3.0)
        zs = np.arange(it[2] + 5, self.L["femoral_head"][2] + 5, 3.0)
        full = np.array([[len(_ray_hits(tris, 0, (0.0, y, z))) > 0 for y in ys] for z in zs])
        # enclosed cells: empty, with bone in front, behind, above and below (excludes open space)
        cum = lambda a, ax: np.maximum.accumulate(a, axis=ax)
        enclosed = (~full & cum(full, 1) & cum(full[:, ::-1], 1)[:, ::-1]
                    & cum(full, 0) & cum(full[::-1], 0)[::-1])
        zi, yi = np.nonzero(enclosed)
        hz, hy = zs[zi], ys[yi]
        z = hz.max()
        row = hy[hz > z - 7]
        y = row.min() + 0.3 * (row.max() - row.min())
        # x: middle of the bone around the upper rim
        v = self.verts("hip_bone")
        rim = v[(np.abs(v[:, 1] - y) < 8) & (np.abs(v[:, 2] - z - 5) < 8)]
        return np.array([rim[:, 0].mean(), y, z - 2])


# ---------------------------------------------------------------- courses

def _paths(M):
    """name -> (structure, layer, radius mm, control points proximal to distal)."""
    L = M.L
    P = {}
    kz = L["knee_joint_z"]
    mc, lc = L["medial_condyle"], L["lateral_condyle"]
    mid_x = 0.5 * (mc[0] + lc[0])                       # intercondylar line

    # ---- femoral artery: external iliac end -> femoral triangle -> adductor canal -> hiatus
    eia = L["eia_end"]
    fa = [eia,
          M.surf("pectineus", (eia[0] - 2, 0, eia[2] - 30), "y", -1, gap=4.0)]
    z_hiatus = L["adductor_tubercle"][2] + 45
    zt = np.linspace(eia[2] - 65, z_hiatus + 60, 6)
    for z in zt[:2]:                                       # femoral triangle, on pectineus / adductor longus
        fa.append(M.between("sartorius", "adductor_longus", z, t=0.55))
    for z in zt[2:]:                                       # adductor canal: VM / adductors, under sartorius
        fa.append(M.between("vastus_medialis", ["adductor_longus", "adductor_magnus"], z,
                            near=M.c("sartorius", z)))
    # adductor hiatus: just posteromedial to the femur
    hiatus = M.ext("femur", z_hiatus, (0.6, 0.8), gap=5.0)
    fa.append(hiatus)
    P["femoral_artery"] = ("femoral_artery", "vessel", 3.5, fa)

    # ---- popliteal artery: hiatus -> back of femur (deepest) -> lower border of popliteus
    pop = [hiatus]
    for z, x in ((z_hiatus - 25, _lerp(hiatus, (mid_x,), 0.6)[0]), (kz + 30, mid_x), (kz + 5, mid_x)):
        pop.append(M.surf(["femur", "tibia", "popliteus"], (x, 0, z), "y", +1, gap=4.5, default=pop[-1][1]))
    z_bif = kz - 50
    pop.append(M.surf(["popliteus", "tibia"], (mid_x - 2, 0, kz - 25), "y", +1, gap=3.0))
    bif = M.surf(["tibialis_posterior", "tibia", "popliteus"], (mid_x - 5, 0, z_bif), "y", +1, gap=3.5)
    pop.append(bif)
    P["popliteal_artery"] = ("popliteal_artery", "vessel", 3.2, pop)

    # ---- femoral vein: medial to the artery at the groin, posterior to it in the canal
    fv_off = [(9, 0), (9, 1), (7, 4), (4, 7), (2, 8), (1, 8), (1, 8), (1, 8), (1, 8)]
    fv = [_off(p, dx, dy) for p, (dx, dy) in zip(fa, fv_off)]
    P["femoral_vein"] = ("femoral_vein", "vessel", 3.8, fv)

    # ---- deep femoral artery: ~4 cm below the inguinal ligament, posterolateral then deep,
    #      posterior to adductor longus close to the femur
    pf0 = _lerp(fa[0], fa[1], 0.85)
    pf = [pf0, _off(pf0, -9, 9, -12)]
    for z in zt[1:4]:
        pf.append(M.between(["adductor_longus"], ["adductor_brevis", "adductor_magnus"], z,
                            near=M.ext("femur", z, MED)))
    pf.append(M.ext("femur", zt[4], (0.7, 0.7), gap=6.0))
    P["deep_femoral_artery"] = ("deep_femoral_artery", "vessel", 2.5, pf)

    # ---- femoral nerve: groove between psoas and iliacus -> under the ligament lateral to the
    #      artery -> femoral triangle, branches
    zg = L["asis"][2] - 25
    groove = M.between("psoas_major", "iliacus", zg)
    groove = M.surf(["psoas_major", "iliacus"], groove, "y", -1, gap=-2.0)
    fn_lig = _off(eia, -13, 4, 12)
    fn_lig = np.array([fn_lig[0], M._ligament_at(fn_lig[0])[1] + 5, M._ligament_at(fn_lig[0])[2] - 2])
    fn_split = _off(fa[1], -12, 0, -6)
    P["femoral_nerve"] = ("femoral_nerve", "nerve", 2.5, [groove, _lerp(groove, fn_lig, 0.5), fn_lig, fn_split])
    sart_br = M.surf("sartorius", M.c("sartorius", fn_split[2] - 25), "y", +1, gap=-1.0)
    P["femoral_nerve_sartorius"] = ("femoral_nerve", "nerve", 1.2,
                                    [fn_split, _lerp(fn_split, sart_br, 0.5) + [0, 2, 0], sart_br])
    rf = M.ext("rectus_femoris", fn_split[2] - 50, MED, gap=-3.0)
    P["femoral_nerve_rectus"] = ("femoral_nerve", "nerve", 1.3,
                                 [fn_split, _off(_lerp(fn_split, rf, 0.5), 0, 3, 0), rf])
    vm_top = M.bs["vastus_medialis"].bounds[1, 2]
    vm = M.c("vastus_medialis", vm_top - 45)
    P["femoral_nerve_vastus_medialis"] = ("femoral_nerve", "nerve", 1.3,
                                          [fn_split, _off(_lerp(fn_split, vm, 0.4), 4, 4, 0),
                                           _lerp(fn_split, vm, 0.75), vm])

    # ---- saphenous nerve: with the artery in the adductor canal (anterolateral to it),
    #      emerges between sartorius and gracilis at the knee, then beside the great saphenous vein
    sn = [fn_split, _off(fa[2], -6, -3), _off(fa[3], -6, -2), _off(fa[4], -4, -6), _off(fa[5], 0, -7),
          _off(fa[6], 3, -7)]
    zk = kz + 20
    sart_grac = M.between("sartorius", "gracilis", zk)
    sn.append(M.between("sartorius", ["gracilis", "adductor_magnus"], z_hiatus))
    sn.append(M.surf(["sartorius", "gracilis"], sart_grac, "x", +1, gap=1.5))

    # ---- great saphenous vein (subcutaneous, built first so the saphenous nerve can follow it)
    leg_env = LEG_MUSCLES + ["tibia", "fibula"]
    thigh_env = THIGH_MUSCLES + ["femur"]
    mm = L["medial_malleolus"]
    gsv = []
    # medial end of the dorsal venous arch, over the first metatarsal base
    b1 = L["mt1_base"]
    gsv.append(M.surf(FOOT_BONES + FOOT_MUSCLES, (b1[0] + 6, b1[1] - 12, 0), "z", +1, gap=3.0))
    nav = M.c("navicular", M.bs["navicular"].bounds.mean(0)[2])
    gsv.append(M.surf(FOOT_BONES + ["tibialis_anterior", "abductor_hallucis"], (0, mm[1] - 30, nav[2] + 4),
                      "x", +1, gap=3.0))
    # 1 cm anterior to the medial malleolus
    gsv.append(M.surf(["tibia", "tibialis_anterior", "talus"], (0, mm[1] - 10, mm[2]), "x", +1, gap=3.0))
    for z in np.linspace(mm[2] + 50, kz - 40, 5):
        ty = M.ext("tibia", z, MED)[1]
        gsv.append(M.surf(leg_env, (0, ty + 6, z), "x", +1, gap=3.0))
    yk = L["patella_medial"][1] + 50                       # posteromedial knee
    gsv.append(M.surf(thigh_env + ["gastrocnemius"], (0, yk, kz + 10), "x", +1, gap=3.0))
    for z in np.linspace(kz + 75, eia[2] - 95, 4):      # medial thigh, over the front edge of gracilis
        y = M.ext("gracilis", z, ANT)[1] + 4
        gsv.append(M.surf(thigh_env, (0, y, z), "x", +1, gap=3.0))
    # saphenous opening ~3 cm below and lateral to the pubic tubercle, joins the femoral vein
    fv_join = _lerp(fv[1], fv[2], 0.5)
    gsv.append(M.surf(thigh_env + ["pectineus"], (fv_join[0] + 6, 0, fv_join[2] - 8), "y", -1, gap=3.0))
    gsv.append(fv_join)
    P["great_saphenous_vein"] = ("great_saphenous_vein", "vessel", 2.8, gsv[::-1])

    # saphenous nerve below the knee: just behind the vein
    below = [g for g in gsv if mm[2] + 10 < g[2] < sn[-1][2] - 15]
    sn += [_off(g, -1.5, 5.0, 0) for g in below[::-1]]
    sn.append(_off(gsv[2], -1.0, 5.0, 4))
    P["saphenous_nerve"] = ("saphenous_nerve", "nerve", 1.2, sn)

    # ---- lateral femoral cutaneous nerve
    asis = L["asis"]
    psoas_lat = M.ext("psoas_major", asis[2] + 30, LAT, gap=3.0)
    il = M.surf("iliacus", (asis[0] + 30, 0, asis[2] + 8), "y", -1, gap=1.5)
    lig = L["inguinal_lateral"]
    under = np.array([lig[0], lig[1] + 4, lig[2] - 2])
    lf = [psoas_lat, il, under]
    for dz, dx in ((45, -8), (100, -18)):                  # over sartorius, then tensor fasciae latae
        lf.append(M.surf(THIGH_MUSCLES + ["iliotibial_tract"], (lig[0] + dx, 0, asis[2] - dz), "y", -1, gap=2.0))
    for dz, d in ((170, (-0.75, -0.65)), (250, (-0.9, -0.4))):   # anterolateral thigh
        lf.append(M.outer(THIGH_MUSCLES + ["iliotibial_tract"], asis[2] - dz, d, gap=2.0))
    P["lateral_femoral_cutaneous_nerve"] = ("lateral_femoral_cutaneous_nerve", "nerve", 1.2, lf)

    # ---- obturator nerve: medial to psoas -> lateral pelvic wall -> obturator canal -> thigh
    oc = L["obturator_canal"]
    ps_med = M.ext("psoas_major", oc[2] + 75, MED, gap=4.0)
    wall = M.surf(["obturator_internus", "hip_bone"], (0, oc[1] + 6, oc[2] + 30), "x", +1, gap=3.0)
    exit_ = _off(oc, -6, -10, -8)
    P["obturator_nerve"] = ("obturator_nerve", "nerve", 1.8, [ps_med, wall, _off(oc, 3, 0, 0), oc, exit_])
    # anterior division: between adductor longus (in front) and adductor brevis, to gracilis
    # divisions: in front of (anterior) and behind (posterior) adductor brevis, drifting from the
    # canal toward gracilis / adductor magnus
    gr = M.c("gracilis", exit_[2] - 120)
    am = M.c("adductor_magnus", exit_[2] - 140)

    def on_brevis(dz, side, target, t):
        x = exit_[0] + (target[0] - exit_[0]) * t
        return M.surf("adductor_brevis", (x, 0, exit_[2] - dz), "y", side, gap=1.5, default=exit_[1])
    a1, a2 = on_brevis(30, -1, gr, 0.3), on_brevis(70, -1, gr, 0.6)
    P["obturator_nerve_anterior"] = ("obturator_nerve", "nerve", 1.2, [exit_, a1, a2, _lerp(a2, gr, 0.6), gr])
    al = M.c("adductor_longus", exit_[2] - 110)
    P["obturator_nerve_adductor_longus"] = ("obturator_nerve", "nerve", 0.9, [a2, _lerp(a2, al, 0.5), al])
    p1, p2 = on_brevis(35, +1, am, 0.3), on_brevis(80, +1, am, 0.6)
    P["obturator_nerve_posterior"] = ("obturator_nerve", "nerve", 1.2, [exit_, p1, p2, _lerp(p2, am, 0.5), am])
    # ---- gluteal region
    it, gt = L["ischial_tuberosity"], L["greater_trochanter"]
    pir = M.bs["piriformis"]
    pz0, pz1 = pir.bounds[0, 2], pir.bounds[1, 2]
    xs = it[0] - 25
    pc = M.c("piriformis", 0.5 * (pz0 + pz1))
    pir_low = M.surf("piriformis", (xs, pc[1], 0), "z", -1, gap=5.0)
    pir_high = M.surf("piriformis", (xs - 5, pc[1] - 4, 0), "z", +1, gap=5.0)
    # sciatic nerve
    sc = [_off(pir_low, 8, -4, 8), pir_low]
    zm = 0.5 * (it[2] + gt[2])
    xm = 0.5 * (it[0] + gt[0])
    sc.append(M.surf(["quadratus_femoris", "gemellus_inferior", "obturator_internus", "femur"],
                     (xm, 0, zm), "y", +1, gap=4.5))
    z_split = kz + 95                                   # about a hand's breadth above the knee
    x_split = _lerp(M.c("biceps_femoris", z_split), M.c("semimembranosus", z_split), 0.4)[0]
    for t in (0.2, 0.45, 0.7):                          # on adductor magnus, deep to the long head of biceps
        z = zm + (z_split - zm) * t
        x = xm + (x_split - xm) * t
        sc.append(M.surf(["adductor_magnus", "femur"], (x, 0, z), "y", +1, gap=5.0))
    sbif = M.surf(["adductor_magnus", "femur"], (x_split, 0, z_split), "y", +1, gap=10.0)
    sc.append(sbif)
    P["sciatic_nerve"] = ("sciatic_nerve", "nerve", 4.0, sc)
    # superior gluteal nerve: above piriformis, between gluteus medius and minimus toward TFL
    sg = [_off(pir_high, 6, -2, -3), pir_high]
    for x in (pir_high[0] - 18, pir_high[0] - 36, pir_high[0] - 50):
        sg.append(M.surf("gluteus_minimus", (x, 0, pir_high[2] + 8), "y", +1, gap=1.5, default=sg[-1][1]))
    tfl = M.ext("tensor_fasciae_latae", asis[2] - 40, POST, gap=-2.0)
    sg.append(_lerp(sg[-1], tfl, 0.6))
    P["superior_gluteal_nerve"] = ("superior_gluteal_nerve", "nerve", 1.5, sg)
    # inferior gluteal nerve: below piriformis, medial to the sciatic, into gluteus maximus
    ig0 = _off(pir_low, 12, 2, 2)
    ig = [_off(ig0, 6, -3, 6), ig0]
    for dz, dx in ((-12, -4), (-30, -14)):
        ig.append(M.surf("gluteus_maximus", (ig0[0] + dx, 0, ig0[2] + dz), "y", -1, gap=-3.0))
    P["inferior_gluteal_nerve"] = ("inferior_gluteal_nerve", "nerve", 1.5, ig)

    # ---- tibial nerve, posterior tibial and fibular arteries
    tn = [sbif]
    tn.append(_off(pop[2], -5, 13))                     # superficial and lateral to the vessels
    tn.append(_off(pop[3], -5, 12))
    tn.append(_off(pop[4], -5, 10))
    dpc = []                                            # deep posterior compartment track
    for z in (kz - 110, kz - 165, kz - 215, kz - 265, kz - 315):
        q = M.between("flexor_digitorum_longus", "flexor_hallucis_longus", z)
        q = M.surf(["tibialis_posterior", "tibia", "flexor_digitorum_longus"], q, "y", +1, gap=2.5)
        dpc.append(q)
    z_tt = mm[2] - 15
    heel_front = M.ext("calcaneal_tendon", z_tt, ANT)
    tt = np.array([mm[0] - 6, 0.5 * (mm[1] + heel_front[1]), z_tt])     # tarsal tunnel
    ah = M.bs["abductor_hallucis"]
    # division under abductor hallucis, just medial to the calcaneus
    zs_ = _lerp(ah.bounds[0], ah.bounds[1], 0.7)[2]
    split = M.surf("calcaneus", (0, tt[1] - 16, zs_), "x", +1, gap=4.0, default=tt[0])
    tn += [_off(q, -2, 3) for q in dpc] + [_off(tt, -1, 4, 0), split]
    P["tibial_nerve"] = ("tibial_nerve", "nerve", 2.8, tn)
    pta = [bif] + [_off(q, 4, -2) for q in dpc] + [_off(tt, 1, -4, 2)]
    P["posterior_tibial_artery"] = ("posterior_tibial_artery", "vessel", 2.4, pta)
    # fibular artery: from the posterior tibial ~3 cm below its origin, toward the fibula,
    # deep to flexor hallucis longus
    fb = [_lerp(pta[0], pta[1], 0.55)]
    for z in (kz - 150, kz - 210, kz - 270, kz - 320):
        fib = M.ext("fibula", z, (0.8, 0.6), gap=3.5)
        fb.append(fib)
    P["fibular_artery"] = ("fibular_artery", "vessel", 1.8, fb)

    # ---- plantar nerves
    mp = [split]
    for y in (split[1] - 30, split[1] - 65, split[1] - 95):
        q = M.surf("abductor_hallucis", (0, y, 8), "x", -1, gap=1.5, default=-70)
        mp.append(q)
    h1 = L["mt1_head"]
    mp.append(np.array([h1[0] - 3, h1[1] + 15, -3.0]))
    P["medial_plantar_nerve"] = ("medial_plantar_nerve", "nerve", 1.2, mp)
    h5 = L["mt5_head"]
    lp = [split, _off(split, -8, -12, -10)]
    for t in (0.3, 0.6, 0.85):
        q = _lerp(_off(split, -8, -12, -10), (h5[0] + 12, h5[1] + 25, 0), t)
        top = M.hits(["flexor_digitorum_brevis"], q, "z")
        q[2] = top.max() + 2.0 if len(top) else q[2]
        lp.append(q)
    P["lateral_plantar_nerve"] = ("lateral_plantar_nerve", "nerve", 1.2, lp)

    # ---- common fibular nerve and branches
    fh, nk = L["fibular_head"], L["fibular_neck"]
    cf = [sbif]
    for z in (sbif[2] - 30, sbif[2] - 60):
        cf.append(M.ext("biceps_femoris", z, MED, gap=2.5))
    cf.append(M.ext("gastrocnemius", kz + 8, LAT, gap=2.0))
    cf.append(M.ext("fibula", fh[2] - 6, (-0.3, 1), gap=4.0))
    cf.append(M.ext("fibula", nk[2] + 4, (-1, 0.2), gap=3.5))
    cdiv = M.ext("fibula", nk[2] - 6, (-0.6, -0.8), gap=4.0)
    cf.append(cdiv)
    P["common_fibular_nerve"] = ("common_fibular_nerve", "nerve", 2.2, cf)

    # ---- anterior tibial artery: forward above the interosseous membrane, down on it
    def membrane(z, fwd):
        t = M.ext("tibia", z, (-1, 0.3))
        f = M.ext("fibula", z, (1, -0.3))
        q = _lerp(t, f, 0.5)
        return _off(q, 0, -fwd, 0)
    at = [bif, membrane(bif[2] - 12, -2)]
    for z in (bif[2] - 30, kz - 120, kz - 180, kz - 240):
        at.append(membrane(z, 4.5))
    z_ank = mm[2] + 25
    at.append(_off(M.between("extensor_hallucis_longus", "extensor_digitorum_longus", z_ank), 0, 3, 0))
    ankle_front = _off(M.between("extensor_hallucis_longus", "extensor_digitorum_longus", L["ankle_z"] + 3), 0, 4, 0)
    mx = ankle_front[0]
    at.append(ankle_front)
    P["anterior_tibial_artery"] = ("anterior_tibial_artery", "vessel", 2.0, at)

    # ---- dorsalis pedis: on the dorsum lateral to the extensor hallucis longus tendon,
    #      to the proximal end of the first intermetatarsal space
    b1, b2 = L["mt1_base"], L["mt2_base"]
    sp = _lerp(b1, b2, 0.5)
    dp = [ankle_front]
    for t in (0.35, 0.7):
        y = ankle_front[1] + (sp[1] - 10 - ankle_front[1]) * t
        dp.append(M.surf(FOOT_BONES, (mx + (sp[0] - mx) * t, y, 0), "z", +1, gap=3.0))
    dp.append(np.array([sp[0], sp[1] - 10, M.surf(FOOT_BONES, (sp[0], sp[1] - 10, 0), "z", +1)[2] + 0.5]))
    P["dorsalis_pedis_artery"] = ("dorsalis_pedis_artery", "vessel", 1.6, dp)

    # ---- deep fibular nerve: around the fibular neck into the anterior compartment, with the
    #      anterior tibial artery, onto the dorsum to the first web space
    df = [cdiv, M.ext("fibula", nk[2] - 14, (-0.3, -1), gap=4.0), _off(membrane(bif[2] - 35, 4), -5, 0, 0)]
    for q in at[3:]:
        df.append(_off(q, -4.5, 0, 0))
    for q in dp[1:-1]:
        df.append(_off(q, -4.0, 0, 0))
    h1, h2 = L["mt1_head"], L["mt2_head"]
    web = _lerp(h1, h2, 0.5)
    for t in (0.55, 0.95):
        q = _lerp(_off(dp[-2], -3, 0, 0), (web[0], web[1] + 4, 0), t)
        df.append(M.surf(FOOT_BONES + ["dorsal_interossei_foot"], q, "z", +1, gap=2.5))
    P["deep_fibular_nerve"] = ("deep_fibular_nerve", "nerve", 1.3, df)

    # ---- superficial fibular nerve: lateral compartment, superficial in the distal third,
    #      anterior to the ankle onto the dorsum
    sf = [cdiv]
    for z in (nk[2] - 50, kz - 140, kz - 200):          # lateral compartment, in front of the fibula
        sf.append(M.ext("fibula", z, (-0.7, -0.7), gap=5.0))
    for z, d in ((kz - 250, (-0.8, -0.6)), (kz - 300, (-0.6, -0.8))):
        sf.append(M.outer(leg_env, z, d, gap=2.0))
    lm = L["lateral_malleolus"]
    sf.append(M.surf(leg_env + FOOT_BONES, (lm[0] + 14, 0, lm[2] + 14), "y", -1, gap=3.0))
    m3 = L["mt3_base"]
    for y in (m3[1] + 2, m3[1] - 35):
        sf.append(M.surf(FOOT_BONES + FOOT_MUSCLES, (m3[0] - 4, y, 0), "z", +1, gap=2.0))
    P["superficial_fibular_nerve"] = ("superficial_fibular_nerve", "nerve", 1.3, sf)

    # ---- sural nerve and small saphenous vein (subcutaneous, posterior calf)
    calf = ["gastrocnemius", "soleus", "calcaneal_tendon", "plantaris", "fibularis_longus",
            "fibularis_brevis", "flexor_hallucis_longus"]
    sural, ssv = [], []
    behind = M.surf(["fibula", "fibularis_longus", "fibularis_brevis"], (lm[0] + 6, 0, lm[2] - 2), "y", +1, gap=3.0)
    top_x = M.gap_x("gastrocnemius", kz - 20, lc[0] + 5, mc[0] - 5)      # groove between the two heads
    for z in np.linspace(kz - 20, lm[2] + 45, 6):
        t = (kz - 20 - z) / (kz - 20 - lm[2])
        x = top_x + (behind[0] - top_x) * t ** 1.5
        q = M.surf(calf, (x, 0, z), "y", +1, gap=2.0)
        sural.append(_off(q, -2.5, 0, 0))
        ssv.append(M.surf(calf, (x + 4.5, 0, z), "y", +1, gap=2.5))
    sural.append(_off(behind, -3, 0, -3))
    ssv.append(_off(behind, 1, 3, 2))
    under = M.surf(["calcaneus", "fibularis_longus", "fibularis_brevis"], (0, lm[1] - 12, lm[2] - 22), "x", -1,
                   gap=3.0)
    sural.append(under)
    b5 = L["mt5_base"]
    for y in (b5[1] - 5, b5[1] - 40):
        sural.append(M.surf(FOOT_BONES + FOOT_MUSCLES, (0, y, b5[2] + 4), "x", -1, gap=2.5))
    # nerve leaves the tibial nerve in the popliteal fossa
    sural.insert(0, _lerp(tn[1], tn[2], 0.5))
    P["sural_nerve"] = ("sural_nerve", "nerve", 1.1, sural)
    # small saphenous vein: lateral end of the dorsal arch -> behind the lateral malleolus -> calf
    # midline -> through the deep fascia into the popliteal fossa
    ssv_foot = [M.surf(FOOT_BONES + FOOT_MUSCLES, (b5[0] + 6, b5[1] - 22, 0), "z", +1, gap=3.0),
                M.surf(FOOT_BONES + FOOT_MUSCLES, (0, b5[1] + 4, b5[2] + 14), "x", -1, gap=3.0)]
    ssv_end = _off(pop[2], 0, 11, 6)
    P["small_saphenous_vein"] = ("small_saphenous_vein", "vessel", 2.0,
                                 ssv_foot + [_off(under, 0, 4, 4)] + ssv[::-1] + [ssv_end])
    return P


def catmull_rom(points, samples_per_segment=8):
    p = np.asarray(points, dtype=float)
    p = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for t in np.linspace(0, 1, samples_per_segment, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(p[-2])
    return np.array(out)


def tube(path, radius, sides=10):
    """Tube mesh along a polyline using parallel-transport frames, capped."""
    tangents = np.gradient(path, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1, keepdims=True)
    normal = np.cross(tangents[0], [1.0, 0, 0])
    if np.linalg.norm(normal) < 1e-3:
        normal = np.cross(tangents[0], [0, 1.0, 0])
    normal /= np.linalg.norm(normal)
    rings = []
    angles = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    for i, t in enumerate(tangents):
        normal = normal - np.dot(normal, t) * t
        normal /= np.linalg.norm(normal)
        binormal = np.cross(t, normal)
        # Taper the last 15% so branch ends look like ends.
        frac = i / (len(path) - 1)
        r = radius * (0.55 + 0.45 * min(1.0, (1 - frac) / 0.15))
        rings.append(path[i] + r * (np.outer(np.cos(angles), normal) + np.outer(np.sin(angles), binormal)))
    verts = np.vstack(rings + [path[:1], path[-1:]])
    n = len(path)
    faces = []
    for i in range(n - 1):
        for j in range(sides):
            a, b = i * sides + j, i * sides + (j + 1) % sides
            c, d = a + sides, b + sides
            faces += [[a, c, b], [b, c, d]]
    s, e = n * sides, n * sides + 1
    for j in range(sides):
        faces.append([s, (j + 1) % sides, j])
        faces.append([e, (n - 1) * sides + j, (n - 1) * sides + (j + 1) % sides])
    return trimesh.Trimesh(verts, np.array(faces), process=True)


# ---------------------------------------------------------------- bone clearance

def _clear_bones(path, radius, solids, clearance=0.8, rounds=4):
    """Move samples of a centreline that are inside or within radius+clearance of a bone out
    along the surface normal, with light smoothing between rounds. Ends are moved too (a branch
    end that starts on a pushed trunk point gets the same correction)."""
    p = np.array(path, float)
    need = radius + clearance
    for r in range(rounds):
        moved = False
        for s in solids:
            near = s.near(p, need + 2)
            if not near.any():
                continue
            idx = np.nonzero(near)[0]
            d, out_dir, close = s.signed(p[idx])
            bad = d < need
            if bad.any():
                moved = True
                p[idx[bad]] = close[bad] + out_dir[bad] * (need + 0.2)
        if not moved:
            break
        if r < rounds - 1:
            q = p.copy()
            q[1:-1] = 0.25 * p[:-2] + 0.5 * p[1:-1] + 0.25 * p[2:]
            p = q
    return p


def _solids(by_structure):
    return [_Solid(by_structure[k]) for k in BONES if k in by_structure]


def _centrelines(by_structure):
    M = _Model(by_structure)
    solids = _solids(by_structure)
    out = {}
    paths = _paths(M)
    for name, (structure, layer, radius, pts) in paths.items():
        line = catmull_rom(np.array(pts, float))
        out[name] = (structure, layer, radius, _clear_bones(line, radius, solids))
    # A branch starts on a control point of its parent; bone clearance can move the two copies of
    # that point differently (different radii), so pull the branch start back onto the parent.
    for name, (_, _, _, pts) in paths.items():
        start = np.asarray(pts[0], float)
        for other, (_, _, _, opts) in paths.items():
            if other == name:
                continue
            if any(np.allclose(start, q) for q in np.asarray(opts, float)[1:]) or (
                    np.allclose(start, opts[0]) and len(opts) and list(paths).index(other) < list(paths).index(name)):
                line = out[name][3]
                tgt = out[other][3][np.argmin(np.linalg.norm(out[other][3] - start, axis=1))]
                delta = tgt - line[0]
                w = np.clip(1 - np.arange(len(line)) / 6.0, 0, 1)[:, None]
                line[:] = line + w * delta
                break
    return out, M


def build_schematic(by_structure):
    out = []
    lines, _ = _centrelines(by_structure)
    for name, (structure, layer, radius, line) in lines.items():
        out.append(("schematic_" + name, structure, layer, tube(line, radius)))
    return out


# ---------------------------------------------------------------- validation (python3 tools/lower_nerves.py)

SUBCUTANEOUS = {"great_saphenous_vein", "small_saphenous_vein", "sural_nerve", "lateral_femoral_cutaneous_nerve"}


def _load_parts(simplified=False):
    import os
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    from lower_parts import PARTS
    src = os.path.join(os.path.dirname(here), "source", "bodyparts3d")
    simplify = None
    if simplified:
        from build_lower_limb import simplify, BIG, BASE
    parts, layers = {}, {}
    for pid, key, layer in PARTS:
        m = trimesh.load(os.path.join(src, pid + ".stl"), force="mesh", process=True)
        if simplify is not None:
            m = simplify(m, BIG.get(key, BASE[layer]))
        parts.setdefault(key, []).append(m)
        layers[key] = layer
    return {k: trimesh.util.concatenate(v) for k, v in parts.items()}, layers


def _soft_envelope(by_structure, layers):
    """Face centres and normals of all muscles, tendons, ligaments and bones (the limb envelope)."""
    vs, ns = [], []
    for k, m in by_structure.items():
        if layers.get(k) in ("muscle", "tendon", "ligament", "bone"):
            vs.append(np.asarray(m.triangles_center))
            ns.append(np.asarray(m.face_normals))
    return np.vstack(vs), np.vstack(ns)


def _soft_distance(p, V, N, cell=6.0, reach=3):
    """Approximate signed distance from points p to the nearest soft-tissue surface
    (negative = inside a muscle), from the nearest face centre and its normal. Points more than
    about reach*cell mm from any soft tissue get +inf."""
    lo = V.min(0) - cell * (reach + 1)
    K = 4096
    ijk = np.floor((V - lo) / cell).astype(np.int64)
    key = (ijk[:, 0] * K + ijk[:, 1]) * K + ijk[:, 2]
    order = np.argsort(key)
    key, V, N = key[order], V[order], N[order]
    out = np.full(len(p), np.inf)
    r = np.arange(-reach, reach + 1)
    for i, q in enumerate(p):
        c = np.floor((q - lo) / cell).astype(np.int64)
        idx = []
        for dx in r:
            for dy in r:
                base = ((c[0] + dx) * K + (c[1] + dy)) * K
                s0, s1 = np.searchsorted(key, [base + c[2] - reach, base + c[2] + reach + 1])
                if s1 > s0:
                    idx.append(np.arange(s0, s1))
        if not idx:
            continue
        sel = np.concatenate(idx)
        d2 = ((V[sel] - q) ** 2).sum(1)
        k = sel[np.argmin(d2)]
        out[i] = np.sqrt(d2.min()) * (1 if np.dot(q - V[k], N[k]) > 0 else -1)
    return out


def validate(by_structure, layers):
    lines, M = _centrelines(by_structure)
    solids = _solids(by_structure)
    V, N = _soft_envelope(by_structure, layers)
    print(f"{'path':34s} {'r':>4s}  {'start (x,y,z)':>18s}  {'end (x,y,z)':>18s}  {'bone pen':>8s}  "
          f"{'soft out max':>12s} {'soft out med':>12s}")
    worst = 0.0
    rows = []
    for name, (structure, layer, radius, line) in lines.items():
        # tube surface penetration = radius - signed distance of the centreline from the bone
        pen = 0.0
        for s in solids:
            near = s.near(line, radius + 1.0)
            if near.any():
                d, _, _ = s.signed(line[near])
                pen = max(pen, float(radius - d.min()))
        worst = max(worst, pen)
        sd = _soft_distance(line, V, N)
        a, b = line[0], line[-1]
        rows.append((name, pen, sd))
        print(f"{name:34s} {radius:4.1f}  ({a[0]:5.0f},{a[1]:5.0f},{a[2]:5.0f})  ({b[0]:5.0f},{b[1]:5.0f},{b[2]:5.0f})"
              f"  {pen:8.2f}  {sd.max():12.1f} {np.median(sd):12.1f}")
    print(f"worst bone penetration of any tube surface: {worst:.2f} mm")
    return lines, rows


if __name__ == "__main__":
    import sys
    bs, lay = _load_parts(simplified="--simplified" in sys.argv)
    validate(bs, lay)


COURSES_MD = """## Schematic nerve and vessel courses to review

BodyParts3D 3.0 has no lower-limb nerves and no arteries below the iliacs, so
these are tubes built by `tools/lower_nerves.py`. Their control points are
derived in code from this model's bone landmarks and muscle sections and
surfaces, then pushed clear of the bones. Each item below says where the path
runs relative to named muscles and bones:

- **Femoral artery**: continues the external iliac artery mesh where it
  passes under the inguinal ligament, at about the mid-inguinal point; down
  the femoral triangle on pectineus and adductor longus, medial to sartorius;
  then the adductor canal between vastus medialis and the adductors, deep to
  sartorius; ends at the adductor hiatus, posteromedial to the femur, about
  4.5 cm above the adductor tubercle.
- **Deep femoral artery**: leaves the femoral artery about 3 to 4 cm below the
  inguinal ligament; runs posterolaterally and deep, behind adductor longus
  and in front of adductor brevis and magnus, close to the medial side of the
  femur; drawn to about mid-thigh.
- **Femoral vein**: medial to the femoral artery at the inguinal ligament,
  winding behind the artery down the femoral triangle so that it is posterior
  to it in the adductor canal, to the adductor hiatus.
- **Popliteal artery**: from the adductor hiatus onto the back of the femur
  between the condyles and the back of the knee joint, the deepest structure
  in the popliteal fossa; over popliteus to its lower border, where it divides.
- **Anterior tibial artery**: forward through the gap between tibia and
  fibula above the interosseous membrane; down the anterior compartment on
  the membrane between tibialis anterior and extensor digitorum longus /
  extensor hallucis longus; in front of the ankle between the extensor
  hallucis longus and extensor digitorum longus tendons, midway between the
  malleoli.
- **Dorsalis pedis artery**: continues the anterior tibial artery over the
  talus, navicular and intermediate cuneiform, lateral to the extensor
  hallucis longus tendon, and dips into the proximal end of the first
  intermetatarsal space.
- **Posterior tibial artery**: from the popliteal division down the deep
  posterior compartment on tibialis posterior, between flexor digitorum
  longus and flexor hallucis longus, just medial to the tibial nerve; behind
  the medial malleolus, midway between it and the heel (the posterior tibial
  pulse), in front of the nerve in the tarsal tunnel.
- **Fibular artery**: branches from the posterior tibial artery about 3 cm
  below its origin and runs laterally and down along the posteromedial side of
  the fibula, deep to flexor hallucis longus, ending above the ankle.
- **Great saphenous vein**: from the medial end of the dorsal venous arch over
  the first metatarsal base; along the medial side of the navicular; about 1
  cm in front of the medial malleolus; up the medial surface of the leg along
  the posteromedial border of the tibia; behind the medial condyle at the
  knee (about 5 cm behind the medial border of the patella); up the medial
  thigh over the front edge of gracilis and sartorius; through the saphenous
  opening, about 3 cm below and lateral to the pubic tubercle, into the
  femoral vein. Drawn just outside the muscles (subcutaneous).
- **Small saphenous vein**: from the lateral end of the dorsal arch over the
  base of the fifth metatarsal; below and then behind the lateral malleolus;
  up the back of the calf on gastrocnemius / the calcaneal tendon, moving to
  the midline between the two heads of gastrocnemius; through the deep fascia
  into the popliteal fossa. Drawn just outside the muscles.
- **Femoral nerve**: from the groove between psoas major and iliacus, under
  the inguinal ligament lateral to the femoral artery; divides about 3 cm
  below the ligament in the femoral triangle into short branches to the deep
  surface of sartorius, to rectus femoris and to vastus medialis (other
  muscular and cutaneous branches not drawn).
- **Saphenous nerve**: from the femoral division, lateral and then anterior
  to the femoral artery down the adductor canal under sartorius; leaves the
  canal at its lower end, emerges between sartorius and gracilis on the medial
  side of the knee, and runs down the medial leg just behind the great
  saphenous vein to in front of the medial malleolus.
- **Obturator nerve**: from the medial border of psoas down the lateral wall of
  the pelvis on obturator internus to the obturator canal at the upper
  (anterosuperior) part of the obturator foramen; out into the thigh above
  obturator externus, where it splits: anterior division in front of adductor
  brevis (behind adductor longus and pectineus) with a branch to adductor
  longus, ending in gracilis; posterior division behind adductor brevis on
  adductor magnus, ending in adductor magnus.
- **Lateral femoral cutaneous nerve**: emerges lateral to psoas major, crosses
  iliacus, passes under the inguinal ligament about 1.5 cm medial to the
  anterior superior iliac spine, then superficially over sartorius and tensor
  fasciae latae down the anterolateral thigh.
- **Superior gluteal nerve**: leaves the greater sciatic foramen above
  piriformis and runs laterally between gluteus medius and gluteus minimus
  toward the posterior border of tensor fasciae latae.
- **Inferior gluteal nerve**: leaves the greater sciatic foramen below
  piriformis, medial to the sciatic nerve, and passes back into the deep
  surface of gluteus maximus.
- **Sciatic nerve**: leaves the greater sciatic foramen below piriformis;
  deep to gluteus maximus, behind the gemelli, obturator internus and
  quadratus femoris, midway between the ischial tuberosity and the greater
  trochanter; down the back of the thigh on adductor magnus, deep to the long
  head of biceps femoris; divides at the apex of the popliteal fossa, about a
  hand's breadth (9.5 cm) above the knee joint line.
- **Tibial nerve**: straight down the popliteal fossa, superficial and lateral
  to the popliteal vessels; between the heads of gastrocnemius; under the
  soleus arch; down the deep posterior compartment on tibialis posterior
  between flexor digitorum longus and flexor hallucis longus, just lateral to
  the posterior tibial artery; behind the medial malleolus in the tarsal
  tunnel, midway between the malleolus and the heel; divides under abductor
  hallucis.
- **Medial plantar nerve**: from the tibial division forward along the sole on
  the lateral (deep) side of abductor hallucis toward the first metatarsal
  head and the big toe.
- **Lateral plantar nerve**: from the tibial division obliquely forward and
  laterally across the sole, between flexor digitorum brevis and the long
  plantar ligament, toward the fifth metatarsal head and the little toe.
- **Common fibular nerve**: from the sciatic division along the medial border
  of biceps femoris and its tendon; over the lateral side of the lateral head
  of gastrocnemius; behind the fibular head and around the lateral side of the
  fibular neck, where it is subcutaneous; divides in fibularis longus.
- **Deep fibular nerve**: from the division at the fibular neck forward through
  the extensor digitorum longus origin into the anterior compartment; down the
  interosseous membrane just lateral to the anterior tibial artery; in front
  of the ankle with the artery; over the dorsum of the foot to the first web
  space.
- **Superficial fibular nerve**: from the division down the lateral compartment
  in front of the fibula, between fibularis longus / brevis and extensor
  digitorum longus; superficial on the anterolateral leg in the distal third;
  in front of the ankle, lateral to the extensor tendons, onto the dorsum of
  the foot toward the middle toes.
- **Sural nerve**: leaves the tibial nerve in the popliteal fossa; down the
  back of the calf in the groove between the two heads of gastrocnemius,
  becoming subcutaneous at mid-calf; with the small saphenous vein (lateral to
  it) along the lateral side of the calcaneal tendon, behind and below the
  lateral malleolus, and along the lateral border of the foot past the base of
  the fifth metatarsal.

Known simplifications: single trunk diameters with no tapering except at
the ends; most muscular, articular and cutaneous branches are omitted
(e.g. saphenous infrapatellar branch, medial calcaneal, medial sural
cutaneous, lateral sural cutaneous, genicular and perforating arteries,
circumflex femoral arteries); no popliteal, tibial or plantar veins, no
external iliac or deep veins below the adductor hiatus; no plantar arteries or
plantar arch; the femoral vein has no valves or tributaries other than the
great saphenous vein; the sural nerve is drawn as one trunk without the
lateral sural communicating contribution; the saphenous opening and the
deep fascia are not modelled, so subcutaneous paths simply sit 2 to 3 mm
outside the muscles; positions follow this BodyParts3D model (a single
adult male), not a population average.
"""
