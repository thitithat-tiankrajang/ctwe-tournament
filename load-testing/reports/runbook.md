# CTWE production performance runbook

Generated from real run `2026-08-16T22-55-56` on 2026-08-16T23:00:26.519Z.

## Executive recommendation

- **Run classification:** production/staging capacity evidence
- **Maximum concurrent viewers observed without hard failure:** 250 viewers / 250 active SSE
- **Recommended `maxSseConnections`:** 100
- **Recommended operating range:** 80–100 concurrent SSE viewers
- **Recommended minimum Render instance:** Standard — 1 CPU / 2 GB RAM
- **Boundary confidence:** A near-limit or failing boundary was observed.
- **Test stopped early:** no

Reasoning:

- The SSE recommendation uses the highest clean PASS stage; NEAR LIMIT stages are intentionally excluded from production headroom.
- Measured 0.36 CPU cores and 388 MiB process RSS; sizing keeps both below 70%.
- CPU, heap, GC, threads, Hikari, Tomcat, and SSE occupancy come from authenticated Spring Boot Actuator metrics. Process RAM uses Linux kernel RSS when available.

## Stage results

| Viewers | Active SSE | CPU max | Process RAM | Heap max | HTTP avg / p95 / p99 | SSE connect p95 / p99 | HTTP errors | Reconnects | Viewer HTTP RPS | Verdict |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|
| 100 | 100 | 36.1% | 388 MiB | 118 MiB | 47 ms / 86 ms / 267 ms | 87 ms / 175 ms | 0 | 0 | 3 | **PASS** |
| 250 | 250 | 29.1% | 393 MiB | 126 MiB | 39 ms / 78 ms / 123 ms | 146 ms / 178 ms | 0 | 0 | 4.4 | **NEAR LIMIT** |

Errors in the table combine finite HTTP failures with SSE rejections, drops, and stalls.

## Backend resource detail

| Viewers | GC pauses / total | Longest GC | Threads | Tomcat busy / conn | Hikari active / pending / max | Events | Fan-out p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 5 / 0.764 s | 319 ms | 52 | 7 / 340 | 0 / 0 / 5 | 100 | — |
| 250 | 3 / 0.026 s | 319 ms | 52 | 5 / 269 | 0 / 0 / 5 | 150 | — |

## Phase H — snapshot cutover measurements

- **Fleet:** `live`
- **Snapshot origin:** https://snapshot.ct-we.com/
- **Probe on the live path:** yes, 1200 ms timeout
- **Live tournaments:** `stg-live-a`, `stg-live-b`
- **Published tournaments:** `stg-pub-c`, `stg-pub-d`
- **Baseline run:** `2026-08-16T22-51-11`

| # | Measurement | Status | Evidence |
|:--|:--|:--|:--|
| ① | Baseline — live tournament, today's numbers | **PASS** | Taken from baseline run `2026-08-16T22-51-11`: live p95-to-first-data 218 ms. |
| ② | Published fleet — zero Render requests, zero SSE connections | **NOT MEASURED** | No published viewers in this fleet (FLEET=live). |
| ③ | Mixed fleet — live cache hit ratio improves, live p95 does not regress | **NOT MEASURED** | This run's fleet is `live`; ③ needs FLEET=mixed. |
| ④a | Live-path p95-to-first-data does not regress (hard gate on Phase I) | **PASS** | Live p95-to-first-data 205 ms with the probe vs 218 ms without (Δ -13 ms, budget 25 ms), baseline run `2026-08-16T22-51-11`. Per-viewer added latency: PASS — p95 17 ms (avg 16.2 ms, max 202 ms) over 150 probe(s). |
| ④b | 404 probes served from the Cloudflare edge (hard gate on Phase I) | **PASS** | 148/148 repeat 404 lookups were edge HITs (100%); statuses: HIT=148. Excluded 2 cold first-lookup(s) (HIT=2), which populate the negative cache and are expected to MISS. |

**Phase I gate (④):** satisfied by this run.

### Per-stage snapshot metrics

| Viewers | Live / published | Probes (200 / 404 / timeout / error) | Probe p95 | Live first data p95 | Published first data p95 | Published Render req | Published SSE | Edge status (404) | Cache hit ratio |
|---:|---:|---:|---:|---:|---:|---:|---:|:--|---:|
| 100 | 100 / 0 | 0 / 100 / 0 / 0 | 17 ms | 351 ms | — | 0 | 0 | HIT=98 | 99% |
| 250 | 250 / 0 | 0 / 150 / 0 / 0 | 17 ms | 205 ms | — | 0 | 0 | HIT=148 | 100% |

## Threshold findings

- **250 viewers — NEAR LIMIT:**
  - Warning: heap usage at 86% of its budget

## Test identity and method

- Tournament: **stg-live-a** (`176d5c4a-d050-4605-9b93-adc5dda5e05f`)
- Viewer page: `https://ct-we.com/tour/stg-live-a`
- Public API: `https://ctwe-backend-staging.onrender.com/`
- Backend metrics origin: `https://ctwe-backend-staging.onrender.com/`
- Cards distributed across viewers: `5db5cc0a-a543-468d-9634-85a3db5853f9`, `6ac54787-ed4d-4951-b51b-5c78de80513e`
- Effective backend SSE cap at preflight: 1500
- Heartbeat interval: 25000 ms
- Stages: 100 → 250
- Per-stage timing: 30s ramp + 10s settle + 90s hold
- Staff result activity: disabled
- Raw result directory: `/Users/thitithat_tiankrajang/Desktop/CTWE/load-testing/results/2026-08-16T22-55-56`

Each viewer fetches the real tournament document, realtime config, and one-shot tournament bundle, then holds one EventSource-compatible SSE connection for its selected card. The harness parses SSE frames, honors server retry hints, watches heartbeats, and reconnects with capped jittered backoff.

## Production operating procedure

### Before an event

1. Run the full suite against a staging deployment with the same Render instance type, JVM flags, database plan, cache settings, and network path as production.
2. Set `LOAD_TEST_MODE=true`, `MAX_SSE_CONNECTIONS` at least 20% above the highest stage, and `TOMCAT_MAX_CONNECTIONS` at least 20% above that. Never enable load-test mode on an event currently serving real viewers.
3. Use an OPEN tournament with published cards. If fan-out latency is required, use a dedicated `RESULT_COLLECTION` card and dedicated staff account.
4. Confirm Render, Neon, and application dashboards are open. Record deployment ID, instance type, DB plan, region, and test-generator location.
5. Run `npm run loadtest`. Do not certify from a local smoke run or a run without Actuator metrics.

### Production configuration

- Start with `maxPublicSseConnections=100`.
- Set Tomcat max connections to at least `120` so staff/API/health traffic retains headroom.
- Keep heartbeat below proxy idle timeouts and above the level that creates excessive fan-out work; the measured value is shown above.
- Keep `LOAD_TEST_MODE=false` in normal production. The admin-managed cap and its production ceiling remain authoritative.

### Live stop conditions

- CPU remains above 75%, process RAM above 70%, or heap above 70% of max for two samples.
- Any sustained HTTP 5xx, growing SSE drops/stalls, or reconnect churn above the configured threshold.
- Hikari pending connections become non-zero, GC pauses exceed 1 second, or Tomcat busy threads/connections stop recovering.
- Active SSE no longer reaches 99% of target after the settle window.

### Incident response

1. **Reconnect storm:** stop result-generating traffic, confirm heartbeats and proxy timeouts, then lower admission cap only for new streams. Do not restart repeatedly.
2. **SSE capacity rejection:** viewers retry automatically; preserve capacity for staff writes and raise the cap only when Tomcat, CPU, and RAM headroom all permit it.
3. **Memory pressure:** capture heap/native-memory diagnostics, reduce the admission cap, and vertically scale. RSS materially above heap+nonheap usually indicates native buffers, thread stacks, or libraries.
4. **Database pressure:** if Hikari pending is non-zero, inspect Neon latency/connections before increasing the pool. More pool connections can amplify database contention.
5. **Backend replacement/redeploy:** drain gracefully; established EventSource clients reconnect. Watch reconnect rate and 5xx until active streams recover.

## Interpretation limits

- One load generator represents one source region/IP and can itself become the bottleneck at very high socket counts; repeat from a suitably sized runner or distributed runners.
- Render dashboard host metrics and Neon metrics should corroborate Actuator. This report never fabricates missing values.
- A highest PASS with no following NEAR LIMIT/FAIL is a tested lower bound, not the true maximum.
- Render instance names/specs are based on the official compute-plan table checked 2026-07-06; verify the current table before purchasing.
