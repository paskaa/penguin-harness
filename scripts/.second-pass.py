#!/usr/bin/env python3
"""Second pass on the still-partial files: choose the primary side per file and graft the other.

  primary=theirs  base=v0.2.16  graft=v0.2.18   (a server-line file, modernised to 0.2.18)
  primary=ours    base=v0.2.16  graft=server-line (a web-line file, plus the server line's work)

Files that come out clean are written and staged; the rest keep their markers.
"""
import subprocess
import sys
from pathlib import Path

WORK = Path("/root/penguin/scratchpad/ph-0218")
OURS_REF, BASE_REF, THEIRS_REF = "HEAD", "v0.2.16", "server-line"

PRIMARY_THEIRS = [
    "packages/server/src/http/routes/schedules.ts",
    "packages/server/src/http/routes/usage.ts",
    "packages/server/src/runtime/scheduler.ts",
    "packages/server/src/services/trace-service.ts",
    "packages/server/src/services/project-config-service.ts",
    "packages/server/src/mechanisms/projects.ts",
    "packages/server/tsup.config.ts",
    "packages/server/src/db/pg/shim-entry.ts",
    "packages/server/src/db/pg/shim.ts",
    "packages/server/src/db/pg/translate.ts",
    "packages/server/src/db/pg/worker.ts",
]

PRIMARY_OURS = [
    "packages/server/src/http/routes/sessions.ts",
    "packages/server/src/api/types.ts",
    "packages/server/src/runtime/session-manager.ts",
    "packages/server/src/runtime/usage-recorder.ts",
    "packages/core/src/agent.ts",
    "packages/core/src/engine/context-engine.ts",
    "packages/core/src/state/project-config.ts",
    "packages/web/src/api/sse.ts",
    "packages/web/src/features/chat/chat-page.tsx",
    "packages/web/src/features/company/tickets-page.tsx",
    "packages/web/src/features/schedules/schedule-store.ts",
    "packages/web/src/lib/nav-group-collapse.ts",
    "packages/web/test/nav-group-collapse.test.ts",
    "packages/web/test/schedule-panel-state.test.ts",
]


def blob(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=WORK, capture_output=True)
    return r.stdout if r.returncode == 0 else None


def run(f, primary):
    base = blob(BASE_REF, f)
    ours, theirs = blob(OURS_REF, f), blob(THEIRS_REF, f)
    if base is None or ours is None or theirs is None:
        print(f"SKIP   {f} (missing on one side)")
        return False
    a, b, c = (theirs, base, ours) if primary == "theirs" else (ours, base, theirs)
    Path("/tmp/p.a").write_bytes(a)
    Path("/tmp/p.base").write_bytes(b)
    Path("/tmp/p.c").write_bytes(c)
    r = subprocess.run(
        ["git", "merge-file", "-p", "--diff3", "/tmp/p.a", "/tmp/p.base", "/tmp/p.c"],
        capture_output=True,
    )
    (WORK / f).write_bytes(r.stdout)
    if r.returncode == 0:
        subprocess.run(["git", "add", "--", f], cwd=WORK, capture_output=True)
        print(f"CLEAN  {f}  (primary {primary})")
        return True
    print(f"LEFT   {f}  ({r.returncode} hunks, primary {primary})")
    return False


def main():
    ok = 0
    for f in PRIMARY_THEIRS:
        ok += run(f, "theirs")
    for f in PRIMARY_OURS:
        ok += run(f, "ours")
    print(f"\nclean after pass two: {ok}/{len(PRIMARY_THEIRS) + len(PRIMARY_OURS)}")


main()
