#!/usr/bin/env python3
"""Resolve the mechanical share of the three-way conflicts in the candidate worktree.

For every file `git merge-file --diff3` left conflicting, each conflict block is examined:

  theirs == base        -> they did not touch it: keep ours
  ours   == base        -> we did not touch it: take theirs
  base empty, both added-> union of both sides, de-duplicated, ours first (imports, route
                           lists, string tables, enum members all resolve this way)
  otherwise             -> left in place and reported: a human decides

Usage:  python3 scripts/.union-resolve.py <file-list>
"""
import subprocess
import sys
from pathlib import Path

WORK = Path("/root/penguin/scratchpad/ph-0218")
OURS, BASE, THEIRS = "<<<<<<<", "|||||||", ">>>>>>>"


def resolve_text(text):
    lines = text.splitlines(keepends=True)
    out, i, manual, auto = [], 0, 0, 0
    while i < len(lines):
        if lines[i].startswith(OURS):
            j = i + 1
            ours = []
            while j < len(lines) and not lines[j].startswith(BASE):
                ours.append(lines[j]); j += 1
            base = []
            if j < len(lines) and lines[j].startswith(BASE):
                j += 1
                while j < len(lines) and not lines[j].startswith("======="):
                    base.append(lines[j]); j += 1
            theirs = []
            j += 1  # skip =======
            while j < len(lines) and not lines[j].startswith(THEIRS):
                theirs.append(lines[j]); j += 1
            if j >= len(lines):
                manual += 1
                out.extend(lines[i:]); break
            j += 1  # skip >>>>>>>
            i = j
            if theirs == base:
                out.extend(ours); auto += 1
            elif ours == base:
                out.extend(theirs); auto += 1
            elif all(not b.strip() for b in base):
                seen, union = set(), []
                for ln in ours + theirs:
                    key = ln.strip()
                    if key and key in seen:
                        continue
                    seen.add(key)
                    union.append(ln)
                out.extend(union); auto += 1
            else:
                manual += 1
                out.extend(["<<<<<<< MANUAL (ours)\n", *ours, "=======\n", *theirs, ">>>>>>> MANUAL (theirs)\n"])
        else:
            out.append(lines[i]); i += 1
    return "".join(out), auto, manual


def main():
    files = [l.strip() for l in sys.stdin if l.strip()]
    rows = []
    for f in files:
        p = WORK / f
        if not p.exists():
            rows.append((f, 0, 0, "missing"))
            continue
        text = p.read_text(errors="surrogateescape")
        if OURS not in text:
            rows.append((f, 0, 0, "no markers"))
            continue
        new, auto, manual = resolve_text(text)
        p.write_text(new, errors="surrogateescape")
        rows.append((f, auto, manual, "done" if manual == 0 else "partial"))
        if manual == 0:
            subprocess.run(["git", "add", "--", f], cwd=WORK, capture_output=True)

    done = [r for r in rows if r[3] in ("done", "no markers")]
    part = [r for r in rows if r[3] == "partial"]
    other = [r for r in rows if r[3] in ("missing",)]
    print(f"fully resolved: {len(done)}")
    for f, a, m, _ in done:
        print(f"  OK      {f}  (auto hunks {a})")
    print(f"partially resolved (manual hunks left): {len(part)}")
    for f, a, m, _ in part:
        print(f"  PARTIAL {f}  auto={a} manual={m}")
    if other:
        print("missing on our side:")
        for f, _, _, s in other:
            print(f"  {s}  {f}")


main()
