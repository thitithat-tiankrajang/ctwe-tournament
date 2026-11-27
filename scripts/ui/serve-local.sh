#!/usr/bin/env bash
# Serve the React app for the local stack on http://127.0.0.1:3319 (the only origin the local
# Spring Boot on :18219 accepts).
#
#   scripts/ui/serve-local.sh prod    build, then `next start` — real speed; rebuild after code changes
#   scripts/ui/serve-local.sh dev     `next dev` — edits show instantly but every page is slow
#
# Stops whatever Next.js server holds :3319 first. Logs: ~/.ctwe-local/run-logs/react.log
set -euo pipefail
MODE="${1:-prod}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=3319
LOG="$HOME/.ctwe-local/run-logs/react.log"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v22.*/bin 2>/dev/null | tail -1)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
export BACKEND_URL=http://127.0.0.1:18219 NEXT_PUBLIC_PUBLIC_API_ORIGIN='' NEXT_PUBLIC_SNAPSHOT_ORIGIN=''
cd "$REPO"
mkdir -p "$(dirname "$LOG")"

# Next rewrites tsconfig.json / next-env.d.ts for each dist dir; keep the working tree as it was.
restore() { cp /tmp/ctwe-serve-tsconfig.json tsconfig.json; cp /tmp/ctwe-serve-next-env.d.ts next-env.d.ts; }
cp tsconfig.json /tmp/ctwe-serve-tsconfig.json; cp next-env.d.ts /tmp/ctwe-serve-next-env.d.ts

case "$MODE" in
  prod)
    export NEXT_DIST_DIR=.next/ctwe-ui-build
    echo "building (about a minute)…"
    npx next build > /tmp/ctwe-serve-build.log 2>&1 || { restore; tail -30 /tmp/ctwe-serve-build.log; exit 1; }
    restore
    CMD=(npx next start -H 127.0.0.1 -p "$PORT")
    ;;
  dev)
    export NEXT_DIST_DIR=.next/ctwe-ui-dev
    CMD=(npx next dev --hostname 127.0.0.1 --port "$PORT")
    ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

# Stop the current server on the port only after a successful build, so a failed build keeps it.
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  ps -o command= -p "$pid" | grep -q "next" || { echo "port $PORT is held by a non-Next process ($pid); stopping" >&2; exit 1; }
  parent="$(ps -o ppid= -p "$pid" | tr -d ' ')"
  kill "$pid" 2>/dev/null || true
  ps -o command= -p "$parent" 2>/dev/null | grep -qE "npm|next" && kill "$parent" 2>/dev/null || true
done
for _ in $(seq 1 20); do lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done

nohup "${CMD[@]}" > "$LOG" 2>&1 &
for _ in $(seq 1 60); do grep -q "Ready in\|ready started\|Local:" "$LOG" 2>/dev/null && lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
[ "$MODE" = dev ] && restore
echo "$MODE server on http://127.0.0.1:$PORT (log: $LOG)"
