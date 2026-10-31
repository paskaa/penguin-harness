#!/usr/bin/env bash
# Resolve the 53 conflicts the mechanical way round:
#   keep OUR side (v0.2.18 + the web line) and re-apply the server line's local delta
#   (v0.2.16 -> server-line) on top of it. Ours already carries the upstream work, so the
#   only thing to graft is what the server line added since the 0.2.16 base.
# Whatever still conflicts is a genuine three-way collision: recorded for a human decision.
set -uo pipefail
cd /root/penguin/scratchpad/ph-0218 || exit 1

: > /tmp/still-conflicted.txt
: > /tmp/auto-resolved.txt

while read -r f; do
  [ -z "$f" ] && continue
  if ! git checkout --ours -- "$f" 2>/dev/null; then
    echo "OURS-MISSING $f" >> /tmp/still-conflicted.txt
    continue
  fi
  git add -- "$f" 2>/dev/null
  if git diff --no-color v0.2.16 server-line -- "$f" | git apply --3way --whitespace=nowarn - 2>/tmp/apply.err; then
    echo "OK $f" >> /tmp/auto-resolved.txt
  else
    if grep -q "^<<<<<<<" "$f" 2>/dev/null; then
      echo "CONFLICT $f" >> /tmp/still-conflicted.txt
    else
      echo "APPLY-FAIL $f $(head -1 /tmp/apply.err)" >> /tmp/still-conflicted.txt
    fi
  fi
done < /tmp/c53.txt

echo "auto-resolved: $(wc -l < /tmp/auto-resolved.txt)"
echo "still unresolved: $(wc -l < /tmp/still-conflicted.txt)"
cat /tmp/still-conflicted.txt
