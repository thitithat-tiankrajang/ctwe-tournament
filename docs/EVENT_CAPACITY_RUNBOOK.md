# Tournament event capacity runbook

Target: one active tournament, three cards, up to 400 players per card, ten staff sessions, and
5,000 or more simultaneous public viewers.

## Architecture

```text
Public browser -> Vercel CDN -> /api/public/** -> Render -> Caffeine -> Neon
Staff browser  -> Vercel proxy -> /api/cards/** + SSE -> Render -> Neon
Render -> browser vendor push service -> subscribed devices (publication events only)
```

Only `/api/public/**` is CDN-cacheable. Authentication, sessions, CSRF, mutations, staff card
responses, and SSE are never shared-cacheable. `public_version` changes only when anonymous viewers
can observe new data.

## One week before

0. If `V19__storage_diet.sql` (or any migration) has not been applied to production yet, take a
   `pg_dump` first, deploy on a quiet day, and verify one full card workflow end-to-end after boot.
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

## SSE-only capacity (runtime-tunable)

Live streams are hard-capped so they can never exhaust the Tomcat connector (`max-connections: 2000`)
and freeze mutations. All realtime knobs live in the `runtime_settings` table and are managed from
**admin console → Realtime (SSE only)** — changes apply within seconds, no redeploy:

- Realtime/SSE on-off switches, Max SSE Connections (viewers, default 1,500; staff, default 300),
  Heartbeat Interval (default 25 s), and Reconnect Delay (default 2 s). Browsers read
  `/api/public/realtime-config` once per page load.
- Cap and switch changes affect NEW subscriptions only — established streams never drop.
- Over-cap or switched-off subscribers receive 503 and do not receive live updates. There is no
  polling fallback; scale the backend before raising the cap.
- The heartbeat prunes silently dead connections (mobile drops) within one interval instead of
  leaking them until the 45-minute stream timeout; every pruned stream frees a capacity slot.
- All SSE socket writes happen on one dedicated `sse-send` thread with a bounded queue, so a stalled
  viewer connection can never block a staff result-save request thread.
- On deploy shutdown all streams are completed cleanly so browsers reconnect to the new instance.
- Live occupancy: admin Realtime panel, or `/actuator/metrics/sse.streams.public|staff`.

If Render connection counts approach the connector limit during the event, scale the Render service.
Lowering “Max SSE Connections (viewers)” protects staff mutations but excess viewers will not receive
live updates.

Certification load tests live in `load-tests/suite/`; use the SSE-capable runner when certifying the
production path.

## Web Push capacity and privacy

- Web Push sends one small payload per subscribed endpoint only when Pairing/Ranking is published,
  a final starts, or a card finishes. It creates no always-open connection and no extra viewer poll.
- A viewer subscribed at both tournament and card level still receives one delivery per event
  because endpoints are deduplicated before fan-out.
- Delivery runs outside the staff request on four bounded worker threads. Push-service slowness
  cannot hold a result-save request or exhaust Tomcat threads.
- Remove endpoint rows on HTTP 404/410, explicit unsubscribe, browser expiration, card deletion, or
  tournament archival. Never log endpoint URLs or encryption keys.
- Keep production VAPID keys stable. Rotating them invalidates existing browser subscriptions.

## After the event

1. Export/archive the tournament and verify the file.
2. Save Vercel, Render, and Neon usage screenshots and peak metrics.
3. Reduce Render back to Starter after traffic has ended.
4. Compare actual payload bytes and request counts with the load-test report.
