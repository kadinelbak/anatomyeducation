#!/usr/bin/env python3
"""Regenerate docs/question-review.md from assets/questions/upper-limb.json.

Usage: python3 tools/questions_md.py

The schematic nerve and artery course section is kept verbatim in
SCHEMATIC_SECTION below and appended unchanged at the end of the document.
"""
import json
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS = ROOT / "assets" / "questions" / "upper-limb.json"
STRUCTURES = ROOT / "assets" / "model" / "structures.json"
OUT = ROOT / "docs" / "question-review.md"

TOPICS = OrderedDict([
    ("bones", "Bones and joints"),
    ("ligaments", "Ligaments and membranes"),
    ("muscles", "Muscles"),
    ("nerves", "Nerves"),
    ("vessels", "Vessels"),
])

PREAMBLE = """# Questions for clinician review

{n} questions, drafted from standard anatomy references
(Gray's, Moore, Last's) without a clinician. Please check each stem, answer and
explanation before launch. The first 10 are the milestone-1 questions; the rest
were added later. Every item is still marked draft.

Answers are structures in the 3D model. Nerves and arteries in the model are
schematic (BodyParts3D has none for the forearm); their courses are listed at
the end for review too.
"""

HEADER = (
    "| # | Id | Type | Region | Stem | Answer | Also accepted | Explanation | Review status |\n"
    "|---|----|------|--------|------|--------|---------------|-------------|---------------|"
)

SCHEMATIC_SECTION = """## Schematic nerve and artery courses to review

Placed by hand in `tools/nerves.py`, in this model's coordinates, against
its muscles and bones:

- **Median nerve**: medial to brachial artery in the arm; between the heads of
  pronator teres; between FDS and FDP; emerges lateral to the palmaris longus
  tendon just above the wrist; carpal tunnel deep to the retinaculum; four
  digital branches (thumb, index, 2nd and 3rd web spaces) and a recurrent
  motor branch curling to the thenar muscles.
- **Ulnar nerve**: behind the medial epicondyle; between the heads of FCU;
  on FDP deep to FCU; lateral to the FCU tendon at the wrist; Guyon's canal
  superficial to the retinaculum, lateral to the pisiform; superficial branch
  to the little finger and 4th web space; deep branch across the palm to
  adductor pollicis.
- **Radial nerve**: between brachialis and brachioradialis at the elbow, then
  splits: superficial branch under brachioradialis, emerging on the lateral
  side in the distal third to the back of the first web space; posterior
  interosseous nerve through supinator, around the radius, and down the
  interosseous membrane.
- **Radial artery**: from the brachial bifurcation under brachioradialis to
  the radial pulse lateral to the FCR tendon, then dorsally through the
  anatomical snuffbox and between the first two metacarpals into the deep
  palmar arch.
- **Ulnar artery**: from the bifurcation under pronator teres and FDS, down
  with the ulnar nerve to Guyon's canal, continuing as the superficial palmar
  arch across the palm.

Known simplifications: no anterior interosseous nerve or artery, no cutaneous
branches of the forearm, no brachial artery above the cubital fossa, no deep
palmar arch drawn in full, single "trunk" diameters."""


def cell(text):
    return " ".join(str(text).split()).replace("|", "\\|")


def main():
    names = json.loads(STRUCTURES.read_text(encoding="utf-8"))["structures"]
    questions = json.loads(QUESTIONS.read_text(encoding="utf-8"))["questions"]
    parts = [PREAMBLE.format(n=len(questions))]
    number = {q["id"]: i for i, q in enumerate(questions, 1)}
    topics = list(TOPICS) + sorted({q["tags"]["topic"] for q in questions} - set(TOPICS))
    for topic in topics:
        rows = [q for q in questions if q["tags"]["topic"] == topic]
        if not rows:
            continue
        parts.append("## %s (%d)\n\n%s" % (TOPICS.get(topic, topic.title()), len(rows), HEADER))
        lines = []
        for q in rows:
            also = [names[a] for a in q["accept"] if a != q["target"]]
            lines.append("| " + " | ".join([
                str(number[q["id"]]),
                "`%s`" % q["id"],
                q["kind"],
                q["tags"]["region"],
                cell(q["prompt"]),
                cell(names[q["target"]]),
                cell(", ".join(also)),
                cell(q["explain"]),
                cell(q.get("review", {}).get("status", "draft")),
            ]) + " |")
        parts[-1] += "\n" + "\n".join(lines)
    parts.append(SCHEMATIC_SECTION)
    OUT.write_text("\n\n".join(p.strip("\n") for p in parts) + "\n", encoding="utf-8")
    print("wrote %s (%d questions)" % (OUT, len(questions)))


if __name__ == "__main__":
    main()
