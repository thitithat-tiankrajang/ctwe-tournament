#!/usr/bin/env bash
# Samples backend health (CPU / RAM / SSE streams / DB pool) via Spring actuator into a CSV.
# Point BACKEND_URL at the BACKEND origin (Render URL or localhost), not the Vercel frontend —
# actuator is admin-gated and never CDN-cached.
#
#   BACKEND_URL=https://api.example.com ADMIN_USER=admin ADMIN_PASS=... \
#     ./monitor.sh out/monitor.csv [interval-seconds]
set -euo pipefail

OUT="${1:?usage: monitor.sh <out.csv> [interval-seconds]}"
INTERVAL="${2:-5}"
BACKEND_URL="${BACKEND_URL:?set BACKEND_URL (backend origin, not the Vercel host)}"
ADMIN_USER="${ADMIN_USER:?set ADMIN_USER}"
ADMIN_PASS="${ADMIN_PASS:?set ADMIN_PASS}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

json() { /usr/bin/env python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# Admin session (actuator requires ROLE_ADMIN). Accounts allow only two concurrent sessions, so
# use a dedicated admin (not one that other tools log in with) or the session gets displaced;
# the loop re-logins automatically when that happens.
login() {
  local CSRF
  CSRF=$(curl -sf -c "$JAR" -b "$JAR" "$BACKEND_URL/api/auth/me" | json "['csrfToken']") || return 1
  curl -sf -o /dev/null -c "$JAR" -b "$JAR" -X POST "$BACKEND_URL/login" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "username=$ADMIN_USER" --data-urlencode "password=$ADMIN_PASS" \
    --data-urlencode "_csrf=$CSRF"
}
login || { echo "monitor: initial login failed" >&2; exit 1; }

metric() {
  curl -sf -b "$JAR" "$BACKEND_URL/actuator/metrics/$1" 2>/dev/null \
    | json "['measurements'][0]['value']" 2>/dev/null || echo ""
}

echo "epoch,iso,process_cpu,system_cpu,jvm_used_bytes,sse_public,sse_staff,db_active,db_pending" > "$OUT"
echo "monitor: sampling $BACKEND_URL every ${INTERVAL}s -> $OUT" >&2
while true; do
  NOW=$(date +%s)
  ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  CPU=$(metric process.cpu.usage)
  if [ -z "$CPU" ]; then
    login || true
    CPU=$(metric process.cpu.usage)
  fi
  echo "$NOW,$ISO,$CPU,$(metric system.cpu.usage),$(metric jvm.memory.used),$(metric sse.streams.public),$(metric sse.streams.staff),$(metric hikaricp.connections.active),$(metric hikaricp.connections.pending)" >> "$OUT"
  sleep "$INTERVAL"
done
