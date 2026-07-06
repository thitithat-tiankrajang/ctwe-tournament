# 5,000-viewer SSE soak test

This test models one public browser as:

1. load the private tournament page;
2. resolve the tournament token;
3. load the public catalog, realtime config, and one published card;
4. keep one dedicated SSE connection open;
5. reconnect with jittered exponential backoff if the stream drops.

It never polls. The final 5,000-viewer stage holds indefinitely until `Ctrl+C`.

## Before running

The tournament must contain at least one **published** card. Preflight is read-only:

```bash
./load-tests/run-viewer-soak.sh --preflight
```

The current backend repository has two independent connection limits:

- Admin → Realtime → Max SSE Connections (viewers)
- `server.tomcat.max-connections`, currently `2,000`

Both must exceed 5,000 before a 5,000-SSE certification can pass. Keep headroom for staff,
health checks, and ordinary API calls; do not set either limit to exactly 5,000.

Also open the Render, Neon, and Cloudflare dashboards before starting. A test from one laptop
uses one source IP and one geographic location, so it is a strong origin-capacity test but not a
perfect model of globally distributed browsers.

## Start and stop

```bash
CONFIRM_PRODUCTION_LOAD=ct-we.com ./load-tests/run-viewer-soak.sh
```

Default ramp:

```text
100 / 30s → 500 / 1m → 1,000 / 1m → 2,500 / 2m → 5,000 / 3m → hold
```

Override it when isolating the first failing level:

```bash
STAGES="30s:100,2m:500,3m:1000" \
CONFIRM_PRODUCTION_LOAD=ct-we.com ./load-tests/run-viewer-soak.sh
```

Press `Ctrl+C` once for a graceful stop. A second `Ctrl+C` forces exit.

## Live output

Every five seconds the runner prints:

- desired, opening, current, and peak SSE viewers;
- rejected, dropped, and reconnect counts;
- received events and p95 connect/event latency;
- load-generator RSS and event-loop delay (to detect a bottleneck on the laptop).

Artifacts are written to `load-tests/out/soak/`:

- `*.jsonl`: five-second timeline for graphs or later analysis;
- `*.summary.json`: totals, HTTP statuses, errors, and p50/p95/p99/max latency.

At the same timestamps, inspect:

- Render: CPU, memory, instance restarts, bandwidth, and response 5xx;
- Spring Actuator: `sse.streams.public`, JVM memory, Tomcat sessions, Hikari active/pending;
- Neon: CPU, connections, working set, and query latency;
- Cloudflare: Worker requests, origin requests, cache status, and 5xx.

Stop and investigate if errors exceed 1%, Render memory stays above 85%, CPU stays above 80%,
Hikari pending is non-zero, the JVM restarts, or the generator itself exceeds 80% CPU / 90% RAM.
