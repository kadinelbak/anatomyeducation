#!/usr/bin/env python3
"""Regenerate docs/question-review.md from assets/questions/lower-limb.json.

Usage: python3 tools/questions_md.py

The schematic nerve and vessel course section comes from COURSES_MD in
tools/lower_nerves.py when that module exists, and is appended at the end.
Display names come from assets/model/structures.json, or STRUCTURES in
tools/lower_parts.py while the model is still being built.
"""
import json
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
QUESTIONS = ROOT / "assets" / "questions" / "lower-limb.json"
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
explanation before launch. Every item is still marked draft.

Answers are structures in the 3D model of the right lower limb, built from
BodyParts3D 3.0 (DBCLS, CC BY 4.0). BodyParts3D has no lower-limb nerves and no
arteries below the iliacs, so the nerves and vessels are schematic tubes; their
courses are listed at the end for review too. Spelling is UK.
"""

HEADER = (
    "| # | Id | Type | Region | Stem | Answer | Also accepted | Explanation | Review status |\n"
    "|---|----|------|--------|------|--------|---------------|-------------|---------------|"
)

try:
    from lower_nerves import COURSES_MD as SCHEMATIC_SECTION
except Exception:
    SCHEMATIC_SECTION = ("## Schematic nerve and vessel courses to review\n\n"
                         "The course list will appear here once tools/lower_nerves.py exists.")


def cell(text):
    return " ".join(str(text).split()).replace("|", "\\|")


def main():
    from lower_parts import STRUCTURES as fallback
    names = dict(fallback)
    if STRUCTURES.exists():  # model names win once the model is built
        names.update(json.loads(STRUCTURES.read_text(encoding="utf-8"))["structures"])
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
