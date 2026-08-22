# P1 — Backend-only additive migration. REVISED PLAN.

```
STATUS: PLAN ONLY — AWAITING OWNER APPROVAL — NO P1 CODE WRITTEN
```

Supersedes the P1 sketch in `00_MASTER_PLAN.md` §3 and the "Required fix" sections of
`04_BLOCKERS.md` B2 and B3, both of which are frozen and cited here rather than edited.

Prerequisite: `07_P0_CLOSURE.md` (P0 closed, evidence frozen).
Excluded by owner instruction: **B7 / SECURITY-01** — see §4.3 for how P1 avoids touching it.

Every architectural claim below is labelled **VERIFIED** (read from source in the working tree at
`6ce756c`), **UNVERIFIED** (needs runtime or production access), or **ASSUMPTION** (believed,
untested). Line numbers were re-read on 2026-08-22; frozen code is still identified **by symbol**.

---

## 1. What P1 is, and the property that makes it safe

P1 is **backend-only and additive**. It ships three things:

| Chunk | Delivers | Touches the frontend? |
|---|---|---|
| **P1-A** | A readable, machine-distinguishable re-auth error (unblocks B2, therefore unblocks P2) | no |
| **P1-B** | A back-office card-summaries endpoint scoped to the caller's accessible tournaments (unblocks P3-B) | no |
| **P1-C** | The B4 session findings turned into enforced design constraints + one cheap runtime check | no |
| **P1-D** *(optional)* | `jdbc.batchUpdate` for player import (B9) | no |

> **The load-bearing property: after P1, the existing frontend must work completely unchanged.**
>
> P1 adds an endpoint nothing calls yet (P3-B calls it) and changes one error response for the
> better. That is what makes Invariant D ("Old FE + New BE") the natural P1 gate rather than an
> afterthought, and it is what makes rollback cheap (§8).

**P1 does not consume the new endpoint.** Consumption is P3-B. Removing the pre-flight
`verifyPassword` is P2. Both stay in their phases.

### Why the backend is the right place to start — VERIFIED

`.github/workflows/ci.yml:37` runs `mvn --batch-mode --no-transfer-progress test` for the backend.
The frontend job (`:20-23`) runs `npm ci`, `lint`, `typecheck`, `build` — **not `npm test`**.

So **P1 is the one phase with a real automated CI gate.** Every later, frontend-heavy phase relies on
local runs and owner spot-checks. Front-loading the backend work puts the riskiest changes where the
machine checks them.

---

## 2. P1-0 — Commit P0 first (rollback prerequisite)

**This must happen before any P1 code.**

P0 produced **no commits**; it is all working-tree state (`05_HANDOFF.md` §1) — 4 staged deletions,
`package.json`/`package-lock.json` edits, 2 modified test files, 1 new test file, plus
`docs/ux-refactor/`. **VERIFIED** by `git status` at plan time.

Until that is committed, **P1 cannot be reverted independently of P0** — a `git revert` would tangle
the two. Proposed commits, one logical change each (handoff rule 7):

| # | Commit | Contents |
|---|---|---|
| 1 | `docs(ux-refactor): freeze P0 baseline and evidence` | `docs/ux-refactor/**` only |
| 2 | `chore(p0): remove four dead modules and four unused dependencies` | the 4 deletions + `package.json` + `package-lock.json` |
| 3 | `test(p0): fix the harness so npm test is a real gate` | the 3 test files only |

Commit 2 is the only one with product impact, and its behaviour-neutrality is already proven
(byte-identical 22-route bundle table, `01_P0_BASELINE.md` §3).

**Do not push to `staging`.** `render.yaml` pins no branch (**VERIFIED** — 66 lines, no `branch:` or
`autoDeploy:` key), so production moves only on a merge to `main`.

---

## 3. P1-A — Make the re-auth error readable (B2). **This lands first.**

### 3.1 The defect, re-verified

| Fact | Evidence | Label |
|---|---|---|
| Wrong re-auth password throws 401 with a Thai reason | `ReauthenticationService.java:36` — `throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "รหัสผ่านไม่ถูกต้อง")` | **VERIFIED** |
| Genuine no-session cases throw 401 with **no** reason | same file `:24` (anonymous/unauthenticated) and `:33` (account row missing) | **VERIFIED** |
| The reason is stripped before it reaches the client | `application.yml:51-53` under `server:` — `error.include-message: never`, `error.include-stacktrace: never` | **VERIFIED** |
| Nothing handles `ResponseStatusException` | `ApiExceptionHandler.java` is 28 lines with exactly three handlers: `IllegalArgumentException` (:14), `MethodArgumentNotValidException` (:17), `DataIntegrityViolationException` (:24) | **VERIFIED** |
| So the client renders the English word "Unauthorized" | `store.ts:257` in `readError` (fn starts :254) — `payload.error ?? payload.message ?? ...`; Spring's default body carries `error: "Unauthorized"` | **VERIFIED** |
| The pre-flight is what produces today's Thai message | `verifyPassword` returns a boolean (`store.ts:822-830`); the five call sites supply their own text — `cards/[id]/tables/page.tsx:101`, `cards/[id]/games/page.tsx:156`, `:269`, `:302`, `ui/components/reopen-registration.tsx:52` | **VERIFIED** |

**The pre-flight is not redundant. It is the error-message mechanism.** P2 may not remove it until
P1-A ships.

### 3.2 Blast radius is larger than B2 recorded — and that decides the design

**VERIFIED:** `new ResponseStatusException(` appears **76 times across 13 files** in
`backend/src/main/java`. A blanket `@ExceptionHandler(ResponseStatusException.class)` that echoes
`getReason()` would newly surface **all 76** messages, not just the re-auth one.

Most are Thai operator messages written to be shown, so most of that is an improvement. But at least
one discloses internal configuration:

```
"Public Snapshot storage is not configured (app.snapshot-storage.*)"   UnconfiguredSnapshotStorage
```

**Reachable only by ADMIN/DIRECTOR** (`requireTournamentOperator`), so severity is low — but a
blanket handler makes 76 messages public API in one commit, three weeks before a competition, with
no per-message review. **Rejected.**

**Chosen design — a dedicated exception type, opt-in.**

1. Add `BadReauthenticationException` (new file, `infrastructure/security/`).
2. Throw it from `ReauthenticationService.java:36` **only**. Lines `:24` and `:33` keep plain 401 —
   they are genuine no-session cases and must stay distinguishable.
3. Add one handler to `ApiExceptionHandler`:

```java
@ExceptionHandler(BadReauthenticationException.class) @ResponseStatus(HttpStatus.FORBIDDEN)
public Map<String, Object> badPassword(BadReauthenticationException error) {
    return Map.of("timestamp", Instant.now(), "status", 403,
                  "error", "รหัสผ่านไม่ถูกต้อง", "code", "BAD_PASSWORD");
}
```

Exactly one message becomes visible. The other 75 sites are untouched. If the owner later wants the
rest surfaced, that is a separate, reviewable change.

### 3.3 The 401 to 403 status change, and why it is safe

B2 requires 403 so a wrong password is distinguishable from a lost session. Consequences, all traced:

| Consequence | Evidence | Label |
|---|---|---|
| `request()`'s 401 branch no longer fires, so the extra `/api/auth/me` confirmation round trip disappears | `store.ts:294-303` — the branch is `response.status === 401 && (...)`, and it calls `fetchAuthState()` | **VERIFIED** — a small, free win |
| 403 never triggers logout | `03_INVARIANTS.md` §3.8: `expireBackOfficeSession` is reached only from the 401 branch (`store.ts:294`) | **VERIFIED** |
| The existing frontend already treats 401 and 403 identically wherever it checks | 403 appears at exactly **two** sites in `src/`, both `status === 401 \|\| status === 403` then `ensureSessionAlive()`: `store.ts:734` (logout) and `store.ts:828` (`verifyPassword`) | **VERIFIED** |
| CSRF failure is also 403, so status alone is ambiguous | Spring's default `AccessDeniedHandler`; no custom handler in `SecurityConfiguration.java`. Its body carries `error: "Forbidden"` and **no `code`** | **VERIFIED** |
| therefore clients must discriminate on the body `code`, never on status | `code: "BAD_PASSWORD"` is present only on the re-auth response | design rule |
| **Old FE + New BE is safe and strictly better** | wrong password gives 403, so `request()` skips the 401 branch (one fewer request) and `readError` returns the Thai text instead of "Unauthorized"; `verifyPassword` already handles 403 identically | **VERIFIED by inspection / UNVERIFIED at runtime** — Invariant D executes it |

**One existing test will fail, by design:**
`ReauthenticationServiceTest.rejectsWrongPassword` asserts `.hasMessageContaining("401")`
(**VERIFIED**, `backend/src/test/.../ReauthenticationServiceTest.java:47-49`). It must be updated to
assert 403 **and** the `BAD_PASSWORD` code. That is an expected test-file change, not a regression.

### 3.4 Scope of the benefit

`requireCurrentPassword` has **13 call sites** across 5 controllers plus `SnapshotApprovalService`
(**VERIFIED**): `AuthController:41`, `AdminController:91,106`, `SystemController:69`,
`CardController:157,164,178,186,195,204,239,249,419`, `SnapshotApprovalService:119`.

All 13 gain the readable error from a single handler. The frontend pre-flight covers only 5 of them
today, so P1-A **also fixes eight paths that have no readable error at all right now.**

### 3.5 Files touched

```
backend/src/main/java/.../infrastructure/security/BadReauthenticationException.java   NEW
backend/src/main/java/.../infrastructure/security/ReauthenticationService.java        :36 only
backend/src/main/java/.../web/ApiExceptionHandler.java                                +1 handler
backend/src/test/java/.../infrastructure/security/ReauthenticationServiceTest.java    update
backend/src/test/java/.../web/ReauthErrorContractTest.java                            NEW
```

Nothing in `03_INVARIANTS.md` §1 is touched.

---

## 4. P1-B — Back-office card summaries (B3, **re-scoped**)

### 4.1 The re-scope premise, and the correction it needs

`06_P0_RUNTIME_BASELINE.md` R7 established that summary endpoints **already exist** and that the P1
work may therefore be far smaller than "build a new endpoint":

| Existing endpoint | Source | Scope |
|---|---|---|
| `GET /api/public/cards` | `PublicCardController.java:50` | unscoped `CardSummary` list, ETag + `LIVE_POLICY` |
| `GET /api/public/tournaments/{token}/cards` | `PublicTournamentController.java:57` | **tournament-scoped** summaries |

and `PublicCardQueryService.summaries(UUID tournamentId)` (`:32-36`) already filters the **cached**
catalog in memory — **zero SQL when warm** (**VERIFIED**; R3 measured 0 statements on the viewer path).

**That is real reuse and the plan takes it. But the values cannot be reused, and this is new.**

> **NEW FINDING — the gap between `02_ARCHITECTURE_DECISIONS.md` §2.3 and `06_P0_RUNTIME_BASELINE.md` R12.**
>
> §2.3 verified that `CardSummary` carries **every field** the back-office card list and sidebar read.
> That is correct — and it is about **field presence only**. R12 separately measured that the same
> fields carry **public-projected values** that differ from the staff truth. **Nobody connected the two.**

**VERIFIED** from `PublicCardReadCache.summaries()` (`:34-56`), reading the SQL directly:

| `CardSummary` field | What the SQL actually puts in it | Consequence for a staff card list |
|---|---|---|
| `runtimeStage` | a `CASE` expression producing **`public_stage`**, not `c.runtime_stage` | R12 measured real stage `PAIRING_PREVIEW` vs public `TABLE_PAIRING`. `cardStageInfo(card,"staff")` (`stage-info.ts:36-39`) would print "จับคู่" when the operator's actual next action is "ตรวจและยืนยัน Pairing" — **the wrong operational step** |
| `playerCount` | `CASE WHEN c.runtime_stage = 'PLAYER_REGISTRATION' THEN 0 ELSE count(*) END` | **0 during registration** — exactly when staff need the number. `stage-info.ts:29` renders `ลงทะเบียน · ${playerCount} คน`, so a 400-player card would read **"ลงทะเบียน · 0 คน"** |
| `version` | `c.public_version`, not `c.version` | R12 measured staff `11` vs public `7`. Mixing the two into anything that compares versions is a silent-divergence bug |

**Conclusion: reusing the public summaries endpoints for the back-office list is rejected on
correctness.** The re-scope is real, but it is *"reuse the shape, the pattern and the plumbing"*, not
*"call the existing endpoint"*.

### 4.2 Two more constraints the existing code already encodes — VERIFIED

The codebase has **already decided** that public summaries must not reach an authenticated store:

```ts
// store.ts:606-607, applyPublicSummary
// Staff/directors hold richer authenticated card data; the public list stream is viewer-only.
if (get().auth.authenticated) return;
```

```ts
// store.ts:691, refreshPublicCatalog
if (get().auth.authenticated) return [];
```

and on the backend, `PublicCardReadCache`'s class javadoc (`:15-18`):

> "The only cached application boundary: anonymous card data that is identical for every public user.
> **Back-office reads never pass through this service.**"

**Therefore, two hard rules for P1-B:**

1. **The back-office query must not live in `PublicCardReadCache`.** Its caches are keyed `'all'` and
   shared with anonymous callers (`@Cacheable(... key = "'all'")`, `:32`). Putting a staff-scoped or
   staff-valued result there would poison the anonymous catalog. This is the single most dangerous
   mistake available in P1-B.
2. **The response must not be typed as `PublicCardDtos.CardSummary`.** The frontend's
   `publicSummaryCard()` (`store.ts:224-252`) converts that type into a `TournamentCard` stamped
   `summaryOnly: true` and hands it to `cards`. A back-office summary that is structurally
   identical would be silently convertible, and its `version` would then collide with
   `replaceCard`'s guard (`store.ts:317-319`). **Use a distinct record.** The field list is the same
   twelve; the cost is one small file, and it buys type-level impossibility.

### 4.3 Security — and how P1-B avoids B7 / SECURITY-01

B3's original required fix #1 said the new controller should *"handle anonymous callers explicitly,
mirroring `list()` at `CardController:53`"*.

**That is now wrong, and B4 is why.** R12 measured that a session evicted by `maximumSessions(2)`
receives **200 + the anonymous public projection** from `GET /api/cards` rather than a 401, precisely
*because* `list():53` has an anonymous branch. Mirroring it would reproduce the hazard on a brand-new
endpoint.

**P1-B rule: the endpoint is authenticated-only. An anonymous or evicted caller gets 401, never data.**
This is what "incorporate the B4 findings" means concretely.

It also means P1-B **neither depends on nor widens SECURITY-01**: the new endpoint is not under a
`permitAll()` matcher, exposes nothing anonymously, and leaves `GET /api/cards` exactly as it is.

#### Routing and matcher analysis — VERIFIED

`SecurityConfiguration.java:103-116`, matchers evaluated **in declaration order, first match wins**:

```
:104  /actuator/health/**, /api/auth/me, /staff-login, /login        permitAll
:105  /actuator/**                                                    hasRole ADMIN
:106  /api/public/push/**                                             permitAll
:107  GET /api/public/**                                              permitAll
:108  GET /api/cards/*/audit                     hasAnyRole ADMIN, DIRECTOR      <-- precedent
:109  GET /api/cards/*/events                    hasAnyRole ADMIN, DIRECTOR, STAFF
:110  GET /api/cards, /api/cards/**                                   permitAll  <-- the trap
:111  GET /api/archives, /api/archives/**                             hasRole ADMIN
:112  /api/admin/**            ADMIN     :113 /api/director/**   DIRECTOR
:114  /api/dev/**              ADMIN
:115  /api/**                                    hasAnyRole ADMIN, DIRECTOR, STAFF
:116  anyRequest                                                      permitAll
```

`:108` and `:109` are **in-codebase proof** that a narrower matcher placed *before* `:110` overrides
the `permitAll()`. So both options below are sound; they differ in risk.

| | **Option A — `GET /api/cards/summaries`** | **Option B — `GET /api/card-summaries`** (recommended) |
|---|---|---|
| Security config | **must** insert a matcher before `:110` | **no change at all** — falls through to `:115`, which already requires ADMIN/DIRECTOR/STAFF |
| Routing risk | literal-vs-`{cardId}` collision. Precedent is good (`PublicCardController:57` `/cards/versions` beside `:64` `/cards/{cardId}`, and `/api/public/cards/versions` is called in production by `use-public-sync.ts:226`) — but if it ever misroutes, `"summaries"` fails UUID conversion and returns **400**, which a 404-only client fallback will not catch | **impossible** — `/api/card-summaries` does not match the `/api/cards/**` ant pattern (different segment), so `{cardId}` is never a candidate |
| Client fallback (P3-B) | must cover **400, 404 and 405** | needs only **404/405** |
| URL idiom | more RESTful | slightly less pretty |
| Risk profile | edits the file where a mistake is worst | zero edits to security config |

**Recommendation: Option B.** It removes an entire failure class rather than handling it, and it
keeps `SecurityConfiguration.java` untouched three weeks before the event. Under the agreed
optimisation order (correctness, production safety, performance, UX, polish), the prettier URL is
the thing that yields.

**ASSUMPTION (Option A only):** that Spring MVC resolves the literal `@GetMapping("/summaries")` ahead
of `@GetMapping("/{cardId}")` *inside `CardController`*. The precedent in `PublicCardController` is
**VERIFIED**, but it has not been executed for `CardController`. Option B makes the question moot.

### 4.4 What the endpoint does

Reuses `AuthorizationService.accessibleTournamentIds(auth)` (`:44-51`, **VERIFIED**) — the same
scoping `CardController.list():54-55` already uses:

```
ADMIN     -> unrestricted (callers special-case; see the D3 note below)
DIRECTOR  -> SELECT tournament_id FROM tournament_members        WHERE username = ?
STAFF     -> SELECT tournament_id FROM staff_tournament_access   WHERE username = ?
```

The query is the public catalog SQL **minus the two public `CASE` wrappers, plus a tenant filter** —
one statement, no N+1:

```sql
SELECT c.id, c.tournament_id, c.name, c.division, c.status,
       c.runtime_stage,                                          -- real stage, not public_stage
       c.current_game, c.number_of_games,
       (SELECT count(*) FROM players p WHERE p.card_id = c.id) AS player_count,   -- always real
       (SELECT count(*) FROM games  g WHERE g.card_id = c.id
                                        AND g.status = 'COMPLETED') AS published_game_count,
       c.version,                                                -- staff version, not public_version
       c.created_at
FROM tournament_cards c
[WHERE c.tournament_id IN (?, ...)]                              -- omitted for ADMIN
ORDER BY c.created_at DESC
```

Placement: a new read method on `TournamentCardService` (it already holds the `JdbcTemplate` and the
existing `list(boolean, Set<UUID>)` at `:54-61`). **It touches none of the frozen pairing / ranking /
diff / Gibson / final-round methods** named in `03_INVARIANTS.md` §1.

#### The measured problem it replaces — VERIFIED (R9)

`TournamentCardService.list(...)` is `SELECT id FROM tournament_cards ...` then a **full `get()` per
card** (`:54-61`). Measured for 6 cards: **58 statements, `1 + 7N`, 120.9 KB**, every card on the
platform. A single 400-player card serialises to **68 KB** on its own.

The replacement is **1 statement** and, by field count, roughly **1–2 KB for a 3-card director**.

> **D3 note.** Decision D3 ("Admin = platform operator only; does not enter the card workspace")
> means the admin console should not be requesting a card list at all. P1-B keeps the ADMIN branch
> unrestricted to preserve the current contract exactly; **narrowing or removing the admin path is
> P2/P3 work**, not P1's. Flagged so it is not silently dropped.

### 4.5 Caching

**None in P1.** The public endpoints are ETag-cached because their responses are identical for every
viewer. A back-office response varies per principal and must not enter a shared cache (§4.2 rule 1).
One statement per sidebar load is already a ~58x reduction; adding a per-user cache is unnecessary
risk. If measurement later shows it is needed, it is a separate change.

### 4.6 Files touched

```
backend/.../web/dto/CardDtos.java  (or a new BackOfficeCardDtos.java)   + BackOfficeCardSummary record
backend/.../application/TournamentCardService.java                       + one read method (additive)
backend/.../web/CardSummaryController.java                               NEW (Option B)
backend/.../infrastructure/security/SecurityConfiguration.java           UNTOUCHED under Option B
backend/src/test/.../web/CardSummaryControllerTest.java                  NEW
```

---

## 5. P1-C — The B4 session findings, as enforced constraints

B4 is **resolved**: `maximumSessions(2)` (`SecurityConfiguration.java:140-142`) **is** enforced and
evicts **least-recently-used**, proven by five sequential logins with the instrumented session
deliberately left idle (R12). The earlier ASSUMPTION that the registry might never populate is
**disproved**. Eviction order is the desirable one — the session actively entering results is last to go.

**P1 changes no session behaviour.** No `HttpSessionEventPublisher`, no `SessionRegistry`, no
`maxSessionsPreventsLogin`. Session handling is P2's, and P1 must not pre-empt it.

What P1 does with B4:

| # | B4 finding | How P1 incorporates it |
|---|---|---|
| 1 | An evicted session gets **200 + public projection** from `GET /api/cards`, not a 401 | **Directly sets P1-B's design** — the new endpoint is authenticated-only and returns 401 to an evicted caller (§4.3). This overturns B3's original "mirror `list():53`" instruction |
| 2 | Three defences make that LOW severity: `replaceCard`'s version guard (`store.ts:317-319`), SSE death then `ensureSessionAlive()` (`use-card-sync.ts:93`), and `use-session-guard.ts` re-checks | P1 touches none of them. Recorded as **P2 must keep all three** |
| 3 | Mixing public and staff versions is the mechanism behind defence 1 | Reinforces §4.2 rule 2 — the new summary carries `c.version`, and gets its own type so it cannot be fed through `publicSummaryCard()` |

### The one open B4 item, and what to do about it

**UNVERIFIED: does a logout free its registry slot?** With no `HttpSessionEventPublisher`, phantom
entries could accumulate so the *effective* cap falls below 2 over an event day — relevant under D6
(shared venue machines, repeated logins).

**Proposal: run it as a P1 pre-flight, because it is cheap and it is now the only session unknown.**
Login, logout, login, logout, login — with one instrumented session left **idle** throughout (the
idleness is what made R12 conclusive; without it the result is ambiguous by construction). Record
whether the idle session survives.

- If slots **are** freed: B4 closes completely, and P2 starts with no session unknowns.
- If they are **not**: the fix is an additive three-line `HttpSessionEventPublisher` bean — but
  registering it is a **P2 decision**, not a P1 one, because it changes session behaviour.

**No code either way in P1.** This is a measurement.

---

## 6. P1-D — Batch the player import (B9). **Optional. Owner's call.**

**VERIFIED (R8).** `addPlayersBulk` (`TournamentCardService.java:236-252`) — the endpoint behind the
real Excel import, `POST /api/cards/{id}/players/bulk` — loops `jdbc.update` **twice per player**.
Importing 400 players issues **800 individual INSERTs**. `batchUpdate` appears **nowhere** in
`backend/src/main/java` (grep: zero hits).

The method is `@Transactional` and opens with `requireStage(...)` then `cardRow()` then
`SELECT … FOR UPDATE` (`03_INVARIANTS.md` §3.3), so **the card row is locked for all 800 round
trips.** Measured **285 ms** locally with the database on the same host; production is Render to
managed Postgres, so at 1–5 ms per statement this is roughly **0.8–4 s of held lock** per import.

**Risk: MEDIUM, registration-time only** — it happens before play, not during live scoring.
The fix (`jdbc.batchUpdate`) is additive, local, and touches no frozen code and no tournament logic.

**Recommendation: include it only if P1-A and P1-B land comfortably.** It is the clearest measured
inefficiency found, but it is not blocking any other phase, and P1's job is to unblock P2 and P3.

> **Do not confuse this with result saving.** Batching *results* stays rejected
> (`00_MASTER_PLAN.md` §5): `cardRow()`'s `FOR UPDATE` means one transaction per batch would hold the
> card lock for the whole batch and block every other staff member on that card.

---

## 7. Preserved — mechanisms and invariants P1 must not disturb

### 7.1 Frozen code — untouched by every chunk above

Located **by symbol**, never by line (`03_INVARIANTS.md` warns citations drift; re-read 2026-08-22 and
confirmed at the lines below):

| Symbol | File | Line now |
|---|---|---|
| `replaceCard` | `src/application/tournament/store.ts` | 316 |
| `applyResultPatch` | " | 450 |
| `applyPairingsPatch` | " | 487 |
| `applySnapshotPublish` | " | 523 |
| `mutateCard` | " | 442 |
| `mergePublicCatalog` | " | 418 |

Also frozen: `use-card-sync.ts`, `use-public-sync.ts`, `snapshot-api.ts`,
`application/publicsnapshot/**`, and the pairing/ranking/diff/Gibson/final-round methods of
`TournamentCardService`.

**P1 is backend-only and adds a new read path. It touches none of these.** The single agreed
exception (gating the two hooks in `app-shell.tsx:151-152` on `!loading`) belongs to P2 and is **not**
taken in P1.

### 7.2 Module-level store state — must survive untouched

`publicScopeToken` is read or written at **eight** sites, not the three the older docs cite —
**VERIFIED** at `store.ts:272, 337, 390, 557, 669, 683, 890, 894`. Together with `publishedTokens`
(:361) and `bundleInflight` (:382) it implements viewer bundle dedup and scope guarding, and it is
invisible in any architecture diagram.

P1 does not touch the store. Recorded here because B5's constraint ("URL-derived scope lives in the
`/cards/[id]` route page only, never in `CardOverview`") governs P3-C, and the eight-site count makes
it **more** important, not less.

### 7.3 Verified invariants carried forward

| ID | Invariant | P1 impact |
|---|---|---|
| **A** | DB row == card store == second browser | untouched; re-run as a smoke check |
| **B** | SSE event type, order, payload shape, version semantics | untouched. The asymmetry is the invariant: **result save = DELTA (`changedPairings`); stage change = FULL CARD (`state`)** (R10, `fixtures/sse-baseline.json`, v2 to v10 monotonic). Any phase that changes this has broken B |
| **C** | Published snapshot semantically identical, **checksum must match** | untouched. Still **UNVERIFIED** — environment-blocked, waived in `07_P0_CLOSURE.md` §2 |
| **D** | Old FE + New BE, and New FE + Old BE | **This is P1's headline gate.** §9 |
| **E** | Multi-user editing loses nothing | **PASS at runtime** (R13): two concurrent saves gave distinct sequential versions 13 and 14, card ended at 14 (+2 exactly), one audit row each, capped diff correct on both paths. P1 adds no write path, so E is unaffected. *Limitation carried forward:* both writers were the same principal, so per-username audit attribution under concurrency remains untested |

### 7.4 Do-not-delete items relevant to P1

- `If-Match` in `mutateCard` — `CardController` ignores it, but `DevToolsController.java:25,31,37,43,50`
  **reads** it. Removing it breaks the tooling that generates test data.
- `WebPushService` — injected into `CardController`'s constructor and called. Removal is post-competition.
- Anonymous branch of `CardController.list():53` — **leave it exactly as is.** Changing it is
  SECURITY-01 territory (§4.3), which is carved out.

---

## 8. Rollback strategy

### 8.1 What makes rollback cheap here

| Property | Evidence | Label |
|---|---|---|
| **No schema change.** Migrations stop at `V34__tournament_shelving.sql`; P1 adds none — the new query reads existing columns | `backend/src/main/resources/db/migration/` | **VERIFIED** |
| rollback is therefore a **pure code revert**: no down-migration, no data repair, no ordering hazard | | follows |
| **Backend-only.** The Cloudflare Worker / Next frontend is not rebuilt or redeployed | P1 touches no file under `src/` except tests | **VERIFIED** by plan scope |
| **The new endpoint has no callers.** P3-B is what consumes it | `store.ts:668-687` — `load()` calls `GET /api/cards` when authenticated | **VERIFIED** |
| reverting P1-B is therefore **zero user-visible impact** | | follows |
| Production moves only on a merge to `main`; `render.yaml` pins no branch | 66 lines, no `branch:`/`autoDeploy:` key | **VERIFIED** |

### 8.2 Commit shape — each chunk independently revertible

```
p1-0  docs(ux-refactor): freeze P0 baseline and evidence
p1-0  chore(p0): remove four dead modules and four unused dependencies
p1-0  test(p0): fix the harness so npm test is a real gate
──────────────────────────────────────────────────────────────────────
p1-a1 feat(backend): add BadReauthenticationException + handler (403 + BAD_PASSWORD)
p1-a2 test(backend): assert the re-auth error contract, message text included
p1-b1 feat(backend): add scoped back-office card-summaries read method
p1-b2 feat(backend): expose GET /api/card-summaries, authenticated-only
p1-b3 test(backend): summaries endpoint status + shape, anonymous and all four roles
p1-d  perf(backend): batch player import inserts        (optional)
```

**`p1-a1` is the only commit that changes an existing response.** It is deliberately alone in its
commit so it can be reverted without losing the endpoint work, and vice versa.

### 8.3 Rollback ladder, cheapest first

| Level | Action | Restores | Cost |
|---|---|---|---|
| 0 | **Render dashboard, roll back to the previous deploy** | previous backend image | seconds, no git |
| 1 | `git revert p1-a1` and merge to `main` | 401 + stripped message (today's behaviour); the pre-flight still supplies the Thai text, so **users see no regression** | one deploy |
| 2 | `git revert p1-b2` | endpoint gone; nothing called it | one deploy, zero UX impact |
| 3 | `git revert` the whole P1 range | the P0 baseline | one deploy |
| 4 | `git checkout 6ce756c -- backend/` | pre-refactor backend, byte-exact | last resort |

### 8.4 The one-way door, and why there isn't one

There is no destructive step in P1: no migration, no data mutation, no deletion of an endpoint, no
config removal. The nearest thing to a one-way door is **P2 removing the pre-flight `verifyPassword`**
— and that is precisely why B2 mandates the ordering. If P1-A is reverted **after** P2 has shipped,
users get "Unauthorized" in an all-Thai interface.

**Rule: never revert P1-A once P2 has removed the pre-flight. Revert P2 first, then P1-A.**

### 8.5 Restoring the working tree if anything goes wrong before P1-0

The P0 working tree is not yet committed. Until `p1-0` lands, `git stash`, `git reset` and
`git checkout .` will **destroy P0 work that has no other copy**. `05_HANDOFF.md` §1 lists the exact
expected state; verify with `git status` before touching anything.

---

## 9. Verification gates

### 9.1 Automated — must be green before merge

| Gate | Command | Enforced by CI? |
|---|---|---|
| Backend tests | `mvn --batch-mode test` (in `backend/`) | **yes** — `.github/workflows/ci.yml:37` |
| Frontend lint / typecheck / build | `npm run lint && npm run typecheck && npm run build` | **yes** — `:21-23` |
| Frontend tests | `npm test` — must be **114/114, exit 0** | **no** — must be run locally. `05_HANDOFF.md` §1 |

Node must be **22.23.2** via `nvm use`; the machine default v26.6.0 does not match `.nvmrc`.

### 9.2 New tests P1 must add

**P1-A — error contract.** Assert the **message text a user would see**, not merely the status
(B2's explicit instruction — "assert the message text shown to the user, not merely 'did not log out'"):

| Case | Expect |
|---|---|
| wrong re-auth password | `403`, body `error` = `"รหัสผ่านไม่ถูกต้อง"`, `code` = `"BAD_PASSWORD"` |
| anonymous caller (`ReauthenticationService:24`) | `401`, **no** `BAD_PASSWORD` code |
| account row missing (`:33`) | `401`, **no** `BAD_PASSWORD` code |
| CSRF rejection | `403`, `error` = `"Forbidden"`, **no** `code` — proving status alone is not the discriminator |
| correct password | unchanged success |

**P1-B — the five-way matrix B3 requires** ("call the endpoint anonymously and as each of the four
roles; assert status and shape for all five"):

| Caller | Expect |
|---|---|
| anonymous | **401**, no body — *the B4 requirement: never a public projection* |
| STAFF | 200, only `staff_tournament_access` tournaments |
| DIRECTOR | 200, only `tournament_members` tournaments |
| ADMIN | 200, unrestricted (current contract preserved) |
| evicted session | **401** — same as anonymous, contrasted explicitly against `GET /api/cards`'s 200 |

Plus **value-correctness assertions**, which are the whole point of §4.1:

- a card in `PLAYER_REGISTRATION` with N players reports `playerCount = N`, **not 0**
- `runtimeStage` equals `tournament_cards.runtime_stage`, **not** the public `CASE`
- `version` equals `tournament_cards.version`, **not** `public_version`
- a director with zero assigned tournaments gets `200 []`, not 403 or 500

**Regression guard:** assert `GET /api/public/cards` is **byte-identical** before and after P1-B —
proof the anonymous cache was not poisoned (§4.2 rule 1).

### 9.3 Invariant gates after P1

| Invariant | How | Priority |
|---|---|---|
| **D — Old FE + New BE** | **The P1 gate.** Run the unmodified frontend against the P1 backend: log in as director and as staff; trigger a wrong-password re-auth on a pairing swap and confirm the Thai message still appears; confirm the card list still loads via `GET /api/cards`; confirm no console errors | **must** |
| **B — SSE** | Diff a result save, a pairing confirm and a results publish against `fixtures/sse-baseline.json`, normalising timestamps and `updatedAt`. Expect **no change** — P1 adds no event | **must** (cheap, and it is the frozen contract) |
| **A — store/DB agreement** | one result save, read Postgres directly, compare | should |
| **E — multi-user** | already PASS (R13); P1 adds no write path | re-run only if P1-D is included |
| **C — snapshot checksum** | **cannot run here** — environment-blocked and waived (`07_P0_CLOSURE.md` §2) | n/a |

### 9.4 Measurement to capture (the P1 success metric)

Against the isolated dataset, with the R1 poller excluded from counts (`HEARTBEAT_TICK_MS = 5_000`
equals `RUNTIME_SETTINGS_CACHE_TTL_SECONDS: 5`, producing ~17,280 idle txn/day and contaminating
every early reading):

| Metric | Baseline (measured, R9) | P1 target |
|---|---|---|
| Statements for a director card list, 3 cards | 22 (`1 + 7x3`) | **1** |
| Statements, 6 cards | **58** (measured exactly) | **1** |
| Payload, 6 cards | **120.9 KB** | ~1–2 KB |
| Round trips for a wrong re-auth password | 2 (pre-flight + mutation) + 1 (`/api/auth/me` from the 401 branch) | 2 in P1; **1 after P2** |

---

## 10. Explicitly out of scope for P1

| Item | Why | Where it lives |
|---|---|---|
| **B7 — anonymous `GET /api/cards`** | **Owner instruction: not part of this refactor** | `SECURITY-01_ANONYMOUS_CARD_EXPOSURE.md` |
| Removing the pre-flight `verifyPassword` | Ordering is mandatory — P1-A must ship first | P2 |
| Consuming the summaries endpoint | Frontend work; keeps Invariant D meaningful | P3-B |
| Session handling changes (`HttpSessionEventPublisher`, registry) | Changes session behaviour; P1 must not pre-empt P2 | P2 (§5) |
| `cards` array to `Record<id, Card>` | **Rejected** — rewrites four frozen functions; 28 consumer sites, 17 of them array ops inside the store | B1, permanently |
| Mutation `204` to returned row | **Removed** — 3 of 5 `void` methods are deletes; only `setEnabled` would benefit | `02_ARCHITECTURE_DECISIONS.md` §2.1 |
| Bulk result endpoint / parallel `saveAll` | **Cut** — `cardRow()`'s `FOR UPDATE` would hold the card lock for the batch; out-of-order responses defeat `applyResultPatch`'s version guard | `00_MASTER_PLAN.md` §5 |
| B8 — 5 s `runtime_settings` poller | Config-only fix (`RUNTIME_SETTINGS_CACHE_TTL_SECONDS` above the 5 s tick); adjacent to the frozen SSE layer | P6 |
| Adding `npm test` to CI | Safe now (suite is green), but an owner call | owner |
| Snapshot origin contradiction (D17) | Needs production/Worker config; P1 does not touch the snapshot path | owner |

---

## 11. Decisions needed before P1 starts

| # | Decision | Recommendation |
|---|---|---|
| **1** | **Endpoint path** — Option A `GET /api/cards/summaries` (edits `SecurityConfiguration`) vs **Option B `GET /api/card-summaries`** (no security-config change, no UUID-collision failure mode) | **Option B** (§4.3) |
| **2** | **Include P1-D (batch player import)?** Additive, measured, but unblocks nothing | Defer unless A and B land comfortably (§6) |
| **3** | **Run the logout/registry check as a P1 pre-flight?** Cheap, and the last session unknown before P2 | Yes — measurement only, no code (§5) |
| **4** | **Commit P0 first (P1-0)?** Required for independent rollback | Yes — mandatory prerequisite (§2, §8.5) |
| **5** | ADMIN branch stays unrestricted in P1-B, deferring D3's narrowing to P2/P3 | Confirm — preserves the current contract exactly (§4.4) |

---

## 12. Claims ledger — everything this plan asserts

### VERIFIED — read from source in the working tree at `6ce756c`

`ApiExceptionHandler` has exactly three handlers and none for `ResponseStatusException` ·
`server.error.include-message: never` at `application.yml:51-53` ·
`ReauthenticationService` throws 401 at `:24`, `:33`, `:36`, Thai reason only at `:36` ·
**76** `new ResponseStatusException(` sites across 13 files ·
**13** `requireCurrentPassword` call sites ·
`readError` at `store.ts:254-261` · `request()`'s 401 branch at `store.ts:294-303` does an extra
`fetchAuthState()` · 403 appears at exactly two sites in `src/` (`store.ts:734`, `:828`), both
treating 401 and 403 identically · `expireBackOfficeSession` reached only from the 401 branch ·
`ReauthenticationServiceTest:47-49` asserts `"401"` and will fail on 403 ·
`SecurityConfiguration:103-116` matcher order, with `:108`/`:109` proving an earlier narrower matcher
beats `:110`'s `permitAll()` · `:115` `/api/**` is the ADMIN/DIRECTOR/STAFF catch-all ·
`PublicCardReadCache.summaries()` SQL emits `public_stage`, `playerCount = 0` during
`PLAYER_REGISTRATION`, and `c.public_version` · `PublicCardReadCache` javadoc: "Back-office reads
never pass through this service" · `PublicCardQueryService.summaries(tournamentId)` filters the cached
catalog in memory · `store.ts:606-607` and `:691` refuse public summaries for authenticated users ·
`store.ts:668-687` — `load()` calls `GET /api/cards` when authenticated ·
`cardStageInfo` reads `runtimeStage`/`currentGame`/`playerCount`/`gameCount`/`status` ·
`TournamentCardService.list` is `SELECT id` + `get()` per card ·
CI runs `mvn test` but not `npm test` · `render.yaml` pins no branch ·
migrations stop at `V34` · `PublicCardController:57`/`:64` literal-beside-variable precedent ·
`addPlayersBulk` loops `jdbc.update` twice per player and `batchUpdate` is absent from the backend ·
frozen symbols at `store.ts` 316/450/487/523/442/418 · `publicScopeToken` at eight sites.

### VERIFIED at runtime (P0 captures, now frozen)

R9 `1 + 7N`, 58 statements / 120.9 KB for 6 cards · R8 800 INSERTs / 285 ms for 400 players ·
R10 SSE delta-vs-full asymmetry, v2 to v10 monotonic · R12 cap enforced, LRU eviction, evicted session
gets 200 + public projection, staff v11 vs public v7 · R13 Invariant E passes, versions 13/14, +2 exactly ·
R3 viewer path 3 requests / 0 SQL · R1 idle poller ~17,280 txn/day.

### UNVERIFIED — needs runtime or production access

Whether logout frees a `maximumSessions` registry slot (§5) ·
whether an external WAF blocks `/api/cards` (SECURITY-01) ·
the production value of `NEXT_PUBLIC_SNAPSHOT_ORIGIN` — the D17 contradiction ·
cold-cache query counts (waived) · snapshot checksum / Invariant C (waived) ·
the "~1 MB director login payload" figure — extrapolated from a measured 68 KB single 400-player card,
never measured end to end · Invariant D — reasoned from source in §3.3, **not executed**.

### ASSUMPTION — believed, untested

Spring MVC resolves a literal `@GetMapping("/summaries")` ahead of `@GetMapping("/{cardId}")` *within
`CardController`* — strong precedent in `PublicCardController`, but not executed there
(**Option B makes this moot**) · no client outside this repository depends on wrong-password re-auth
returning 401 rather than 403 · the ~1–2 KB projected summaries payload, which is a field-count
estimate, not a measurement.
