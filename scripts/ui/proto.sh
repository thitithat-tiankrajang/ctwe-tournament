#!/usr/bin/env bash
# UI workflow: change the prototype first, checkpoint it, then port only what changed to React.
#
#   scripts/ui/proto.sh status              what changed in the prototype since React last synced
#   scripts/ui/proto.sh checkpoint "msg"    commit the prototype's current state
#   scripts/ui/proto.sh summary             changed JS functions / CSS rules since the sync point
#   scripts/ui/proto.sh diff [file]         full diff since the sync point (optionally into a file)
#   scripts/ui/proto.sh synced              record the prototype HEAD as ported into React
#
# The sync point lives in docs/ui-workflow/prototype-synced (committed with the React change).
# PROTOTYPE_DIR overrides the prototype location (default ~/Desktop/CTWE-prototype).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROTO="${PROTOTYPE_DIR:-$HOME/Desktop/CTWE-prototype}"
MARK="$REPO/docs/ui-workflow/prototype-synced"
# Hunk headers show the enclosing `function name(`, `const name =`, or CSS selector.
HUNK_RE='^(function [A-Za-z0-9_$]+|const [A-Za-z0-9_$]+ *=|let [A-Za-z0-9_$]+ *=|[.#:@a-zA-Z][^{]*[{]).*$'
UI="site/index.html site/icons.js"   # what React ports; docs and tools never show as UI changes
pgit() { git -C "$PROTO" -c "diff.proto.xfuncname=$HUNK_RE" "$@"; }

[ -d "$PROTO/.git" ] || { echo "prototype repo not found at $PROTO" >&2; exit 1; }
base() {
  [ -s "$MARK" ] || { echo "missing $MARK — run: $0 synced (once the React side matches)" >&2; exit 1; }
  head -1 "$MARK" | awk '{print $1}'
}

case "${1:-status}" in
  status)
    b="$(base)"
    echo "prototype: $PROTO"
    echo "React synced at prototype $(git -C "$PROTO" log -1 --format='%h %s' "$b")"
    pending="$(git -C "$PROTO" status --porcelain -- site tools)"
    [ -n "$pending" ] && { echo; echo "Uncheckpointed edits (run: $0 checkpoint \"msg\"):"; echo "$pending"; }
    echo; echo "Checkpoints not yet ported to React:"
    git -C "$PROTO" log --format='  %h %ad %s' --date=format:'%Y-%m-%d %H:%M' "$b"..HEAD | sed '/^$/d' || true
    git -C "$PROTO" diff --quiet "$b" HEAD -- $UI && echo "  (none)" || git -C "$PROTO" diff --stat "$b" HEAD -- $UI
    ;;
  checkpoint)
    msg="${2:?usage: $0 checkpoint \"what changed in the UI\"}"
    git -C "$PROTO" add -A site tools
    git -C "$PROTO" diff --cached --quiet && { echo "nothing to checkpoint"; exit 0; }
    git -C "$PROTO" commit -q -m "$msg"
    git -C "$PROTO" log -1 --format='checkpoint %h %s'
    ;;
  summary)
    b="$(base)"
    echo "== checkpoints"; git -C "$PROTO" log --format='%h %s' "$b"..HEAD
    echo "== changed regions (hunk header = enclosing function / CSS rule, +added -removed lines)"
    pgit diff -U0 "$b" HEAD -- $UI | awk '
      /^@@/ { if (hdr) printf "%-90s +%d -%d\n", hdr, add, del; hdr = $0; sub(/^@@[^@]*@@ ?/, "", hdr); if (hdr == "") hdr = "(top level)"; add = del = 0; next }
      /^\+[^+]/ || /^\+$/ { add++ } /^-[^-]/ || /^-$/ { del++ }
      END { if (hdr) printf "%-90s +%d -%d\n", hdr, add, del }' | awk '{ key = $0; sub(/ +\+[0-9]+ -[0-9]+$/, "", key); n[key]++; a[key] += $(NF-1); d[key] += $NF; if (!(key in seen)) { order[++k] = key; seen[key] = 1 } }
      END { for (i = 1; i <= k; i++) { key = order[i]; printf "%s  (%d hunk%s, +%d -%d)\n", substr(key, 1, 110), n[key], (n[key] > 1 ? "s" : ""), a[key], -d[key] } }'
    ;;
  diff)
    b="$(base)"
    if [ -n "${2:-}" ]; then pgit diff -U3 "$b" HEAD -- $UI > "$2"; echo "wrote $2 ($(wc -l < "$2") lines)"; else pgit diff -U3 "$b" HEAD -- $UI; fi
    ;;
  synced)
    git -C "$PROTO" diff --quiet HEAD -- $UI || { echo "prototype has uncheckpointed edits; checkpoint first" >&2; exit 1; }
    mkdir -p "$(dirname "$MARK")"
    git -C "$PROTO" log -1 --format='%H %ad %s' --date=iso-strict > "$MARK"
    echo "React now synced at prototype $(cut -c1-7 "$MARK") — commit $MARK with the React change"
    ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
