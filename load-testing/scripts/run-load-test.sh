#!/usr/bin/env bash
set -euo pipefail

LOAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$LOAD_DIR/.." && pwd)"

# Optional local secrets/config file. It is covered by the repository's .env ignore rule.
if [[ -f "$LOAD_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$LOAD_DIR/.env"
  set +a
fi

EXTRA_ARGS=()
if [[ "${1:-}" == "--preflight" ]]; then
  EXTRA_ARGS=(--preflight)
elif (( $# > 0 )); then
  EXTRA_ARGS=("$@")
fi

if [[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]]; then
  TSX="$ROOT_DIR/node_modules/.bin/tsx"
elif [[ -x "$LOAD_DIR/node_modules/.bin/tsx" ]]; then
  TSX="$LOAD_DIR/node_modules/.bin/tsx"
else
  echo "Installing load-testing development dependencies…" >&2
  npm --prefix "$LOAD_DIR" install --ignore-scripts
  TSX="$LOAD_DIR/node_modules/.bin/tsx"
fi

# Every viewer owns one long-lived socket plus short-lived bootstrap requests. Raise the soft
# descriptor limit when the host permits it, and fail early when it is definitely too small.
TOP_STAGE="${STAGES:-100,250,500,750,1000,1500,2000,2500,3000,4000,5000,6000,7000,8000,9000,10000}"
TOP_STAGE="${TOP_STAGE##*,}"
REQUIRED_FDS=$((TOP_STAGE + 1024))
CURRENT_FDS="$(ulimit -n)"
if [[ "$CURRENT_FDS" =~ ^[0-9]+$ ]] && (( CURRENT_FDS < REQUIRED_FDS )); then
  ulimit -n "$REQUIRED_FDS" 2>/dev/null || true
  CURRENT_FDS="$(ulimit -n)"
fi
if [[ "$CURRENT_FDS" =~ ^[0-9]+$ ]] && (( CURRENT_FDS < TOP_STAGE )); then
  echo "Open-file limit ($CURRENT_FDS) is below the top stage ($TOP_STAGE)." >&2
  echo "Raise ulimit -n or lower STAGES before running the capacity suite." >&2
  exit 1
fi

cd "$LOAD_DIR"
if (( ${#EXTRA_ARGS[@]} > 0 )); then
  exec "$TSX" scripts/orchestrator.ts "${EXTRA_ARGS[@]}"
else
  exec "$TSX" scripts/orchestrator.ts
fi
