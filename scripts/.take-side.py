#!/usr/bin/env python3
"""Resolve every remaining MANUAL conflict block in a file towards one side.

Usage: python3 scripts/.take-side.py ours|theirs <file> [<file> ...]
"""
import sys
from pathlib import Path

WORK = Path("/root/penguin/scratchpad/ph-0218")


def take(text, side):
    lines = text.splitlines(keepends=True)
    out, i = [], 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<< MANUAL"):
            j = i + 1
            ours = []
            while j < len(lines) and not lines[j].startswith("======="):
                ours.append(lines[j]); j += 1
            theirs = []
            j += 1
            while j < len(lines) and not lines[j].startswith(">>>>>>> MANUAL"):
                theirs.append(lines[j]); j += 1
            j += 1
            out.extend(ours if side == "ours" else theirs)
            i = j
        else:
            out.append(lines[i]); i += 1
    return "".join(out)


def main():
    side = sys.argv[1]
    if side not in ("ours", "theirs"):
        print("first argument must be ours or theirs", file=sys.stderr)
        raise SystemExit(2)
    for f in sys.argv[2:]:
        p = WORK / f
        text = p.read_text(errors="surrogateescape")
        if "<<<<<<< MANUAL" not in text:
            print(f"SKIP   {f} (no manual blocks)")
            continue
        p.write_text(take(text, side), errors="surrogateescape")
        print(f"TOOK-{side.upper():6s} {f}")


main()
