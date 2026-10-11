"""Schematic nerves and arteries for the forearm and hand.

BodyParts3D 3.0 and 4.x have no median, ulnar or radial nerves and no radial
or ulnar artery trunks for the forearm, so these are hand-placed tubes.
Control points are in BodyParts3D space (mm; x = patient left, y = posterior,
z = up) and were placed against this model's muscles and bones following
standard descriptions of each course. They show the route, not exact
diameter or branching, and need a clinician's review like the questions do.
"""
import numpy as np
import trimesh

# name: (structure, layer, radius mm, control points)
PATHS = {
    "median_nerve": ("median_nerve", "nerve", 2.0, [
        (-190, -78, 1108),   # arm, medial to brachial artery
        (-197, -80, 1065),   # cubital fossa, medial to biceps tendon
        (-210, -81, 1035),   # between the two heads of pronator teres
        (-220, -80, 1000),   # between FDS and FDP
        (-230, -91, 960),
        (-236, -100, 920),
        (-242, -111, 880),
        (-246, -120, 850),   # surfaces between FCR and palmaris longus
        (-252, -125, 830),
        (-257, -128, 812),   # carpal tunnel, deep to the flexor retinaculum
        (-262, -132, 795),
    ]),
    "median_digital_thumb": ("median_nerve", "nerve", 1.0, [
        (-262, -132, 795), (-280, -143, 782), (-299, -154, 762)]),
    "median_digital_index": ("median_nerve", "nerve", 1.0, [
        (-262, -132, 795), (-272, -141, 770), (-283, -146, 736)]),
    "median_digital_2nd_web": ("median_nerve", "nerve", 1.0, [
        (-262, -132, 795), (-266, -141, 770), (-270, -146, 731)]),
    "median_digital_3rd_web": ("median_nerve", "nerve", 1.0, [
        (-262, -132, 795), (-258, -140, 770), (-256, -146, 735)]),
    "median_recurrent": ("median_recurrent_branch", "nerve", 0.9, [
        (-264, -134, 792), (-273, -143, 794), (-283, -146, 801)]),

    "ulnar_nerve": ("ulnar_nerve", "nerve", 1.9, [
        (-183, -52, 1108),   # posterior to the medial intermuscular septum
        (-181, -52, 1060),   # behind the medial epicondyle
        (-196, -58, 1035),   # between the two heads of FCU
        (-203, -72, 1000),   # deep to FCU, on FDP
        (-210, -80, 960),
        (-216, -92, 920),
        (-226, -104, 880),
        (-233, -113, 850),   # lateral to the FCU tendon
        (-238, -121, 830),
        (-241, -135, 810),   # Guyon's canal, superficial to the retinaculum
        (-243, -137, 799),
    ]),
    "ulnar_superficial": ("ulnar_nerve", "nerve", 1.0, [
        (-243, -137, 799), (-243, -143, 780), (-243, -146, 736)]),
    "ulnar_superficial_little": ("ulnar_nerve", "nerve", 1.0, [
        (-243, -137, 799), (-236, -143, 780), (-228, -146, 746)]),
    "ulnar_deep": ("ulnar_deep_branch", "nerve", 1.1, [
        (-243, -137, 799), (-248, -130, 793), (-256, -126, 789),
        (-266, -127, 787), (-278, -130, 789), (-285, -134, 788)]),

    "radial_nerve": ("radial_nerve", "nerve", 2.0, [
        (-224, -70, 1108),   # between brachialis and brachioradialis
        (-232, -72, 1068),   # anterior to the lateral epicondyle
        (-233, -73, 1058),   # divides
    ]),
    "radial_superficial": ("radial_superficial_branch", "nerve", 1.2, [
        (-233, -73, 1058), (-241, -82, 1040), (-247, -90, 1000),
        (-254, -94, 960), (-259, -96, 920), (-263, -97, 890),
        (-273, -95, 860), (-280, -99, 840), (-288, -107, 820),
        (-297, -115, 797), (-305, -124, 776)]),
    "radial_superficial_index": ("radial_superficial_branch", "nerve", 0.9, [
        (-288, -107, 820), (-287, -109, 790), (-284, -116, 752)]),
    "posterior_interosseous": ("posterior_interosseous_nerve", "nerve", 1.2, [
        (-233, -73, 1058), (-240, -70, 1040),   # enters supinator
        (-246, -62, 1020), (-241, -63, 995),    # winds round the radius
        (-236, -70, 960), (-238, -78, 920),     # on the interosseous membrane
        (-243, -89, 880), (-250, -97, 850), (-254, -103, 826)]),

    "radial_artery": ("radial_artery", "vessel", 1.5, [
        (-197, -84, 1108),   # brachial artery
        (-205, -86, 1070),   # bifurcation
        (-218, -90, 1045), (-238, -96, 1000), (-250, -100, 960),
        (-257, -102, 920), (-260, -108, 880),
        (-263, -118, 850),   # radial pulse, lateral to the FCR tendon
        (-268, -122, 832),
        (-279, -118, 820),   # winds dorsally
        (-283, -110, 810),   # anatomical snuffbox
        (-281, -110, 798),
        (-283, -119, 791),   # between first and second metacarpals
        (-275, -126, 784),   # deep palmar arch
        (-262, -126, 782), (-250, -125, 784)]),
    "ulnar_artery": ("ulnar_artery", "vessel", 1.5, [
        (-205, -86, 1070), (-205, -82, 1040), (-208, -82, 1000),
        (-215, -85, 960), (-221, -95, 920), (-231, -107, 880),
        (-237, -115, 850), (-242, -123, 830),
        (-246, -136, 810),   # Guyon's canal, lateral to the nerve
        (-247, -138, 800)]),
    "superficial_palmar_arch": ("superficial_palmar_arch", "vessel", 1.2, [
        (-247, -138, 800), (-250, -146, 781), (-260, -149, 771),
        (-272, -147, 773), (-283, -142, 783)]),
}


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


def build_schematic(by_structure):
    out = []
    for name, (structure, layer, radius, points) in PATHS.items():
        out.append(("schematic_" + name, structure, layer, tube(catmull_rom(points), radius)))
    return out
