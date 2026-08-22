# SECURITY-01 — Anonymous `GET /api/cards` exposes every card and roster platform-wide

**Carved out of the UX/data refactor on 2026-08-22 by owner instruction.** This is tracked here as a
standalone pre-existing security/privacy issue. It is **not** part of P0, P1 or any later phase, and
**must not be fixed as part of the refactor**. It requires an owner decision on its own timeline.

Origin: `04_BLOCKERS.md` B7 · runtime evidence `06_P0_RUNTIME_BASELINE.md` R2, R7, R12.
Those documents are frozen; this file is the live owner-facing record.

---

## 1. What it is

`GET /api/cards` returns **200 / 59,669 bytes** to a caller with no session and no token: all 5 cards
across both local tournaments, each carrying its **full player roster** — first name, surname, school
(109 player records locally).

The public projection is applied correctly — `rules`, `tables`, `audit` and an unpublished
`finalRound` are stripped (`PublicCardProjection`). The defect is **upstream of the projection**:
the catalog it draws from has no filter at all.

`PublicCardReadCache.summaries()` (`backend/.../application/PublicCardReadCache.java:34-56`) is:

```sql
FROM tournament_cards c
ORDER BY c.created_at DESC
```

No `WHERE`. No tournament filter, no status filter, no published filter.

## 2. Why it matters — the contrast

The token-scoped viewer path **does** enforce closure:
`TenantService.resolveOpenTournament` ends `WHERE t.access_token = ? AND t.status = 'OPEN'`.

So decision **D18** ("closing the link hides live data") is correctly implemented for `/tour/{token}`
and is **bypassed** by `/api/cards`. Verified live: `/tour/bkk` renders 4 cards; `/api/cards`
returns all 5, including cards from a tournament that is not published and never was.

Aggravating: `TenantService.java:46` accepts an access token as short as **3 characters**, and one
local tournament genuinely uses `bkk`.

## 3. Reachability — VERIFIED internet-reachable

No layer of the production request path filters anything:

| Layer | Finding |
|---|---|
| `src/app/api/[...path]/route.ts` | catch-all; binds every method to `proxyToRender`. No path list |
| `src/infrastructure/http/render-backend-proxy.ts:27` | `upstream.pathname = incoming.pathname` — forwarded verbatim. No allow/deny list |
| `middleware.ts` | **does not exist** anywhere in the repo |
| `open-next.config.ts` | bare `defineCloudflareConfig()` — no routing overrides |
| `wrangler.jsonc` | serves the Next app; `workers_dev: true` |

Proven end-to-end through the same route production uses, anonymously:

```
curl http://localhost:3000/api/cards
-> 200, 59,669 bytes | cards: 5 | tournaments: 2 | player records: 109
```

`CORS_ALLOWED_ORIGINS` does **not** mitigate this — CORS constrains browsers, not `curl`. Note also
that `ctwe-tournament-api` is a Render `type: web` service and therefore has its own public hostname
in addition to the Worker.

**The only thing that could still block it is a rule outside this repository** (e.g. a Cloudflare WAF).
Only the owner can confirm that. Until confirmed, treat as a live exposure.

## 4. Scope note — the app does not depend on this endpoint for the viewer

`06_P0_RUNTIME_BASELINE.md` R7 corrected an earlier conflation:

| Endpoint | Bytes | Player records | Used by the app? |
|---|---|---|---|
| `GET /api/public/cards` | 1,744 | **0** | **yes** — this is what the UI calls |
| `GET /api/cards` (anonymous) | 59,669 | **109** | **no flow observed calls it anonymously** |

That narrows the issue: it is an **exposed endpoint an attacker could call directly**, not something
the UI leaks on every page load. It does not make it smaller in blast radius, but it does mean the
viewer experience does not obviously depend on the anonymous branch of `CardController.list()`.

## 5. Interaction with session eviction (B4 / R12)

Because `GET /api/cards` is `permitAll`, a staff session **evicted** by `maximumSessions(2)` does not
receive a 401 there — it silently receives the anonymous public projection, including the **public**
version and stage instead of the staff ones (measured: staff `version = 11` vs `public_version = 7`;
real stage `PAIRING_PREVIEW` vs public stage `TABLE_PAIRING`).

Assessed **LOW** severity today because three independent defences cover it (`04_BLOCKERS.md` B4).
Recorded here because it is the same root cause.

## 6. Decision required from the owner

Nothing below is being actioned. These are the options as understood from source:

| Option | Change | Risk |
|---|---|---|
| **A. Confirm an external WAF already blocks it** | none in this repo | zero code risk; needs owner to verify Cloudflare config |
| **B. Tighten the security matcher** | remove `permitAll()` from `GET /api/cards` at `SecurityConfiguration.java:110` | **breaks the anonymous branch at `CardController.list():53`** — must first confirm nothing viewer-facing depends on it (R7 suggests nothing does, but that is observation, not proof) |
| **C. Filter the catalog** | add a tournament status/published `WHERE` to `PublicCardReadCache.summaries()` | touches the cached read model shared by the viewer bundle; needs its own regression pass against Invariant C |
| **D. Accept for this competition** | none | documented residual risk |

**Recommendation: decide before the competition, independently of the refactor.** Changing anonymous
data exposure three weeks out is an owner call, not an agent call.

## 7. Status

```
OPEN — pre-existing — not introduced by the refactor — no owner decision recorded yet
```
