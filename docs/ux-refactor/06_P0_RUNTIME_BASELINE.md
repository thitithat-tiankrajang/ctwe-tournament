# P0 — Runtime Baseline

**STATUS: PARTIAL.** Everything reachable **without credentials** is captured. The rest is blocked —
see §7.

Captured 2026-08-22 against the running local stack at baseline commit `6ce756c`.
Owner decision A in force: **isolated data only** — existing rows were read, never written.

| Component | State during capture |
|---|---|
| Postgres | `ctwe-postgres-1`, postgres:17-alpine, healthy |
| Backend | `localhost:8080`, already running |
| Frontend | `localhost:3000`, `next dev`, already running |
| `NEXT_PUBLIC_SNAPSHOT_ORIGIN` | **unset locally** (`.env` has only the six DB/staff/session keys) |

### Pre-existing data — read-only, and proven untouched

`tournaments=2, tournament_cards=5, players=109, games=22, matches=133, standings=109`
— identical before and after every measurement below. Nothing was created, modified or deleted.

Accounts present: `staff` (ADMIN), `ittest` (ADMIN), `direct001` (DIRECTOR), `staff001` (STAFF).

### Method note — a contaminant had to be removed first

Statement counts were taken by enabling `log_min_duration_statement = 0` via `ALTER SYSTEM` +
`pg_reload_conf()` (**no restart**, no data change) and counting logged statements per request.
**The setting has been reset to `default` (`-1`); the database is exactly as it was found.**
`pg_stat_statements` was rejected because it requires `shared_preload_libraries` and a DB restart.

The raw counts were wrong until R1 was found and excluded — see below.

---

## R1 — A permanent 5-second database poller runs with zero users. **VERIFIED**

**Evidence.** A 20-second window with **no HTTP requests at all** logged 12 statements — one group
of three every 5 seconds, forever, on one pooled connection:

```
02:24:49.060 [pid 16836] execute S_2:       BEGIN READ ONLY
02:24:49.061 [pid 16836] execute <unnamed>: SELECT key, value, updated_at FROM runtime_settings
02:24:49.062 [pid 16836] execute S_1:       COMMIT
   … repeats at :54.071, :59.077, :04.083
```

Cause is an exact collision of two independently-chosen constants:

| Constant | Value | Source |
|---|---|---|
| `HEARTBEAT_TICK_MS` | `5_000L` | `CardEventPublisher.java:50` |
| `RUNTIME_SETTINGS_CACHE_TTL_SECONDS` | `5` (default) | `application.yml:105` |

The TTL equals the tick, so the Caffeine entry is expired on essentially every tick. And the read is
**unconditional** — `settings.get()` is evaluated *inside* the guard expression, so it happens before
the early return and regardless of whether any SSE subscriber exists
(`CardEventPublisher.java:267-271`):

```java
@Scheduled(fixedDelay = HEARTBEAT_TICK_MS)
public void heartbeat() {
    long now = System.currentTimeMillis();
    if (now - lastHeartbeatAt < settings.get().heartbeatIntervalMs()) return;   // <-- DB read here
```

**Note the docstring is not wrong, but its intent is not met.** `RuntimeSettingsService` promises
"the hot paths (every SSE subscribe, heartbeat tick, config endpoint) cost a map lookup, and the
database sees at most one settings query per TTL window" (:20-23). One query per TTL window is
literally satisfied — it is just that the TTL window and the tick are the same 5 seconds.

**Risk: LOW for correctness, non-zero for the event.** ~17,280 transactions/day of pure idle
polling, holding a pool connection each tick. It is not a leak and it does not grow with load.

**Decision: RECORD ONLY. Do not fix in P0.** It touches `CardEventPublisher`, which is adjacent to
the frozen SSE layer. Cheapest future fix is config-only — raise
`RUNTIME_SETTINGS_CACHE_TTL_SECONDS` above the tick (e.g. 30) — with **no code change**. Candidate
for P6, owner's call.

---

## R2 — `GET /api/cards` returns every card on the platform to anonymous callers. **VERIFIED**

**Evidence.**

```
curl http://localhost:8080/api/cards        ->  200, 59,669 bytes, 5 cards
```

Every card, from **both** tournaments, each with its **full player roster** — names, surnames and
schools:

```
card=dhui           players=11  audit=0  games=4  tables=0
card=Math Scrabble  players=11  audit=0  games=4  tables=0
card=api            players=31  audit=0  games=4  tables=0
card=math           players=31  audit=0  games=6  tables=0
card=เอแม็ท บุรีรัมย์ … players=25  audit=0  games=4  tables=0

{"id":"D001","firstName":"กิตติ","lastName":"ศรีวัฒน์","school":"สวนกุหลาบวิทยาลัย", …}
```

Three separate facts, each verified from source:

1. `SecurityConfiguration.java:110` — `.requestMatchers(GET, "/api/cards", "/api/cards/**").permitAll()`.
2. `CardController.list():53` correctly branches to `publicCards.list()` for anonymous callers — so
   the projection is applied. `PublicCardProjection` **deliberately** exposes `players()` and
   correctly strips `rules`, `tables`, `audit` and an unpublished `finalRound` (:40-58). Anonymous
   `audit=0` and `tables=0` above confirm the stripping works.
3. **But the catalog it draws from has no filter whatsoever.**
   `PublicCardReadCache.summaries()` (:34-56) is literally
   `FROM tournament_cards c ORDER BY c.created_at DESC` — **no `WHERE` clause at all.** No tournament
   filter, no status filter, no published filter.

**The contrast that makes this a finding.** The token-scoped viewer path *does* enforce closure —
`TenantService.resolveOpenTournament` (:318-332) ends
`WHERE t.access_token = ? AND t.status = 'OPEN'`, returning 404 otherwise. So D18's "closing the link
hides live data" **is correctly implemented for `/tour/{token}`** and is bypassed by the unscoped
`/api/cards`.

Confirmed live: the viewer at `/tour/bkk` renders only that tournament's **4** cards, while
`/api/cards` returns all **5**.

**Risk.** The viewer link is not a confidentiality boundary for card and player data; anyone who can
reach the API can enumerate every tournament's roster with no token, including tournaments that are
closed or never published. Compounding it, `TenantService.java:46` permits an access token as short
as **3 characters** (`token.length() < 3` is the rejection), and one local tournament indeed uses
`bkk`; the DB default is a 32-char UUID, so a short token is an explicit choice the app allows.

### Reachability — **VERIFIED reachable.** (This was the open question; it is now closed.)

No layer of the production request path filters anything: `src/app/api/[...path]/route.ts` is a
catch-all, `render-backend-proxy.ts:27` assigns `upstream.pathname = incoming.pathname` verbatim with
no allowlist, there is **no `middleware.ts` in the repo at all**, and `open-next.config.ts` is a bare
`defineCloudflareConfig()`.

Proven through the same proxy route production uses, anonymously:

```
curl http://localhost:3000/api/cards
-> 200, 59,669 bytes | cards: 5 | tournaments: 2 | player records: 109
```

`CORS_ALLOWED_ORIGINS` does not mitigate it — CORS binds browsers, not `curl`. The only thing that
could still block it is a rule **outside this repository** (e.g. a Cloudflare WAF), which only the
owner can confirm. **Treat as a live exposure until they do.**

**Decision: REPORT, DO NOT FIX IN P0.** It is pre-existing, not introduced here, and changing public
data exposure three weeks before a competition needs an explicit owner decision.

**Consequence for the plan — B3 gets *easier*, not harder.** A new `GET /api/cards/summaries` under
the same `permitAll()` matcher would expose *strictly less* than `/api/cards` already does. B3's
requirement (branch on identity, scope in the controller) still stands, but it is not a new exposure.

---

## R3 — Viewer flow: 3 origin requests, 0 database queries. **VERIFIED**

Real browser load of `http://localhost:3000/tour/bkk`:

```
GET /api/public/realtime-config          200
GET /api/public/tournaments/bkk/bundle   200
GET /api/public/tournaments/bkk/events   200   (SSE, stays open)
```

**Three requests, no `/api/auth/me`, no snapshot probe, zero console errors.** The snapshot probe is
correctly absent because `NEXT_PUBLIC_SNAPSHOT_ORIGIN` is unset locally — the same flag-off contract
now covered by `snapshot-api-origin-unset.test.ts`.

### Warm-cache query counts (poller excluded)

| Request | Status | Bytes | SQL |
|---|---|---|---|
| `GET /api/public/tournaments/{token}/bundle` | 200 | 43,271 | **0** |
| `GET /api/public/realtime-config` | 200 | 115 | **0** |
| `GET /api/public/cards/versions` | 200 | 296 | **0** |
| `GET /api/cards` (anon, repeat call) | 200 | 59,669 | **0** |
| `GET /actuator/health` | 200 | 49 | **0** |

The Caffeine read cache absorbs the entire viewer path. **The runbook's "refresh storms never
amplify into database load" claim holds at this scale.**

> **Warm-cache only — cold-cache numbers are NOT captured.** Forcing a miss needs either
> `/actuator/caches` (ADMIN-only) or a mutation, so every figure above is steady state with the
> cache already populated. An early pre-harness reading appeared to show 3 statements for a first
> `/api/cards` call; that measurement was taken before R1 was identified and is almost certainly the
> heartbeat poller landing in the window, so **it is discarded rather than reported** — the true
> cold-cache cost of `/api/cards` is unmeasured.

---

## R4 — Anonymous SSE handshake baseline. **VERIFIED**

`GET /api/public/tournaments/bkk/events`, 14-second capture:

```
event:connected
id:70
retry:2000
data:{"cardId":"453be25a-…","version":70,"updatedAt":"2026-08-22T02:28:16.243418Z"}

:hb
```

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`,
`Transfer-Encoding: chunked`, CSP `default-src 'none'`.
**149 bytes over 14 seconds** on an idle stream.

This is the connect fixture only. The three traces Invariant B requires — result save, pairing
confirm, results publish — all need an authenticated mutation and are **not captured**.

---

## 5. Test-harness fix (owner decision B) — done

`npm test`: **114/114, exit 0** (was 103/114). Test files only; no product change.
Root cause was two bugs, not one — `01_P0_BASELINE.md` §4.2.

---

## 6. Snapshot invariant — **UNVERIFIED, environment-blocked**

`NEXT_PUBLIC_SNAPSHOT_ORIGIN` is unset locally and the local `.env` carries no R2 credentials, so no
snapshot can be published or checksummed here. Invariant C (deep-equal payload + matching
`snapshot.checksum`) **cannot be baselined on this machine.**

This intersects a previously recorded concern that `NEXT_PUBLIC_SNAPSHOT_ORIGIN` is not set in the
Worker build, against D17's claim that it *is* set in production. **These cannot both be true.**
Resolving it needs production/Worker configuration, not local access. Flagged for the owner.

---

## 7. Blocked on credentials — nothing below is captured

`/api/dev/**` is `hasRole("ADMIN")` (`SecurityConfiguration.java:114`), so every remaining item needs
an authenticated session:

- [ ] HAR for login ×3 roles (staff / director / admin) — the "9 requests, 3× `/api/auth/me`" metric
- [ ] Card list, card overview, result-entry flows
- [ ] Isolated test tournament + cards (decision A grants this; auth does not)
- [ ] 400-player stress dataset
- [ ] SSE traces ×3 (result save, pairing confirm, results publish) — Invariant B
- [ ] Cold-cache and authenticated query counts (`/actuator/caches` is ADMIN-only)
- [ ] **B4 — `maximumSessions(2)` runtime behaviour.** Still the highest-value unknown; P2 must not
      proceed without it
- [ ] Screenshots for the 11 authenticated routes

**These are deliberately not worked around.** Per the operating rules, credentials are not something
to guess, brute-force or manufacture, and accounts must not be created.

---

## R5 — **Methodology: `next dev` inflates every request count. Use a production build.** VERIFIED

`next.config.ts:4` sets `reactStrictMode: true`. In development React double-invokes effects
(mount → unmount → remount), so the dev server issues duplicate and `net::ERR_ABORTED` requests that
**do not happen in a production build**.

Observed on `next dev` (:3000), one `/staff-login` load:

```
GET /api/auth/me                       ×2
GET /api/public/realtime-config        ×2   (one ERR_ABORTED)
GET /api/public/tournaments/bkk/bundle ×1
```

**Consequence: any HAR or request count captured against `next dev` is not a valid baseline.**
The metric in `00_MASTER_PLAN.md` §6 ("9 requests per staff login, incl. 3× `/api/auth/me`") is
marked *read from source, UNVERIFIED at runtime* — it must be re-measured against `next build`
+ `next start`, never against the dev server.

A production server was therefore built and run on **:3001** for the measurements below.

---

## R6 — Login page, production build: 4 requests, and the duplicate `/api/auth/me` is REAL. VERIFIED

One `/staff-login` load on the **production** build (:3001), anonymous:

```
GET /api/auth/me                200      145 B
GET /api/public/realtime-config 200      115 B
GET /api/public/cards           200    1,744 B
GET /api/auth/me                200      145 B     <-- duplicate
```

**4 API requests, 2× `/api/auth/me`.** The duplicate survives into production, so it is **not** a
StrictMode artifact — it is a genuine defect and a legitimate P2 target. (The master plan's "3×" is
for the full login flow; 2× is what the login *page* alone costs before any credentials are entered.)

Total anonymous login-page API payload: **~2.0 KB**. That is already small — the "~1 MB login
payload" metric refers to the authenticated director path, which is still unmeasured.

---

## R7 — **Correction: `/api/public/cards` is NOT `/api/cards`.** VERIFIED

An earlier reading in this session conflated them. They are different endpoints with very different
payloads, both anonymous:

| Endpoint | Controller | Bytes | Player records |
|---|---|---|---|
| `GET /api/public/cards` | `PublicCardController:50` → `CardSummary` | **1,744** | **0** |
| `GET /api/cards` | `CardController:52` → full public projection | **59,669** | **109** |

**The application calls only the lean summaries endpoint.** B7's 59 KB roster payload is reachable
but is *not* fetched by the app in any flow observed. That narrows B7: it is an exposed endpoint an
attacker could call directly, **not** something the UI leaks on every page load.

### This materially affects B3 and P3-B

**A summaries endpoint already exists — twice:**

- `GET /api/public/cards` (`PublicCardController:50`) — unscoped `CardSummary` list, ETag + `LIVE_POLICY` cached
- `GET /api/public/tournaments/{token}/cards` (`PublicTournamentController:57`) — **tournament-scoped** summaries

and the shape is exactly the `CardSummary` that `02_ARCHITECTURE_DECISIONS.md` §2.3 already verified
as sufficient for the card list and sidebar.

**This is not a drop-in replacement** for the back-office need: both are anonymous and neither scopes
to *an authenticated user's accessible tournaments*, which is what a director/staff sidebar requires.
But it means the P1 work may be substantially smaller than "build a new endpoint" — possibly a
scoped, authenticated variant reusing `PublicCardQueryService.summaries(tournamentId)`, which already
exists. **Re-scope B3 before implementing it.**

---

# Part 2 — Authenticated captures (session: `staff` / ROLE_ADMIN)

Isolated data created under decision A, in a new tournament only:

| | |
|---|---|
| Tournament | `P0 BASELINE (ux-refactor) DO NOT USE` — id `476d110b-e1bc-40cb-9915-ebe1714801d6`, slug `p0-baseline-ux` |
| Card A | `P0 Stress 400` — `fad7570e-76e1-4ac7-bfea-8480e8b77334`, **401 players**, 6 games |
| Card B | `P0 SSE Fixture` — `a8eeefbf-cb62-4b68-84c9-97903016a610`, 8 players, 4 games |

**Isolation proven.** Pre-existing rows before and after: `TestVerseCase` 1 card / 25 players,
`test` 4 cards / 84 players (= the original 109). Nothing outside the new tournament was written.

---

## R8 — Player import is row-by-row, and the **production** path is too. VERIFIED ⚠️

Generating 400 players issued **800 individual INSERTs** — 400 into `players`, 400 into `standings`,
one statement each:

```
 400 INSERT INTO players (card_id, code, first_name, last_name, school)
 400 INSERT INTO standings (card_id, player_code) VALUES (?, ?)
```

This is **not only the dev tool.** `addPlayersBulk` (`TournamentCardService.java:236-252`) — the
endpoint behind the real Excel import, `POST /api/cards/{id}/players/bulk` — has the same shape:

```java
for (int index = 0; index < players.size(); index++) {
    jdbc.update("INSERT INTO players ...");
    jdbc.update("INSERT INTO standings (card_id, player_code) VALUES (?, ?)");
}
```

**`batchUpdate` does not appear anywhere in `backend/src/main/java`** (grep: zero hits).

**Why it matters on event day.** `addPlayersBulk` is `@Transactional` and starts with
`requireStage(...)` → `cardRow()` → `SELECT … FOR UPDATE` (`03_INVARIANTS.md` §3.3). So the **card row
stays locked for all 800 round trips.** Measured 285 ms locally where the database is on the same
host; production is Render app → managed Postgres, where per-statement latency dominates. At 1–5 ms
RTT that is roughly **0.8–4 s of held lock** per 400-player import.

**Risk: MEDIUM, and it is a registration-time cost, not a live-scoring cost.** Registration happens
before play, so a few seconds of lock is survivable — but it is the single clearest measured
inefficiency found, and the fix (`jdbc.batchUpdate`) is additive, local, and touches no frozen code.

**Decision: RECORD ONLY for P0.** Candidate for P1/P6, owner's call. **Do not batch result saves** —
that is a different thing and remains rejected (`00_MASTER_PLAN.md` §5).

---

## R9 — Admin `GET /api/cards` is an N+1: `1 + 7N` queries. VERIFIED

Measured, poller excluded, for **6 cards**:

```
   1  SELECT id FROM tournament_cards ORDER BY created_at DESC     <- the list
   6  SELECT id, name, division, number_of_games, status, ...      <- per card
   6  SELECT tournament_id FROM tournament_cards WHERE id = ?
   6  SELECT p.code, p.first_name, ... (players)
   6  SELECT m.game_number, m.table_number, ... (matches)
   6  SELECT game_number, status, max_diff FROM games ...
   6  SELECT from_game, rule_type FROM pairing_rules ...
   6  SELECT table_no, seat_no, player_code FROM table_seats
   3  SELECT slot, player_one, ... (final_pairings, only cards with finals)
   6  BEGIN READ ONLY   +  6 COMMIT                                <- one txn per card
  ---
  58  total   (decomposition 1 + 6x7 + 3 + 12 = 58 — exact match)
```

**Payload: 120.9 KB, 6 cards, 3 tournaments, 509 players** — every card on the platform, confirming
D3's "no tournament filter for admin".

**This validates the plan's "~21 DB queries" estimate** for a 3-card director: 7 × 3 = 21 core
selects. The metric was sound; it is now measured rather than assumed.

A single 400-player card serialises to **68 KB** on its own, so the "3 cards × 400 players ≈ 1 MB"
figure is the right order of magnitude once games, pairings and matches are populated (the measured
68 KB is at `PLAYER_REGISTRATION`, before any pairings exist).

---

## R10 — SSE traces ×3 captured. Invariant B now has a baseline. VERIFIED

Fixture committed at **`docs/ux-refactor/fixtures/sse-baseline.json`**.

Staff stream `GET /api/cards/{cardId}/events`, versions **strictly monotonic v2 → v10, no gaps**:

| Trace | Action | Events | Shape |
|---|---|---|---|
| **1 — result save** | `PUT …/matches/g1t1/result` | `result@v5` | **DELTA** — `changedPairings` only |
| **2 — pairing confirm** | `…/pairings/preview` → `…/pairings/confirm` | `state@v3`, `state@v4` | **FULL CARD** |
| **3 — results publish** | `…/results/review` → `…/results/publish` | `state@v9`, `state@v10` | **FULL CARD** |

Payload keys, fixed:

```
connected -> [cardId, updatedAt, version]
state     -> [card, cardId, updatedAt, version]
result    -> [cardId, changedPairings, updatedAt, version]
```

**The load-bearing invariant is the asymmetry:** a result save emits a *delta*; every stage
transition emits the *full card*. This is exactly what `02_ARCHITECTURE_DECISIONS.md` §2.2 predicted
from source, now confirmed at runtime. **Any phase that changes this asymmetry has broken Invariant B.**

Business logic spot-check: `calculatedDiff = min(|420−385|, maxDiff 350) = 35` ✅.
Mutation response for one result save: **287 bytes**.
Sequential result saves measured **73 / 39 / 44 ms** locally — for a 400-player card
(200 pairings/game) that extrapolates to roughly **10 s per game** of sequential saving locally, and
more in production. Sequential saving stays (it is an invariant); this is the number that justifies
a progress indicator rather than parallelism.

---

## R11 — `addPlayer` / `addPlayersBulk` do not evict the public cache. VERIFIED, minor

`@EvictPublicCard` is present on `updatePlayer` (:248), `removePlayer` (:275), `terminatePlayers`,
`restorePlayers`, `finishRegistration`, `confirmPairingPreview`, `submitResult`, `publishResults`,
`startFinalRound` and others — but **not** on `addPlayer`, `addPlayersBulk`, or `generateMockPlayers`.
Confirmed at runtime: after a bulk insert, `GET /api/public/cards` served entirely from cache with
**zero** catalog queries.

**Assessed as benign, not a defect.** The public summary reports `playerCount = 0` while
`runtime_stage = 'PLAYER_REGISTRATION'` (`PublicCardReadCache.summaries()` CASE), and players can only
be added in that stage. `finishRegistration` *does* evict, so the public view is correct from the
moment it becomes meaningful. Worth knowing before anyone "fixes" it.

> **Cold-cache query counts remain UNMEASURED.** `/actuator/**` is ADMIN-only but sits outside
> `/api/**`, so the Next proxy (`src/app/api/[...path]/route.ts`) never forwards it — `/actuator/caches`
> returns the app's own 404 HTML. Forcing a miss via mutation did not work either, because the
> eviction path above does not cover player inserts. Not pursued further: it is a secondary metric and
> every warm-path number that matters is captured.

---

## R12 — B4 resolved: `maximumSessions(2)` IS enforced, evicting least-recently-used. VERIFIED

**Experiment.** Five sequential logins as `staff` against a cap of 2, with one instrumented session
("B") deliberately left **idle** for the decisive step.

```
logins #1,#2  -> B alive
login  #3     -> B ALIVE      (inconclusive: B was being polled, so it was most-recently-used)
logins #4,#5  -> B EXPIRED    (B left idle -> became least-recently-used -> evicted)
```

The first probe was designed to be inconclusive and is reported as such: B's survival at step 2 was
consistent with both "cap enforced" and "cap is a silent no-op". Only starving B of traffic separated
them. **The prior ASSUMPTION that the registry might never populate is disproved.**

Eviction order is the *desirable* one: the session actively entering results is the last to go.

**What the evicted session sees** — and why it matters to P2:

| Request | Status | Body |
|---|---|---|
| `GET /api/auth/me` | 200 | `authenticated: false` |
| `GET /api/admin/tournaments` | **401** | — |
| `GET /api/cards` | **200** | **anonymous PUBLIC projection** |

Because `/api/cards` is `permitAll` (**B7**), an evicted staff session is handed public data rather
than a 401 — `rules: 0`, `tables: 0`, `audit: 0`, plus the **public** version and stage. Confirmed
against the database: staff `version = 11` / `public_version = 7`, real stage `PAIRING_PREVIEW` /
public stage `TABLE_PAIRING`.

**Severity: LOW.** Three existing defences already cover it, and they are the reason this is a note
rather than a defect — see `04_BLOCKERS.md` B4 for the full argument:
`replaceCard`'s version guard drops the lower-version payload; the SSE stream dies on eviction and
`use-card-sync.ts:93` calls `ensureSessionAlive()`; and `use-session-guard.ts` re-checks on focus,
online, pageshow, visibilitychange and a 30-minute timer.

**P2 rule: keep all three.** The exposure window is narrow only because they exist.

**Remaining UNVERIFIED (low priority):** whether a logout frees its registry slot. Without an
`HttpSessionEventPublisher`, phantom entries could push the *effective* cap below 2 over an event day
under D6 (shared machines). Needs a login/logout/login cycle with an idle instrumented session.

---

## R13 — Invariant E (multi-user editing loses nothing): **PASS**. VERIFIED

Two **genuinely simultaneous** result saves (`Promise.all`, both requests in flight at once) to two
different pairings in the **same card and same game**, from a shared starting version.

```
card    a8eeefbf… (isolated "P0 SSE Fixture"), game 2, stage RESULT_COLLECTION
SHARED START VERSION = 12
writer A -> g2t1  scoreOne=500 scoreTwo=300
writer B -> g2t2  scoreOne=450 scoreTwo=410
both dispatched concurrently; wall clock for the pair = 43 ms
```

### Evidence 1 — both writes persisted (read straight from Postgres, not the API)

```
 table | p_one | p_two | winner | s_one | s_two | type | calc_diff | submitted_by | submitted_at
-------+-------+-------+--------+-------+-------+------+-----------+--------------+--------------
     1 |     7 |     5 |      7 |   500 |   300 | W    |       200 | staff        | 03:48:46.174
     2 |     4 |     1 |      4 |   450 |   410 | W    |        40 | staff        | 03:48:46.177
```

**3 milliseconds apart** — concurrent, and serialised rather than interleaved.

### Evidence 2 — no lost update

| | |
|---|---|
| Start version | **12** |
| Writer A response | `version: 13` |
| Writer B response | `version: 14` |
| Final `tournament_cards.version` | **14** |
| Delta | **+2 — exactly one increment per write** |

**This is the proof.** The two responses carry *distinct, sequential* versions. Had the writes not
serialised on `cardRow()`'s `SELECT … FOR UPDATE` (`03_INVARIANTS.md` §3.3), both transactions could
have read version 12 and written 13 — one increment, and one result, silently lost. They did not.

### Evidence 3 — audit trail: one row per save, no merging

```
staff | SUBMIT_RESULT | {"scoreOne":450,...,"calculatedDiff":40,"maxDiff":350}  | 03:48:46.177
staff | SUBMIT_RESULT | {"scoreOne":500,...,"calculatedDiff":200,"maxDiff":350} | 03:48:46.174
```

### Evidence 4 — no duplicate or phantom rows

```
total_pairings_game2 = 4 | with_result = 2 | still_open = 2
```

Exactly the two written, nothing else disturbed.

### Evidence 5 — business logic intact under concurrency

`min(|500−300|, 350) = 200` ✅ · `min(|450−410|, 350) = 40` ✅ — the capped-diff rule holds on both
concurrent paths.

### Honest limitation

**Both writers authenticated as the same principal (`staff`)** — `submitted_by` and the audit `actor`
are identical on both rows. The Browser pane is a single cookie jar, so two independent *identities*
could not be driven simultaneously, and passwords are not something this agent may enter. What is
proven is **server-side serialisation, version integrity and row integrity under true request
concurrency** — the mechanical content of Invariant E. What is **not** proven is that two *different
usernames* are attributed correctly in `audit_logs`; that attribution is written from
`authentication.getName()` per request and is not affected by concurrency, but it remains untested.

**Verdict: Invariant E PASSES on the property that matters — concurrent editing loses nothing.**
