# Certification suite (k6): viewers + staff + report

Simulates real browsers on the public tournament page — catalog + card load, then a live phase
that **uses SSE when the server admits the stream and automatically falls back to version polling
when it does not** (disabled via admin Realtime settings, over the connection cap, or a plain k6
binary without the SSE extension). A staff scenario keeps saving results while viewers watch, so
publishes/invalidations happen under load like on event day.

**Run against staging only.** The staff scenario writes real match results.

## 1. Build a k6 with SSE support (recommended)

```bash
go install go.k6.io/xk6/cmd/xk6@latest
xk6 build --with github.com/phymbert/xk6-sse   # produces ./k6
# or: docker run --rm -v "$PWD:/xk6" grafana/xk6 build --with github.com/phymbert/xk6-sse
```

A stock `k6` also works — the runner detects the missing extension and every viewer uses the
polling path (that is still a valid capacity test of the degraded mode).

## 2. Run

```bash
cd load-tests/suite
TOURNAMENT_URL="https://your-app.vercel.app/t/<token>" \
BACKEND_URL="https://your-api.onrender.com" ADMIN_USER=admin ADMIN_PASS='...' \
STAFF_USER=staff01 STAFF_PASS='...' STAFF_CARD_ID=<uuid-of-RESULT_COLLECTION-card> \
K6_BIN=./k6 STEPS="500 2000 5000" HOLD=4m ./run-suite.sh
```

| Variable | Meaning | Default |
|---|---|---|
| `TOURNAMENT_URL` | Public tournament link `/t/<token>` (**required**) | – |
| `STEPS` | Viewer levels, held one after another | `500 2000 5000` |
| `RAMP` / `HOLD` | Ramp-up and hold time per step | `90s` / `4m` |
| `K6_BIN` | k6 binary (use the xk6 build for SSE) | `k6` |
| `SSE_MODE` | `auto` or `off` (force polling-only) | `auto` |
| `SSE_BASE_URL` | Point SSE at the backend origin if the CDN buffers streams | frontend origin |
| `BACKEND_URL` + `ADMIN_USER`/`ADMIN_PASS` | Enables the server monitor (CPU/RAM/SSE gauges) | off |
| `STAFF_USERS` + `STAFF_CARD_ID` | Staff writers: `user1:pass1,user2:pass2` — **one VU per account** (accounts allow 2 concurrent sessions) | off |
| `STAFF_USER`/`STAFF_PASS` | Single-writer shorthand instead of `STAFF_USERS` | – |
| `STAFF_VUS` | Staff VUs (capped at the number of accounts) | account count |
| `ERROR_BUDGET` / `P95_BUDGET_MS` | Stability budgets for thresholds and the verdict | `0.01` / `1000` |
| `POLL_MS` | Override the poll interval (else `/api/public/realtime-config`) | server value |

Ad-hoc single step without the runner:

```bash
TOURNAMENT_URL=... VIEWERS=500 HOLD=2m ./k6 run main.js        # SSE build
TOURNAMENT_URL=... VIEWERS=500 HOLD=2m k6 run main-polling.js  # stock k6
```

## 3. Report (`out/report.md`)

Per step: error rate, HTTP avg/p95/p99, peak SSE connections, peak polling users, SSE event
latency p95/p99, edge cache hit rate, bandwidth in/out (Mbps at the generator), backend CPU/RAM
peaks, DB pool activity, staff save count — plus the verdict line
**Maximum stable concurrent viewers** (largest step within the budgets).

Raw artifacts stay in `out/`: `step-*.summary.json`, `monitor.csv`, `steps.json`.

## Interpreting SSE vs polling numbers

- The backend caps SSE via the admin **Realtime settings** page (DB-backed, live). Viewers over
  the cap get a one-time 503 and poll instead — in the report they move from "SSE conn" to
  "Polling users". That split is expected, not an error.
- To certify a pure-polling day (SSE off), set SSE off in the admin page or run `SSE_MODE=off`.
- One laptop cannot realistically source 5,000 TLS clients; use a big cloud runner (or k6 cloud /
  distributed) for the certification run, and watch the generator's own CPU with `--vus-max`.
