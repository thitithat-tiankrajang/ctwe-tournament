# CTWE staged SSE capacity framework

This is the end-to-end capacity harness for the real tournament viewer path. One command ramps
through configured viewer levels, holds real SSE sockets open, samples real Spring Boot/JVM
metrics, evaluates safety thresholds, saves raw JSON, and writes
[`reports/runbook.md`](reports/runbook.md).

## Why this harness uses Node instead of stock k6

The repository retains the older k6 scripts under `load-tests/`, but stock k6 does not implement
browser `EventSource`. Its SSE option requires a separately compiled xk6 extension, and a
request-style emulation does not preserve thousands of browser-like reconnecting streams.

This framework therefore uses Node's core HTTP client: each simulated viewer owns a real,
incrementally parsed `text/event-stream` connection, honors `retry:` hints, recognizes comment
heartbeats, detects silent stalls, and reconnects with jittered exponential backoff. No client
metrics are fabricated. k6 remains useful for finite HTTP-only/staff tests; this runner is the
source of truth for SSE capacity.

## What one viewer does

1. Fetches the real `/tour/{token}` page document (optional for backend-only smoke tests).
2. Fetches `/api/public/realtime-config`.
3. Fetches the same one-shot tournament bundle used by the Next.js viewer.
4. Selects one card (round-robin unless `CARD_ID` is set).
5. Opens one public card SSE stream and keeps it alive.
6. Reconnects after drops/refusals and fails a heartbeat watchdog after prolonged silence.

An optional staff loop overwrites one match on a dedicated load-test card. That produces real
database work and public `result` events, allowing measurement of write latency and
write-to-viewer fan-out latency.

## Prerequisites

- Node.js 20+ (the application itself requires Node 22.13+)
- A tournament that is OPEN and contains at least one card
- A backend deployed with Spring Boot Actuator enabled (already integrated in this repository)
- An ADMIN username/password for authenticated Actuator metrics
- A sufficiently large load generator and open-file limit for high stages

Do not run against a live event. Use an equivalent staging deployment.

## Configure the backend for a capacity run

Normal production behavior is unchanged: `LOAD_TEST_MODE` defaults to `false`, and the
admin-managed production ceiling remains enforced.

On the isolated load-test backend only:

```text
LOAD_TEST_MODE=true
MAX_SSE_CONNECTIONS=10000
TOMCAT_MAX_CONNECTIONS=12000
```

`MAX_SSE_CONNECTIONS` changes only the public viewer admission cap. Staff SSE, realtime switches,
heartbeat, and reconnect settings keep their normal values. Startup emits a warning whenever the
override is active. Never leave the flag enabled on production after testing.

The authenticated Actuator endpoints expose:

- `sse.streams.public` and `sse.streams.staff`
- process/system CPU and CPU count
- Linux process RSS (real resident RAM), JVM heap/non-heap/direct buffers
- GC count/time/max pause and live threads
- Hikari active/pending/max connections
- Tomcat busy threads/current connections
- HTTP request count/time/max and server errors

On non-Linux local machines, process RSS stays unavailable rather than being faked; the report
labels the JVM-only memory fallback.

## Configure the runner

Copy the example (the resulting `.env` is ignored by git):

```bash
cp load-testing/.env.example load-testing/.env
```

Minimum production-shaped configuration:

```text
TOURNAMENT_URL=https://viewer.example.com/tour/my-event
PUBLIC_API_ORIGIN=https://api.example.onrender.com
BACKEND_ORIGIN=https://api.example.onrender.com
LOADTEST_ADMIN_USER=admin
LOADTEST_ADMIN_PASS=...
CONFIRM_PRODUCTION_LOAD=viewer.example.com,api.example.onrender.com
```

Important variables:

| Variable | Default | Purpose |
|---|---:|---|
| `STAGES` | `100,...,10000` | Increasing concurrent viewer targets |
| `RAMP_SECONDS` | `30` | Time used to add viewers at each stage |
| `SETTLE_SECONDS` | `10` | Stabilization wait after each ramp |
| `HOLD_SECONDS` | `90` | Steady hold after stabilization |
| `SAMPLE_SECONDS` | `5` | Actuator sampling cadence |
| `STOP_ON_FAIL` | `true` | Stop after the first unsafe stage |
| `FETCH_PAGE_DOCUMENT` | `true` | Include the real Next.js document request |
| `CARD_ID` | round-robin | Pin every viewer to one card |
| `RECONNECT_BASE_MS` / `RECONNECT_MAX_MS` | `2000` / `60000` | Client reconnect range |
| `HEARTBEAT_TIMEOUT_MS` | `90000` | Silent-stream watchdog |
| `LOADTEST_ADMIN_USER/PASS` | unset | Enables real backend metrics and sizing |
| `ACTIVITY_CARD_ID/MATCH_ID` | unset | Enables real staff result writes |
| `LOADTEST_STAFF_USER/PASS` | admin fallback | Credentials for optional writes |
| `CONFIRM_PRODUCTION_LOAD` | unset | Required comma-separated viewer/API/backend host confirmations |

Every threshold also has an environment override. See `config.ts` for names and defaults.

## Phase H — the snapshot cutover measurements

[The implementation plan's Phase H](../docs/PUBLIC_SNAPSHOT_IMPLEMENTATION_PLAN.md) asks for four
measurements before the published-viewer flag is turned on in production. They are driven from the
same harness, with a second scenario (`scenarios/snapshot-viewer.ts`) that mirrors the browser's
static-first path: derive `s/{h}.json` from the access token, fetch it from the CDN, and — on a 200 —
stop, having contacted neither Render nor Neon.

| Variable | Default | Purpose |
|---|---:|---|
| `SNAPSHOT_ORIGIN` | unset | CDN origin serving `/s/*.json`. Unset ⇒ no probe, no published viewers: this is the ① baseline |
| `FLEET` | `live` | `live`, `published`, or `mixed` |
| `PUBLISHED_TOKENS` | unset | Access tokens of tournaments that really are published. Required for `published`/`mixed` |
| `LIVE_TOKENS` | the `TOURNAMENT_URL` token | Live tournaments the live half of the fleet views |
| `PUBLISHED_VIEWER_SHARE` | `0.5` | Share of a `mixed` fleet assigned to published tournaments |
| `SNAPSHOT_PROBE_ON_LIVE` | on when `SNAPSHOT_ORIGIN` is set | Issue the probe on the live path — this is what ④ measures |
| `SNAPSHOT_PROBE_TIMEOUT_MS` | `1200` | Mirrors the browser's `PROBE_TIMEOUT_MS` |
| `BASELINE_RUN_DIR` | unset | A previous run directory to compare ① and ③ against |
| `THRESHOLD_MAX_PROBE_P95_MS` | `25` | Architecture §2.5(1)'s live-path budget |
| `THRESHOLD_MIN_EDGE_HIT_RATIO` | `0.95` | Architecture §2.5(2): 404 probes answered by the edge |

The recommended sequence is two runs — a baseline, then a mixed fleet compared against it:

```bash
# ① baseline: no snapshot origin, so the request sequence is exactly what it was before Phase H
FLEET=live npm run loadtest

# ②③④: 2 live + 2 published tournaments, judged against that baseline
FLEET=mixed \
SNAPSHOT_ORIGIN=https://snapshot.ct-we.com \
LIVE_TOKENS=live-cup-a,live-cup-b \
PUBLISHED_TOKENS=pub-cup-a,pub-cup-b \
BASELINE_RUN_DIR=load-testing/results/<baseline-run-id> \
npm run loadtest
```

The run refuses to start if any token in `PUBLISHED_TOKENS` does not actually resolve a snapshot
through the public hostname. That refusal is the point: without it, every published viewer would 404,
fail open onto the live path, and the run would report a "published fleet" that was never published.

### What each measurement can and cannot show

- ① and ② are behavioural and can be observed anywhere the two paths exist. Origin traffic is
  **counted** per fleet (`lib/request-ledger.ts`), never assumed, so a published viewer that falls
  back to the live path fails ② rather than passing it quietly.
- ③ needs authenticated Actuator metrics for the Caffeine hit ratio; without them it reports
  `NOT MEASURED`.
- **④a is a delta and therefore needs two runs.** The single-run signal — the probe's own p95, which
  is exactly what each live viewer additionally waits for, since the client awaits the probe before
  the bundle — is reported alongside, and both must hold. Without a probe-off baseline the report
  says the paired delta was not computed instead of implying it was. A baseline that itself probed is
  refused as a control.
- **④b is judged at steady state**, per §2.5(2). The first lookup of a key populates the edge's
  negative cache and is *expected* to MISS, so cold first-lookups are counted separately and excluded
  from the ratio; a run in which every key was probed exactly once reports `NOT MEASURED`, because the
  edge never had a repeat to answer.
- **④b can only be answered by a real Cloudflare edge.** With no edge in front of the bucket there is
  no `cf-cache-status` header, and the report says `NOT MEASURED` rather than inventing a ratio.
- A local or metrics-incomplete run **can never clear the Phase I gate**, however green its criteria
  look. The runbook says so explicitly.

`scripts/simulate-stack.ts` runs all three passes against three local stub servers. It exercises the
orchestrator, the ledger and the report end to end without any infrastructure — and it measures the
harness, not the system. Its latencies and its `cf-cache-status` values are whatever the stubs chose.

## Run with one command

From the repository root:

```bash
npm run loadtest
```

Useful variants:

```bash
# Read-only connectivity/settings check
npm run loadtest:preflight

# Short harness smoke test; this is not production capacity evidence
TOURNAMENT_URL=http://localhost:3000/tour/my-event \
PUBLIC_API_ORIGIN=http://localhost:8080 BACKEND_ORIGIN=http://localhost:8080 \
STAGES=1,2 RAMP_SECONDS=1 SETTLE_SECONDS=1 HOLD_SECONDS=5 SAMPLE_SECONDS=1 \
npm run loadtest

# Regenerate the report from the latest raw run
npm run loadtest:runbook
```

The runner raises its soft file-descriptor limit when the operating system permits it and fails
before load starts when the limit cannot fit the highest stage.

## Outputs

Each run writes ignored raw artifacts to:

```text
load-testing/results/<run-id>/
  stage-000100.json
  stage-000250.json
  ...
  run.json
```

The latest human report is always:

```text
load-testing/reports/runbook.md
```

A timestamped report is also produced locally and ignored by git.

The runbook reports:

- maximum viewer/SSE stage observed without failure
- recommended `maxSseConnections` (highest clean PASS, excluding NEAR LIMIT)
- recommended 80–100% operating band
- minimum current Render instance shape that keeps measured CPU and process RSS below 70%
- HTTP avg/p95/p99/errors/RPS
- SSE occupancy/connect latency/rejections/drops/stalls/reconnects
- event fan-out latency and staff write latency when enabled
- CPU, RSS, heap, non-heap, direct buffers, GC, threads, Tomcat, and Hikari
- per-stage reasons and production incident procedures

Local runs and runs without backend metrics are explicitly marked non-certifying. A test that
never reaches NEAR LIMIT or FAIL provides a lower bound, not a claimed maximum.

Render instance names/specifications follow the
[official Render compute plan table](https://render.com/docs/compute-plans); verify current plans
before purchasing.

## Safe test procedure

1. Use a staging deployment matching production instance, database, region, JVM, and cache config.
2. Ensure no real event is active and set `CONFIRM_PRODUCTION_LOAD` exactly.
3. Turn on the load-test override and set both SSE and Tomcat caps above the top test stage.
4. Use a dedicated tournament/card/account if staff activity is enabled.
5. Run the suite and keep Render/Neon dashboards open.
6. Stop if CPU/RAM/heap exceed thresholds, 5xx appears, Hikari pending grows, reconnects storm,
   or active streams cannot reach 99% of target.
7. Turn `LOAD_TEST_MODE` off after the run and redeploy/restart.

## Framework layout

```text
load-testing/
  config.ts
  runbook-generator.ts
  lib/
  scenarios/
  scripts/
  reports/
  results/
```

- `scenarios/viewer-sse.ts`: browser-compatible SSE viewer
- `scenarios/snapshot-viewer.ts`: static-first published viewer (Phase H), including its fail-open fallback
- `scenarios/staff-activity.ts`: optional real mutation load
- `lib/request-ledger.ts`: per-fleet destination accounting — the basis of the zero-Render claim
- `lib/snapshot-probe.ts` / `lib/snapshot-key.ts`: the probe and its object key, pinned to the browser's
- `scripts/simulate-stack.ts`: stub-stack self-test of the Phase H pipeline (proves nothing about production)
- `scripts/metrics-collector.ts`: authenticated Actuator sampling
- `scripts/orchestrator.ts`: staged ramp/hold/evaluation lifecycle
- `lib/evaluate.ts`: safety verdicts
- `runbook-generator.ts`: recommendations and production runbook
