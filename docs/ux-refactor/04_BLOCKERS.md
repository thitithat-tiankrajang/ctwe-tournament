# Blockers

Every blocker below was found by re-reading source **after** the plan was written, and each
overturned a claim the plan made confidently. None of them is fixed.

Labels: **VERIFIED** = proven from source · **UNVERIFIED** = needs runtime proof.

---

## B1 — Converting `cards` from array to `Record<id, Card>` would rewrite the frozen SSE layer

**Status: VERIFIED — independently re-checked 2026-08-22. Design already corrected — do not reintroduce.**

> **Re-verification.** All 17 cited line numbers were read individually and every one is genuinely an
> array operation on `state.cards` (`.find` / `.map` / `.filter` / spread), including the four frozen
> functions at :317-322, :454, :491 and :527. The citations are accurate; the conclusion holds.

**Evidence.** `state.cards` is consumed at 28 sites, not the 11 the plan claimed. Eleven are React
subscribers; **seventeen are array operations inside `src/application/tournament/store.ts`**:

```
:317, :321, :322   replaceCard              <-- frozen
:399               loadBundle merge
:419               mergePublicCatalog
:454               applyResultPatch         <-- frozen
:491               applyPairingsPatch       <-- frozen
:527               applySnapshotPublish     <-- frozen
:580               syncCard 404 path
:610, :617, :618   applyPublicSummary
:625, :626         removePublicCard
:869               deleteCard
:908               deleteTournament
:925               archiveTournament
```

**Failure scenario.** Changing the container forces a rewrite of `replaceCard` and all three
`apply*Patch` functions. Their correctness rests on untyped invariants — the `card.version >= version`
guards and returning the *same* state object to preserve reference equality (`store.ts:459`; the
sibling guards are :493 and :529 — the previously cited :466 was wrong). A
single mistake produces silent divergence between the store and the database during live result
entry, and because `patched` would still return `true`, the `syncCard` safety net at `store.ts:795`
never fires.

**Required fix.** Keep `cards: TournamentCard[]`. Add `summaries: PublicCardSummary[]` as a separate
field. Achieve the render goal (AppShell not re-rendering per SSE event) with **selectors**, not a
container change.

**Phase affected:** P3-A (redefined accordingly in `00_MASTER_PLAN.md`).

**Regression test:** Invariant B (SSE trace diff) and Invariant A.

---

## B2 — Removing the pre-flight `verifyPassword` degrades every re-auth error to "Unauthorized"

**Status: VERIFIED. Not fixed.**

**Evidence.**

1. `backend/src/main/resources/application.yml:51-53`

   ```yaml
   error:
     include-message: never
     include-stacktrace: never
   ```

2. `backend/.../infrastructure/security/ReauthenticationService.java:36`

   ```java
   if (hash == null || !passwordEncoder.matches(password, hash))
       throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "รหัสผ่านไม่ถูกต้อง");
   ```

3. `backend/.../web/ApiExceptionHandler.java` handles only `IllegalArgumentException`,
   `MethodArgumentNotValidException` and `DataIntegrityViolationException` — **no handler for
   `ResponseStatusException`**, so Spring's default error body is used and, with
   `include-message: never`, the Thai reason is stripped.

4. `src/application/tournament/store.ts:257` (in `readError`, :254 — the previously cited :246 was wrong)

   ```ts
   return payload.error ?? payload.message ?? `Request failed (${response.status})`;
   ```

   Spring's default body carries `error: "Unauthorized"`, so this returns **"Unauthorized"**.

**Why it works today.** The Thai message comes from the pre-flight `verifyPassword()` boolean, whose
call sites supply their own text: `src/app/cards/[id]/tables/page.tsx:102`,
`src/app/cards/[id]/games/page.tsx:270`, `src/ui/components/reopen-registration.tsx:52`.
The pre-flight is **not** redundant; it is what produces a usable error message.

**Failure scenario, step by step.**
1. P2 deletes the pre-flight call.
2. A director types the wrong password when swapping a pairing.
3. Backend throws 401/403 with the reason stripped.
4. `readError` returns `"Unauthorized"`.
5. An all-Thai interface shows the English word "Unauthorized" mid-competition.

**Required fix (ordering is mandatory).** In **P1**, add an exception handler that returns
`{ status, error: <Thai reason>, code: "BAD_PASSWORD" }` with 403 for a wrong re-auth password,
keeping 401 for the genuine no-session cases at `ReauthenticationService.java:24` and `:33`.
Only **then** may P2 remove the pre-flight.

**Also required:** CSRF failures are also 403 (Spring's default `AccessDeniedHandler`, no custom
handler configured). `BAD_PASSWORD` and CSRF must be distinguishable by a body `code`, not by status
alone, or an expired CSRF token will be reported as "wrong password".

**Phase affected:** P1 (fix) → P2 (removal).

**Regression test:** assert the **message text** shown to the user, not merely "did not log out".

---

## B3 — A new `GET /api/cards/summaries` inherits `permitAll()`

**Status: VERIFIED (security); routing precedence resolved.**

**Evidence.** `backend/.../infrastructure/security/SecurityConfiguration.java:110`:

```java
.requestMatchers(HttpMethod.GET, "/api/cards", "/api/cards/**").permitAll()
```

Any new `GET` under `/api/cards/**` is anonymous-reachable. This is why the existing
`CardController.list()` branches on identity at `:53`:

```java
if (!backOffice(authentication)) return publicCards.list();
```

**Routing precedence — resolved.** `PublicCardController` already declares both
`@GetMapping("/cards/versions")` (:57) and `@GetMapping("/cards/{cardId}")` (:64), and
`/api/public/cards/versions` is called in production (`src/application/tournament/use-public-sync.ts:226`).
A literal sibling of a UUID path variable works in this codebase.

**Failure scenario.** If the new endpoint is written assuming `Authentication` is non-null, an
anonymous request produces a 500. Separately, if any path variant *does* fall through to
`{cardId}`, `"summaries"` fails UUID conversion and returns **400**, which a 404-only client
fallback will not catch — the card list silently renders empty.

**Required fix.**
1. The controller must handle anonymous callers explicitly, mirroring `list()` at `CardController:53`.
2. Tournament scoping must be enforced in the controller, not assumed from the security config.
3. The client fallback to `/api/cards` must trigger on **400, 404 and 405**, not 404 alone.

**Phase affected:** P1 (endpoint) and P3-B (fallback).

**Regression test:** call the endpoint anonymously and as each of the four roles; assert status and
shape for all five.

---

## B4 — `maximumSessions(2)` with no session-registry cleanup

**Status: RESOLVED 2026-08-22 by runtime experiment. The cap IS enforced, and it evicts
least-recently-used. P2's blocking question is answered.**

### The experiment

Five sequential logins as `staff` against a limit of 2. One session ("B", the Browser pane) was
instrumented and then deliberately **left idle**, because the first attempt proved nothing: B had been
receiving constant requests, making it the *most*-recently-used session, so its survival was
consistent with both "cap works" and "cap is a no-op".

| Step | Result |
|---|---|
| Logins #1, #2 (B established) | both alive |
| Login #3, B still actively used | **B survived** — inconclusive by design |
| Logins #4, #5, B left idle | **B EXPIRED** |

**Conclusion: `maximumSessions(2)` is genuinely enforced and evicts the least-recently-used session.**
The earlier ASSUMPTION that the registry might never populate is **disproved**. An actively-used
session is the last to be evicted, which is the desirable ordering for a staff member mid-result-entry.

### What an evicted session actually observes — the part that matters for P2

Measured on the expired session:

| Request | Status | Body |
|---|---|---|
| `GET /api/auth/me` | **200** | `authenticated: false` (it is `permitAll`) |
| `GET /api/admin/tournaments` | **401** | empty |
| `GET /api/cards` | **200** | **the anonymous PUBLIC projection** |

The third row is the sharp edge. Because `GET /api/cards` is `permitAll` (B7), an evicted staff
session does not get a 401 there — it silently receives public data: `rules: 0`, `tables: 0`,
`audit: 0`, and **the public version and public stage instead of the staff ones**. Verified against
the database for the same card:

```
staff version = 11   public_version = 7
real stage    = PAIRING_PREVIEW      public stage = TABLE_PAIRING
```

**Assessed severity: LOW — the existing design already defends this, in three independent layers.**
This is recorded so P2 does not remove a defence without realising what it was for:

1. `replaceCard`'s guard (`store.ts:317-319`) discards the lower-version public payload for any card
   already held — `existing.version 11 > updated.version 7` → dropped. `03_INVARIANTS.md` §3.1 doing
   exactly its job.
2. Eviction terminates the SSE stream; `use-card-sync.ts:93` calls `ensureSessionAlive()` on stream
   error, which confirms via `/api/auth/me` and redirects. This is the fast detector.
3. `use-session-guard.ts` re-checks on `focus`, `online`, `pageshow` and `visibilitychange`, plus a
   30-minute interval.

**Rule for P2:** the eviction is real, so all three defences must survive the session rewrite. The
residual exposure window — a focused tab making only `GET /api/cards` reads whose SSE has not yet
errored — is narrow but non-zero, and would widen if any layer is dropped.

### Still UNVERIFIED (low priority, does not block P2)

Whether a **logout** frees its registry slot. With no `HttpSessionEventPublisher`, phantom entries
could accumulate so the *effective* cap falls below 2 over an event day — relevant under D6 (shared
venue machines, repeated logins). Testing it needs a login/logout/login cycle with an instrumented
idle session. **Recommended before the competition, not before P1.**

---

### Original finding (superseded, kept for the record)

**Status: absence of wiring VERIFIED; behaviour UNVERIFIED.**

**Evidence.** `backend/.../infrastructure/security/SecurityConfiguration.java:141-142`:

```java
.sessionManagement(session -> session
    .sessionFixation(fixation -> fixation.migrateSession())
    .maximumSessions(2))
```

A grep of `backend/src/main/java/` finds no `HttpSessionEventPublisher`, no custom `SessionRegistry`
and no `maxSessionsPreventsLogin`. All Spring defaults.

**Risk (ASSUMPTION — must be tested).** Without an `HttpSessionEventPublisher`, sessions destroyed by
timeout or logout may never be removed from the registry. The per-username count could then grow
until a later login expires a session that is actively in use. Under D6/D9 (shared venue machines,
individual accounts, repeated logins) this is plausible and would surface as a staff member being
silently logged out mid-result-entry.

This is **pre-existing**, not introduced by the refactor — but P2 rewrites session handling and must
not proceed without knowing the real behaviour.

**Required verification.** On the local stack: log in and out repeatedly with one account, then log
in from three places, and record what happens to the earlier sessions and what status code the
expired one receives.

**Phase affected:** P2.

---

## B5 — URL-derived scope must not run on the viewer route

**Status: VERIFIED — independently re-checked 2026-08-22, and the risk is LARGER than recorded.**

> **Re-verification.** `setActiveTournament` (:556-563) does set
> `publicScopeToken = tournament?.accessToken ?? null` exactly as documented, and
> `use-public-sync.ts:103` / `:188` do gate `shouldUseRealtime(...)` on
> `activeTournament?.published === true`.
>
> **New:** `publicScopeToken` is read or written at **eight** sites, not the three the docs cite —
> `:272, :337, :390, :557, :669, :683, :890, :894`. The extra ones (`:272` reset, `:683` adopt-on-load,
> `:890`/`:894` claim-and-release) are exactly the kind of module-level state that a store
> restructure drops silently. This makes B5's "put it in the route page only" constraint **more**
> important, not less.

**Evidence.** `src/application/tournament/store.ts:556-562` — `setActiveTournament` sets the
module-level `publicScopeToken = tournament?.accessToken ?? null` and stores the object (including
`published`) in `activeTournament`.

- `publicScopeToken` guards the viewer bundle against the app-wide catalog load (`store.ts:390`) and
  selects the scoped-bundle path in `load()` (`store.ts:669`).
- `activeTournament?.published` is read by `src/application/tournament/use-public-sync.ts:103` and
  `:188`, gating `shouldUseRealtime()` — i.e. whether an SSE stream and a realtime-config request
  happen at all.

**Failure scenario.** P3-C plans to derive `activeTournament` from a resolved card. If that code runs
on the viewer path, it calls `setActiveTournament({ id, name })` with no `accessToken` and no
`published`, which (a) nulls the scope token, losing viewer bundle dedup, and (b) makes `published`
undefined, so a published tournament reopens SSE and fetches realtime-config — breaking the
"published path issues zero origin requests" invariant.

**Required fix.** Put the resolution in the `/cards/[id]` **route page**, never inside
`CardOverview`, which is shared with `/tour/[token]` (`src/ui/components/tournament-viewer.tsx:126`).

**Phase affected:** P3-C.

---

## B6 — Test suite is red at the baseline and CI does not run it

**Status: RESOLVED 2026-08-22 (owner decision B = fix the harness first). Test files only.**

11 of 114 tests failed on a clean checkout of `6ce756c`. Re-verification found **two** root causes,
not the one previously recorded — full detail in `01_P0_BASELINE.md` §4.2:

1. `import("./mod.ts?case=N")` never isolated anything, because `package.json` has no
   `"type": "module"` and tsx therefore compiles to **CommonJS**, where a query string does not key
   the require cache. Proven by probe.
   Note the earlier claim that `system-state.ts` binds its env at module load was **wrong** — it
   resolves lazily in `origin()` (:30-32); the leaking state is the `cached` memo (:39), and the
   module already exports `resetSystemStateCache()` (:42) for exactly this.
2. `sessionStorage` is `undefined` under Node 22 without `--experimental-webstorage`, and
   `readMemo`/`writeMemo` swallow the ReferenceError by design — so the memo never wrote and
   `snapshot-api` case 16 failed `2 !== 1`. **Unrelated to the module cache.**

**No product code was changed.** `npm test` is now **114/114, exit 0**; lint/typecheck/build
unchanged; the 22-route bundle table diffs byte-identical.

**Impact on the plan (updated).** The gate is now **"`npm test` must be green"**, as originally
intended — not "no new failures".

**Residual risk (UNVERIFIED, not scheduled):** CI still does not run `npm test`
(`.github/workflows/ci.yml` runs lint, typecheck, build, `mvn test`). The suite can rot again
unnoticed. Adding it to CI is now safe (it is green) — recommend it, but it is an owner call.

---

## Known latent issues — documented, not scheduled

| Issue | Evidence | Note |
|---|---|---|
| `applyResultPatch` skips out-of-order patches while reporting success | `store.ts:466` — `if (card.version >= version) { patched = true; return card; }` | Unreachable while saves are sequential. **Do not parallelise result saving without fixing this guard first.** |
| `saveAll` keeps a draft after a failed save, so a retry sends `editExisting: false` against an already-saved row and is rejected with "กรุณากด Edit ก่อน" | `result-entry-grid.tsx:400` (draft kept on failure), `:415` (`editExisting = isRecorded(pairing)` from stale store) | Suggested minimum fix: after the loop, if any save failed, run `syncCard(cardId)` once |
| No `AbortController` on any card mutation | grep: only `system-state.ts:64` and `snapshot-api.ts:122` | A "cancel" button can only stop the loop sending the next request; the in-flight one completes. Label it accordingly |
| Progress count would read as counting down | `filteredSavable` shrinks as drafts are deleted | Capture the total before the loop |
| Retraction can remain visible for up to 5 minutes | `PublicSnapshotPublisher.java:110-111, 307-309` — purge is best effort, `max-age=300` | Wording fix scheduled for P4 |
| `next-env.d.ts` is tracked but rewritten by builds | flips between `./.next-dev/types/routes.d.ts` and `./.next/types/routes.d.ts` | Produces spurious diffs; consider gitignoring |

---

## B7 — `GET /api/cards` exposes every card platform-wide to anonymous callers  ⚠️ HIGHEST-SEVERITY OPEN ITEM

**Status: VERIFIED in source, at runtime, AND through the production proxy path. PRE-EXISTING — not
introduced by this refactor. Not fixed. OWNER DECISION REQUIRED BEFORE THE COMPETITION.**

Anonymous `GET /api/cards` returns 200 / 59,669 bytes — all 5 cards from both local tournaments, each
with its full player roster (first name, surname, school). The projection correctly strips `rules`,
`tables` and `audit`, but `PublicCardReadCache.summaries()` (:34-56) draws from
`FROM tournament_cards c ORDER BY c.created_at DESC` with **no `WHERE` clause**, so no tournament
status, published or shelved filter applies.

By contrast the token-scoped path enforces closure correctly —
`TenantService.resolveOpenTournament` (:318-332) ends `WHERE t.access_token = ? AND t.status = 'OPEN'`.
So D18's "closing the link hides live data" holds for `/tour/{token}` and is bypassed by `/api/cards`.
Verified live: `/tour/bkk` shows 4 cards; `/api/cards` returns all 5.

Aggravating detail: `TenantService.java:46` allows an access token of only **3 characters**.

### Reachability — **now VERIFIED. It is internet-reachable.**

The open question is closed, and the answer is the bad one. The production request path contains no
filter at any layer:

| Layer | Finding |
|---|---|
| `src/app/api/[...path]/route.ts` | A catch-all that binds every method to `proxyToRender`. No path list |
| `src/infrastructure/http/render-backend-proxy.ts:27` | `upstream.pathname = incoming.pathname` — the path is forwarded **verbatim**. No allowlist, no denylist |
| `middleware.ts` | **Does not exist** anywhere in the repo |
| `open-next.config.ts` | Bare `defineCloudflareConfig()` — no routing overrides |
| `wrangler.jsonc` | Serves the Next app; `workers_dev: true` |

Proven end-to-end against the **same route that runs in production** (local frontend proxy, no
credentials, no cookies):

```
curl http://localhost:3000/api/cards
-> 200, 59,669 bytes
   cards returned: 5      tournaments represented: 2      player records exposed: 109
```

So `https://<the-worker-host>/api/cards` serves every tournament's full roster to anyone, with no
token and no session — unless something **outside this repository** (a Cloudflare WAF rule or
similar) blocks it. That is the only remaining thing to confirm, and only the owner can.

`CORS_ALLOWED_ORIGINS` in `render.yaml` does **not** mitigate this: CORS constrains browsers, not
`curl`. Note also that `ctwe-tournament-api` is a Render `type: web` service, which additionally gets
its own public hostname.

**Effect on B3: it lowers it.** A new `GET /api/cards/summaries` under the same `permitAll()` matcher
would expose strictly *less* than `/api/cards` already does. B3's controller requirements still stand.

**Do not fix during P0.** Changing anonymous data exposure three weeks before a competition is an
owner decision, and the viewer depends on this projection.

---

## B8 — A 5-second `runtime_settings` poller runs forever with zero users

**Status: VERIFIED at runtime. Benign. Recorded, not scheduled.**

`HEARTBEAT_TICK_MS = 5_000L` (`CardEventPublisher.java:50`) exactly equals
`RUNTIME_SETTINGS_CACHE_TTL_SECONDS: 5` (`application.yml:105`), so the cache is expired on nearly
every tick; and `settings.get()` sits *inside* the guard expression
(`CardEventPublisher.java:270`), so the read happens even with no SSE subscribers. Measured: 3
statements (`BEGIN READ ONLY` / `SELECT` / `COMMIT`) every 5s in a request-free window
≈ 17,280 transactions/day at idle.

**Cheapest fix is config-only** — raise `RUNTIME_SETTINGS_CACHE_TTL_SECONDS` above the tick, no code
change, no risk to the frozen SSE layer. Candidate for P6. **Not a P0 action.**

It also contaminates every DB measurement and must be excluded from future query counts —
`06_P0_RUNTIME_BASELINE.md` §R1.

---

## B9 — Player import is row-by-row, inside the card row lock

**Status: VERIFIED at runtime and in source. PRE-EXISTING. Recorded, not scheduled.**

Importing 400 players issues **800 individual INSERTs** (400 `players` + 400 `standings`).
This is the **production** Excel-import path, not just the dev tool:
`addPlayersBulk` (`TournamentCardService.java:236-252`) loops `jdbc.update` twice per player, and
**`batchUpdate` appears nowhere in `backend/src/main/java`**.

The method is `@Transactional` and opens with `requireStage(...)` → `cardRow()` →
`SELECT … FOR UPDATE`, so the card row is locked for all 800 round trips. Measured **285 ms** locally
(database on the same host); production is Render → managed Postgres, so at 1–5 ms per statement this
becomes roughly **0.8–4 s of held lock** per import.

**Risk: MEDIUM but registration-time only** — it happens before play, not during live scoring.

**Fix (future, not P0):** `jdbc.batchUpdate`. Additive, local, touches no frozen code and no
tournament logic. Candidate for P1 or P6.

**Do not confuse this with result saving.** Batching *results* stays rejected
(`00_MASTER_PLAN.md` §5) — that is a different transaction shape with different concurrency risk.
