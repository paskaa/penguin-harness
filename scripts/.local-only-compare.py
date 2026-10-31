#!/usr/bin/env python3
"""For each conflicted file, compare the two sides' LOCAL additions since v0.2.16.

Prints how many added lines each side has that the other lacks — the decision hint for
whether taking one side wholesale would lose the other side's work.
"""
import subprocess
import sys

BASE = "v0.2.16"
THEIRS = "server-line"
OURS = "HEAD"


def added_lines(ref, path):
    out = subprocess.run(
        ["git", "diff", "--no-color", "-U0", BASE, ref, "--", path],
        capture_output=True, text=True,
    ).stdout
    lines = set()
    for ln in out.splitlines():
        if ln.startswith("+") and not ln.startswith("+++"):
            body = ln[1:].strip()
            if len(body) > 3:
                lines.add(body)
    return lines


def main():
    files = [l.strip() for l in sys.stdin if l.strip()]
    for f in files:
        ours = added_lines(OURS, f)
        theirs = added_lines(THEIRS, f)
        only_theirs = theirs - ours
        only_ours = ours - theirs
        if not only_theirs:
            verdict = "TAKE-OURS"
        elif not only_ours:
            verdict = "TAKE-THEIRS"
        else:
            verdict = "MERGE"
        print(f"{verdict:11s} theirs_only={len(only_theirs):4d} ours_only={len(only_ours):4d}  {f}")


main()
