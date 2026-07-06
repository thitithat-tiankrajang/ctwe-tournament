# CTWE production performance runbook

Generated from real run `2026-07-06T13-31-34` on 2026-07-06T13:31:52.371Z.

## Executive recommendation

- **Run classification:** LOCAL/INCOMPLETE SMOKE RUN — validates the harness, not production capacity
- **Maximum concurrent viewers observed without hard failure:** 2 viewers / 2 active SSE
- **Recommended `maxSseConnections`:** not available
- **Recommended operating range:** not available
- **Recommended minimum Render instance:** Not certifiable from this run
- **Boundary confidence:** Only a lower bound was measured; extend STAGES until NEAR LIMIT/FAIL before treating this as a maximum.
- **Test stopped early:** no

Reasoning:

- The SSE recommendation uses the highest clean PASS stage; NEAR LIMIT stages are intentionally excluded from production headroom.
- Render sizing and production SSE recommendations are intentionally withheld for local or metrics-incomplete runs.
- CPU, heap, GC, threads, Hikari, Tomcat, and SSE occupancy come from authenticated Spring Boot Actuator metrics. Process RAM uses Linux kernel RSS when available.

## Stage results

| Viewers | Active SSE | CPU max | Process RAM | Heap max | HTTP avg / p95 / p99 | SSE connect p95 / p99 | HTTP errors | Reconnects | Viewer HTTP RPS | Verdict |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|
| 1 | 1 | 1.3% | — | 97 MiB | 26 ms / 69 ms / 69 ms | 3 ms / 3 ms | 0 | 0 | 0.4 | **PASS** |
| 2 | 2 | 44.3% | — | 92 MiB | 12 ms / 25 ms / 25 ms | 2 ms / 2 ms | 0 | 0 | 0.4 | **PASS** |

Errors in the table combine finite HTTP failures with SSE rejections, drops, and stalls.

## Backend resource detail

| Viewers | GC pauses / total | Longest GC | Threads | Tomcat busy / conn | Hikari active / pending / max | Events | Fan-out p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 / 0.01 s | 10 ms | 39 | 23 / 26 | 0 / 0 / 10 | 1 | — |
| 2 | 1 / 0.005 s | 10 ms | 39 | 9 / 28 | 0 / 0 / 10 | 1 | — |

## Threshold findings

- No threshold breaches or near-limit warnings were recorded.

## Test identity and method

- Tournament: **TestVerseCase** (`5be7e391-75b5-4b3b-91a0-d28fd7b4af03`)
- Viewer page: `http://localhost:13000/tour/44c9918b95d1432990ab4d6827d4fdd5`
- Public API: `http://localhost:18080/`
- Backend metrics origin: `http://localhost:18080/`
- Cards distributed across viewers: `cdea06b8-761b-424c-861e-e79706321284`
- Effective backend SSE cap at preflight: 20
- Heartbeat interval: 25000 ms
- Stages: 1 → 2
- Per-stage timing: 1s ramp + 1s settle + 6s hold
- Staff result activity: disabled
- Raw result directory: `/Users/thitithat_tiankrajang/Desktop/CTWE/load-testing/results/2026-07-06T13-31-34`

Each viewer fetches the real tournament document, realtime config, and one-shot tournament bundle, then holds one EventSource-compatible SSE connection for its selected card. The harness parses SSE frames, honors server retry hints, watches heartbeats, and reconnects with capped jittered backoff.

## Production operating procedure

### Before an event

1. Run the full suite against a staging deployment with the same Render instance type, JVM flags, database plan, cache settings, and network path as production.
2. Set `LOAD_TEST_MODE=true`, `MAX_SSE_CONNECTIONS` at least 20% above the highest stage, and `TOMCAT_MAX_CONNECTIONS` at least 20% above that. Never enable load-test mode on an event currently serving real viewers.
3. Use an OPEN tournament with published cards. If fan-out latency is required, use a dedicated `RESULT_COLLECTION` card and dedicated staff account.
4. Confirm Render, Neon, and application dashboards are open. Record deployment ID, instance type, DB plan, region, and test-generator location.
5. Run `npm run loadtest`. Do not certify from a local smoke run or a run without Actuator metrics.

### Production configuration

- Start with `maxPublicSseConnections=<highest clean PASS>`.
- Set Tomcat max connections to at least `ceil(maxSseConnections × 1.20)` so staff/API/health traffic retains headroom.
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
