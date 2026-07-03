#!/usr/bin/env bash
# Stepped certification run: holds each viewer level (default 500 -> 2000 -> 5000), exports one
# k6 summary per step, samples the backend throughout, then builds out/report.md.
#
# Required:
#   TOURNAMENT_URL=https://host/t/<token>   the public tournament link to certify
# Recommended (server metrics in the report):
#   BACKEND_URL=... ADMIN_USER=... ADMIN_PASS=...
# Optional:
#   STEPS="500 2000 5000"  RAMP=90s  HOLD=4m  K6_BIN=k6  SSE_MODE=auto|off  SSE_BASE_URL=...
#   STAFF_USER/STAFF_PASS/STAFF_CARD_ID/STAFF_VUS  ERROR_BUDGET=0.01  P95_BUDGET_MS=1000
set -euo pipefail
cd "$(dirname "$0")"

: "${TOURNAMENT_URL:?set TOURNAMENT_URL=https://host/t/<token>}"
STEPS="${STEPS:-500 2000 5000}"
RAMP="${RAMP:-90s}"
HOLD="${HOLD:-4m}"
K6_BIN="${K6_BIN:-k6}"
OUT="${OUT:-out}"
mkdir -p "$OUT"

# Pick the SSE-capable script when the binary has the extension; otherwise degrade to polling-only.
SCRIPT=main-polling.js
if [ "${SSE_MODE:-auto}" != "off" ] && "$K6_BIN" version 2>/dev/null | grep -qi "xk6-sse"; then
  SCRIPT=main.js
  echo "suite: SSE extension detected -> $SCRIPT"
else
  echo "suite: no SSE extension (or SSE_MODE=off) -> $SCRIPT (viewers poll, like refused browsers)"
fi

MONITOR_PID=""
if [ -n "${BACKEND_URL:-}" ] && [ -n "${ADMIN_USER:-}" ] && [ -n "${ADMIN_PASS:-}" ]; then
  ./monitor.sh "$OUT/monitor.csv" "${MONITOR_INTERVAL:-5}" &
  MONITOR_PID=$!
  trap '[ -n "$MONITOR_PID" ] && kill "$MONITOR_PID" 2>/dev/null || true' EXIT
else
  echo "suite: BACKEND_URL/ADMIN_USER/ADMIN_PASS not set -> skipping server monitor (report will lack CPU/RAM)"
fi

echo "[]" > "$OUT/steps.json"
for VIEWERS in $STEPS; do
  echo "=== step: $VIEWERS viewers (ramp $RAMP, hold $HOLD) ==="
  START=$(date +%s)
  set +e
  VIEWERS="$VIEWERS" RAMP="$RAMP" HOLD="$HOLD" TOURNAMENT_URL="$TOURNAMENT_URL" \
    "$K6_BIN" run --summary-export "$OUT/step-$VIEWERS.summary.json" "$SCRIPT"
  K6_STATUS=$?
  set -e
  END=$(date +%s)
  /usr/bin/env python3 - "$OUT/steps.json" "$VIEWERS" "$START" "$END" "$K6_STATUS" <<'PY'
import json, sys
path, viewers, start, end, status = sys.argv[1:6]
steps = json.load(open(path))
steps.append({"viewers": int(viewers), "start": int(start), "end": int(end), "k6_exit": int(status)})
json.dump(steps, open(path, "w"))
PY
  [ "$K6_STATUS" -ne 0 ] && echo "step $VIEWERS: k6 exit $K6_STATUS (thresholds breached — recorded, continuing)"
  sleep "${COOLDOWN_SECONDS:-30}"
done

[ -n "$MONITOR_PID" ] && { kill "$MONITOR_PID" 2>/dev/null || true; MONITOR_PID=""; }

/usr/bin/env python3 report.py "$OUT"
echo "=== report: $OUT/report.md ==="
