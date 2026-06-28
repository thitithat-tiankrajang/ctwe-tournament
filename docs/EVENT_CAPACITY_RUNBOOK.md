# Tournament event capacity runbook

Target: one active tournament, three cards, up to 400 players per card, ten staff sessions, and
5,000 or more simultaneous public viewers.

## Architecture

```text
Public browser -> Vercel CDN -> /api/public/** -> Render -> Caffeine -> Neon
Staff browser  -> Vercel proxy -> /api/cards/** + SSE -> Render -> Neon
```

Only `/api/public/**` is CDN-cacheable. Authentication, sessions, CSRF, mutations, staff card
responses, and SSE are never shared-cacheable. `public_version` changes only when anonymous viewers
can observe new data.

## One week before

1. Create a staging copy with three cards and generate 400 players in each card.
2. Complete enough games to make the public card payload representative of the final day.
3. Run public tests at 100, 500, 1,000, 2,500, then 5,000 viewers.
4. Run ten staff result writers while at least 2,500 public viewers remain active.
5. Confirm Vercel responses show `x-vercel-cache: HIT` or `STALE` after warm-up.
6. Confirm unpublished scores and final-round data never appear in `/api/public/**`.
7. Back up Neon and verify the restore on a separate branch.

## Pass criteria

- Public error rate below 0.1%.
- Public p95 below 1 second and p99 below 2 seconds.
- Staff result-save p95 below 1.5 seconds and p99 below 2.5 seconds.
- No missing result after SSE reconnect/reconciliation.
- Render memory stays below 75% and CPU stays below 70% during the steady phase.
- Hikari pending connections remain zero and active connections remain below the configured maximum.
- Caffeine detail/catalog hit rate exceeds 95% after warm-up.
- Render receives cache misses, not traffic proportional to 5,000 viewers.

## Event-day procedure

1. Freeze deployments and schema changes.
2. Temporarily change Render from Starter to Standard (2 GB RAM / 1 CPU).
3. Confirm `/actuator/health/readiness` returns `UP`.
4. Warm `/api/public/cards`, every active `/api/public/cards/{id}`, and `/api/public/cards/versions`.
5. Open one staff session per card and confirm SSE reconnects after a network interruption.
6. Watch Render CPU/memory/restarts, Neon compute/connections, Vercel cache hit ratio, HTTP 5xx,
   response size, and outbound bandwidth.
7. Keep one operator responsible for infrastructure; result-entry staff should not deploy.

## Rollback triggers

- Memory above 85% for five minutes.
- Any repeated JVM restart or readiness failure.
- Public or staff error rate above 1%.
- Database pool waits or save p95 above 2.5 seconds.

Roll back to the last known deployment, keep the CDN serving the last published state, and pause new
workflow transitions until staff writes are healthy. Do not scale to multiple Render instances:
staff SSE and in-memory event delivery currently assume one application instance.

## After the event

1. Export/archive the tournament and verify the file.
2. Save Vercel, Render, and Neon usage screenshots and peak metrics.
3. Reduce Render back to Starter after traffic has ended.
4. Compare actual payload bytes and request counts with the load-test report.
