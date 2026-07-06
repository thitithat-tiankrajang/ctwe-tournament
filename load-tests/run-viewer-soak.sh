#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export TOURNAMENT_URL="${TOURNAMENT_URL:-https://ct-we.com/t/9810d81d74824fe086daf2266d768eaa}"
export PUBLIC_API_ORIGIN="${PUBLIC_API_ORIGIN:-https://api.ct-we.com}"
export STAGES="${STAGES:-30s:100,1m:500,1m:1000,2m:2500,3m:5000}"

if [ "${1:-}" = "--preflight" ]; then
  exec node load-tests/soak-viewers.mjs --preflight
fi

if [ "${CONFIRM_PRODUCTION_LOAD:-}" != "ct-we.com" ]; then
  echo "Refusing production load without CONFIRM_PRODUCTION_LOAD=ct-we.com" >&2
  echo "Run preflight first: ./load-tests/run-viewer-soak.sh --preflight" >&2
  exit 2
fi

exec node load-tests/soak-viewers.mjs
