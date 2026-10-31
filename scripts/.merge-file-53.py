#!/usr/bin/env python3
"""Three-way merge every conflicted file on CONTENT, not on the index.

ours   = HEAD        (v0.2.18 + the web line)
base   = v0.2.16     (the ancestor both local lines started from)
theirs = server-line (the server line's own work since that base)

`git merge-file` then applies both sides' changes to the base. Files that come out clean are
written and staged; the rest keep their conflict markers and are listed for a human.
"""
import subprocess
import sys
from pathlib import Path

BASE_REF = "v0.2.16"
OURS_REF = "HEAD"
THEIRS_REF = "server-line"
WORK = Path("/root/penguin/scratchpad/ph-0218")


def blob(ref, path):
    r = subprocess.run(
        ["git", "show", f"{ref}:{path}"], cwd=WORK, capture_output=True
    )
    return r.stdout if r.returncode == 0 else None


def main():
    files = [l.strip() for l in sys.stdin if l.strip()]
    clean, dirty = [], []
    for f in files:
        ours, base, theirs = blob(OURS_REF, f), blob(BASE_REF, f), blob(THEIRS_REF, f)
        if base is None and ours is not None and theirs is not None:
            # Both sides added it independently: no base to merge against.
            subprocess.run(["git", "checkout", "--ours", "--", f], cwd=WORK, capture_output=True)
            subprocess.run(["git", "add", "--", f], cwd=WORK, capture_output=True)
            dirty.append((f, "add/add — kept ours, review against theirs"))
            continue
        if ours is None:
            dirty.append((f, "missing on our side — decide manually"))
            continue
        if theirs is None:
            subprocess.run(["git", "checkout", "--ours", "--", f], cwd=WORK, capture_output=True)
            subprocess.run(["git", "add", "--", f], cwd=WORK, capture_output=True)
            clean.append(f)
            continue

        Path("/tmp/m.ours").write_bytes(ours)
        Path("/tmp/m.base").write_bytes(base or b"")
        Path("/tmp/m.theirs").write_bytes(theirs)
        r = subprocess.run(
            ["git", "merge-file", "-p", "--diff3", "/tmp/m.ours", "/tmp/m.base", "/tmp/m.theirs"],
            capture_output=True,
        )
        merged = r.stdout
        (WORK / f).write_bytes(merged)
        if r.returncode == 0:
            subprocess.run(["git", "add", "--", f], cwd=WORK, capture_output=True)
            clean.append(f)
        else:
            dirty.append((f, f"{r.returncode} conflict hunk(s)"))

    print(f"clean by three-way merge: {len(clean)}")
    for f in clean:
        print(f"  CLEAN  {f}")
    print(f"need a human: {len(dirty)}")
    for f, why in dirty:
        print(f"  MANUAL {f}  ({why})")


main()
