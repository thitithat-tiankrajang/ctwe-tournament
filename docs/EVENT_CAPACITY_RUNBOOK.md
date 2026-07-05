# Tournament event capacity runbook

Target: one active tournament, three cards, up to 400 players per card, ten staff sessions, and
thousands of simultaneous public viewers — on Cloudflare Workers free tier (100k Worker
requests/day) and a small Render instance with limited outbound bandwidth.

## Architecture

```text
Public browser -> Cloudflare Worker (page shells + static assets only)
               -> Render /api/public/** + public SSE  (DIRECT, CORS, no Worker hop)
                    -> Caffeine -> Neon

Staff browser  -> Cloudflare Worker proxy (same-origin session cookies)
               -> /api/cards/** + staff SSE -> Render -> Neon

Render -> browser vendor push service -> subscribed devices (publication events only)
```

Anonymous viewer data traffic bypasses the Worker completely: the build-time variable
`NEXT_PUBLIC_PUBLIC_API_ORIGIN` points `/api/public/**` fetches and the public EventSource straight
at the backend origin. Staff traffic stays same-origin through the Worker proxy because it needs
`Secure`/`HttpOnly` session cookies and CSRF.

### Why this fits the free tiers

- **Cloudflare Workers free = 100,000 Worker requests/day.** Static assets (`/_next/static/*`,
  icons, service worker) are free and unlimited and never invoke the Worker. After the bypass, a
  viewer costs the Worker only page-shell loads (a few requests per session) instead of
  catalog + card + realtime-config + SSE (+ every SSE reconnect + every publish refetch).
- **Render bandwidth** is protected by: gzip (`server.compression`), ETag/304 revalidation,
  version-keyed immutable card responses (`?v=` URLs cache forever in the browser), SSE result
  patches instead of full refetches during result entry, and jittered refetches on publish events.

### Request budget (per viewer, typical competition day)

| Traffic | Path | Worker requests | Render requests |
| --- | --- | --- | --- |
| Page shell + assets | Worker + free assets | ~2–4 per visit | 0 |
| Catalog + card + config | direct CORS | 0 | 3 per visit |
| SSE stream | direct CORS | 0 | 1 per 45 min |
| Result updates | SSE patch | 0 | 0 (pushed in-stream) |
| Pairing/ranking publishes | jittered refetch | 0 | ~1 per publish |

Even 5,000 viewers stay far below the Worker cap; the Worker budget is consumed almost entirely by
page loads. Watch the Cloudflare dashboard request graph during the event; if it trends toward the
cap, the cause is page reload loops, not data traffic.

## Custom-domain upgrade path (optional, strongest setup)

On `*.workers.dev` there is no shared CDN cache. If a custom domain on a Cloudflare zone becomes
available:

1. Add a proxied (orange-cloud) DNS record, e.g. `api.<domain>`, pointing at the Render service,
   and add `api.<domain>` as a custom domain on the Render service so it accepts the Host header.
2. Cache Rule for `api.<domain>/api/public/*`: "Eligible for cache", honor origin Cache-Control.
   The backend already emits `s-maxage` + `stale-while-revalidate` and immutable `?v=` responses,
   so cache hits then never touch Render at all (bandwidth ≈ misses only). SSE passes through
   uncached (`no-store`).
3. Rebuild the frontend with `NEXT_PUBLIC_PUBLIC_API_ORIGIN=https://api.<domain>` and add that
   page origin to `CORS_ALLOWED_ORIGINS` if the site hostname changed.

No code change is needed — only the origin env var and DNS/cache configuration.

## One week before

1. Create a staging copy with three cards and generate 400 players in each card.
2. Complete enough games to make the public card payload representative of the final day.
3. Run public tests at 100, 500, 1,000, 2,500, then 5,000 viewers (suite in `load-tests/suite/`),
   pointed at the DIRECT public origin, not the Worker.
4. Run ten staff result writers while at least 2,500 public viewers remain active.
5. Verify in the browser network tab that public data requests go to the public origin (not
   `/api/...` on the site origin) and that `?v=` card responses return
   `Cache-Control: public, max-age=31536000, immutable`.
6. Confirm unpublished scores and final-round data never appear in `/api/public/**`.
7. Back up Neon and verify the restore on a separate branch.

## Pass criteria

- Public error rate below 0.1%.
- Public p95 below 1 second and p99 below 2 seconds.
- Staff result-save p95 below 1.5 seconds and p99 below 2.5 seconds.
- No missing result after SSE reconnect/reconciliation.
- Publishing a ranking/pairing reaches an open viewer page within the jitter window (≤ ~5 s)
  without a manual reload.
- Render memory stays below 75% and CPU stays below 70% during the steady phase.
- Hikari pending connections remain zero and active connections remain below the configured maximum.
- Caffeine detail/catalog hit rate exceeds 95% after warm-up.

## Event-day procedure

1. Freeze deployments and schema changes.
2. Temporarily upgrade Render (e.g. Standard 2 GB / 1 CPU) and raise
   "Max SSE Connections (viewers)" in admin → Realtime to match the expected audience
   (each stream holds one Tomcat connection; `server.tomcat.max-connections` is 2000).
3. Confirm `/actuator/health/readiness` returns `UP`.
4. Warm `/api/public/cards`, every active `/api/public/cards/{id}`, and `/api/public/cards/versions`.
5. Open one staff session per card and confirm SSE reconnects after a network interruption.
6. Watch: Render CPU/memory/restarts, Neon compute/connections, Cloudflare Worker request count
   vs the 100k/day cap, HTTP 5xx, response size, outbound bandwidth,
   `/actuator/metrics/sse.streams.public|staff`.
7. Keep one operator responsible for infrastructure; result-entry staff should not deploy.

## Rollback triggers

- Memory above 85% for five minutes.
- Any repeated JVM restart or readiness failure.
- Public or staff error rate above 1%.
- Database pool waits or save p95 above 2.5 seconds.

Roll back to the last known deployment, keep browsers serving the last published state, and pause
new workflow transitions until staff writes are healthy. Do not scale to multiple Render instances:
staff SSE and in-memory event delivery assume one application instance.

## SSE-only capacity (runtime-tunable)

Live streams are hard-capped so they can never exhaust the Tomcat connector and freeze mutations.
All realtime knobs live in the `runtime_settings` table and are managed from
**admin console → Realtime** — changes apply within seconds, no redeploy:

- Realtime/SSE on-off switches, Max SSE Connections (viewers, default 1,500; staff, default 300),
  Heartbeat Interval (default 25 s), Reconnect Delay (default 2 s), and the polling fallback
  switch + interval. Browsers read `/api/public/realtime-config` once per page load.
- Cap and switch changes affect NEW subscriptions only — established streams never drop.
- Over-cap subscribers receive 503. Since the SSE hardening pass, refused viewers no longer
  freeze: the page retries the subscription with jittered backoff and, while disconnected, polls
  the tiny `/api/public/cards/versions` endpoint (ETag/304) so published data still arrives.
  Refused-viewer polling is intentionally independent of the admin polling switch; the switch
  governs the "SSE off, polling instead" mode.
- Every staff mutation that changes anonymous-visible data now notifies viewer streams (rankings
  publish, pairing confirm, overrides, penalties, player edits, terminations, the final round,
  card deletion) — not only result entry and publish-next.
- The heartbeat prunes silently dead connections within one interval; every pruned stream frees a
  capacity slot. All SSE socket writes happen on one dedicated `sse-send` thread with a bounded
  queue, so a stalled viewer connection can never block a staff result-save request thread.
- On deploy shutdown all streams complete cleanly so browsers reconnect to the new instance.

## Web Push capacity and privacy

- Web Push sends one small payload per subscribed endpoint only when Pairing/Ranking is published,
  a final starts, or a card finishes. It creates no always-open connection and no extra viewer poll.
- Endpoints are deduplicated before fan-out; delivery runs outside the staff request on four
  bounded worker threads.
- Remove endpoint rows on HTTP 404/410, explicit unsubscribe, browser expiration, card deletion, or
  tournament archival. Never log endpoint URLs or encryption keys.
- Keep production VAPID keys stable. Rotating them invalidates existing browser subscriptions.

## After the event

1. Export/archive the tournament and verify the file.
2. Save Cloudflare, Render, and Neon usage screenshots and peak metrics.
3. Reduce Render back to the small instance after traffic has ended.
4. Compare actual payload bytes and request counts with the load-test report.
