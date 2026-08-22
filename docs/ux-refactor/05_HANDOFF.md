# Handoff to the next agent

Read this file first, then `00_MASTER_PLAN.md`, `01_P0_BASELINE.md`,
`02_ARCHITECTURE_DECISIONS.md`, `03_INVARIANTS.md`, `04_BLOCKERS.md`.

> **P1 IS NOT APPROVED.**
> **P0 runtime baseline is INCOMPLETE.**
> **Continue from the current working tree — do NOT reset, revert or stash it.**

---

## 1. Current state

| Item | Value |
|---|---|
| Baseline commit | `6ce756c9d77590f1e482d23b25ccea360db9c0a6` (`main`) |
| Commit date / subject | 2026-08-21 18:01:14 +0700 — "Merge branch 'staging': give metaspace the headroom the running app needs" |
| Commits made during P0 | **none** — everything is uncommitted working-tree state |
| Node | 22.23.2 (`nvm use`; machine default v26.6.0 will not match `.nvmrc`) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | **exit 0 — 114 tests, 114 pass, 0 fail** (the 11 pre-existing failures were harness bugs; fixed test-files-only 2026-08-22 — `01_P0_BASELINE.md` §4) |
| `npm run build` | exit 0 |
| Bundle baseline | captured, 22 routes — table in `01_P0_BASELINE.md` §3 |

### Working tree (preserve exactly)

```
 M package-lock.json
 M package.json
D  src/application/tournament/mock-data.ts
D  src/application/tournament/use-push-notifications.ts
D  src/domain/tournament/pairing.ts
D  src/lib/utils.ts
```

### Files deleted in P0 (all had zero importers, re-verified before deletion)

| File | Lines |
|---|---|
| `src/application/tournament/use-push-notifications.ts` | 215 |
| `src/application/tournament/mock-data.ts` | 144 |
| `src/domain/tournament/pairing.ts` | 90 |
| `src/lib/utils.ts` | 36 |

`src/lib/clipboard.ts` was kept (imported by `src/app/admin/page.tsx`).

### Dependencies removed in P0

`@tanstack/react-query-devtools`, `class-variance-authority`, `clsx`, `tailwind-merge` — all with
zero import sites. `@tanstack/react-query` was **kept** (used by `src/infrastructure/query/provider.tsx`).

### Proof the prune was behaviour-neutral

lint, typecheck and build identical; test totals identical and the set of failing test names diffs
clean; the 22-route bundle table diffs clean line for line.

---

## 2. What was verified — the six P1 HOLD investigations

| # | Investigation | Result |
|---|---|---|
| 1 | **TenantService transaction boundaries** | **VERIFIED.** All mutating methods are `@Transactional`. Eight already return DTOs; only `deleteTournament` (:103), `deleteDirector` (:161), `deleteStaff` (:188), `setEnabled` (:221), `resetPassword` (:229) return `void`. Three are deletes, one changes nothing visible → **only `setEnabled` would benefit** |
| 2 | **`changed()` / `changedWithPublicDelta()`** | **VERIFIED.** `CardController.java:363-395`. Orchestration only, outside the transaction, so SSE publishes after commit. `changedWithPublicDelta` falls back to a generic bump on `RuntimeException` (:389-391). `events.publish(card)` ships the **full card** on the staff stream, so a summary-only card is auto-upgraded when a `state` event arrives |
| 3 | **`CardSummary` shape** | **VERIFIED sufficient.** `PublicCardDtos.java:12-25` supplies every field `cardStageInfo` reads (`stage-info.ts:22-39`), plus what `/cards` and the sidebar need. The `??` fallbacks were written for the summary case |
| 4 | **Spring routing precedence** | **VERIFIED by production precedent.** `PublicCardController` declares `@GetMapping("/cards/versions")` (:57) beside `@GetMapping("/cards/{cardId}")` (:64), and `/api/public/cards/versions` is called live (`use-public-sync.ts:226`). Literal beats variable here |
| 5 | **`maximumSessions(2)`** | **RESOLVED 2026-08-22 — cap IS enforced, LRU eviction; see `04_BLOCKERS.md` B4.** Original note: `SecurityConfiguration.java:141-142` sets it; no `HttpSessionEventPublisher`, no custom `SessionRegistry`, no `maxSessionsPreventsLogin` anywhere in `backend/src/main/java/`. Needs a runtime test — see `04_BLOCKERS.md` B4 |
| 6 | **`setActiveTournament` / `publicScopeToken`** | **VERIFIED coupling.** `store.ts:556-562` sets the module-level `publicScopeToken` and the `published` flag that gates SSE at `use-public-sync.ts:103,188`. URL-derived scope must live in the `/cards/[id]` route page only — see `04_BLOCKERS.md` B5 |

**Five of six closed from source. Number 5 cannot be closed without runtime.**

---

## 3. Important corrections to the previous plan

Record these so they are not re-proposed:

1. **P3-A "array → `Record<id, Card>`" is REJECTED.** It would force rewriting `replaceCard` and all
   three `apply*Patch` functions, which are declared invariants. The plan's "11 consumers" figure was
   wrong — there are 28 sites, 17 of them array operations inside the store.
   Replacement: keep the array, add a `summaries` field, use narrow selectors. (`04_BLOCKERS.md` B1)

2. **Removing the pre-flight `verifyPassword` is BLOCKED** until the backend can return a readable
   error. `server.error.include-message: never` strips the Thai reason and `ApiExceptionHandler` has
   no `ResponseStatusException` handler, so users would see "Unauthorized". The pre-flight is what
   produces the message today. (`04_BLOCKERS.md` B2)

3. **The summaries endpoint needs security/routing redesign.** `/api/cards/**` GET is `permitAll()`,
   so the endpoint is anonymous-reachable and must branch on identity like `CardController.list():53`.
   Routing precedence itself is fine. (`04_BLOCKERS.md` B3)

4. **"Mutation returns row instead of 204" is REMOVED from P1.** Verified as near-worthless: four of
   the eight endpoints are deletes and only `setEnabled` would benefit. (`02_ARCHITECTURE_DECISIONS.md` §2.1)

5. **The client fallback must handle 400, 404 and 405**, not 404 alone — a routing miss surfaces as a
   400 from UUID conversion. (`04_BLOCKERS.md` B3)

6. **`maximumSessions(2)` behaviour still requires runtime verification** before P2 touches session
   handling. (`04_BLOCKERS.md` B4)

7. **The bulk result endpoint and parallel `saveAll` were both cut** — `cardRow()` takes
   `SELECT … FOR UPDATE`, so batching degrades multi-user editing, and out-of-order responses defeat
   the `applyResultPatch` version guard. Sequential save stays; add a progress indicator only.
   (`00_MASTER_PLAN.md` §5, `03_INVARIANTS.md` §3.3)

---

## 4. Current blockers

Full evidence in `04_BLOCKERS.md`. Summary:

| ID | Blocker | Phase | Status |
|---|---|---|---|
| B1 | Array → Record rewrites the frozen SSE layer | P3-A | design corrected, must not be reintroduced |
| B2 | Pre-flight removal degrades re-auth errors to "Unauthorized" | P1 → P2 | not fixed |
| B3 | Summaries endpoint inherits `permitAll()`; fallback must cover 400/404/405 | P1, P3-B | not fixed |
| B4 | `maximumSessions(2)` with no registry cleanup | P2 | **RESOLVED** — cap IS enforced, evicts least-recently-used (5-login experiment). Residual: logout-frees-slot still unverified |
| B7 | `GET /api/cards` exposes all cards + rosters anonymously; **internet-reachable** | — | ⚠️ **pre-existing, owner decision required** |
| B8 | 5s `runtime_settings` poller at idle | P6 | recorded, config-only fix |
| B9 | Player import is row-by-row (800 stmts / 400 players) inside the card row lock | P1/P6 | recorded |
| B5 | URL-derived scope must not run on the viewer route | P3-C | constraint recorded |
| B6 | 11 pre-existing test failures | all | **RESOLVED** — harness fixed, 114/114 green. CI still does not run `npm test` (owner call) |

---

## 5. Runtime baseline still required

Toolchain is available and verified: Docker running, Java 17.0.12, Maven 3.9.9, Postgres listening on
`localhost:5432`, `.env` populated with all six required values.

Work stopped before writing to the local database: `generateMockPlayers`
(`src/application/tournament/store.ts:101` → `POST /api/dev/cards/{id}/players`) is documented as
replacing the current roster, and the contents of the local DB are unknown.

Still to capture:

- [ ] HAR for 5 flows: login (staff, director, admin, anonymous), card list, card overview, result entry, `/tour/{slug}` viewer
- [ ] DB query counts per endpoint (temporarily enable SQL logging or a datasource proxy)
- [ ] An **isolated** test tournament + cards, created without disturbing existing local data
- [ ] 400-player stress dataset, dumped so every phase starts from identical data
- [ ] SSE traces ×3: one result save, one pairing confirm, one results publish — event type, order, payload shape, version deltas
- [ ] Published snapshot JSON + checksum baseline (needs R2 credentials, which are not in the local `.env`)
- [ ] Screenshots, 14 routes × 3 breakpoints
- [ ] `maximumSessions(2)` behaviour: repeated login/logout on one account, then 3 concurrent logins

---

## 6. User decisions — ANSWERED 2026-08-22

| # | Question | Answer |
|---|---|---|
| **A** | Local DB | **Isolated only.** Create a new, clearly-marked test tournament + cards; read existing rows, never write them. `generateMockPlayers` may only ever target cards created by this work |
| **B** | The 11 failing tests | **Fix the harness first.** Done — test files only, 114/114 green. The phase gate is now "`npm test` is green" |
| **C** | Mutation `204` → row | **Confirmed removed from P1.** Reinstate only on new evidence of a concrete compatibility/correctness benefit |

### Original wording (for the record)

**A. Local database.** May we create an isolated test tournament and cards in the local Postgres
without touching existing data, or is the local DB disposable? (`generateMockPlayers` replaces the
roster of whatever card it targets.)

**B. The 11 failing tests.** Fix the test harness first (test files only, no product change,
estimated 2–3 hours) so the remaining phases have a trustworthy gate — or accept them as a recorded
pre-existing baseline and gate on "no new failures"? Note that adding `npm test` to CI before fixing
them would turn CI red.

**C. Scope confirmation.** Confirm removal of the "mutation returns a row instead of 204" work from
P1, on the evidence that only `setEnabled` would benefit.

---

## 7. Rules for the next agent

1. **Do not start P1** until the P0 runtime baseline is complete and the owner approves P1.
2. **Do not modify the SSE patch/apply logic** — `replaceCard`, `applyResultPatch`,
   `applyPairingsPatch`, `applySnapshotPublish`, `use-card-sync.ts`, `use-public-sync.ts`.
   The only pre-agreed exception is gating the two hooks in `app-shell.tsx:151-152` on `!loading`.
3. **Do not change production behaviour merely to make a test pass.** The 11 failures are a harness
   problem; fix the harness or leave them.
4. **Do not touch protected files or systems** listed in `03_INVARIANTS.md` §1 and §2 without
   explicit owner approval.
5. **Prefer evidence from source or runtime over assumptions.** Label every claim VERIFIED,
   UNVERIFIED or ASSUMPTION, with file and line.
6. **Any new architectural proposal must first inspect the real implementation.** Four confident
   claims in the previous plan were overturned by reading the code afterwards.
7. **One logical change per commit.**
8. **Run the relevant invariant tests after every gate** (`03_INVARIANTS.md` §4).
9. **Update these handoff documents after every meaningful discovery**, especially
   `04_BLOCKERS.md` and this file.

---

## 8. Exact next action

1. Read all six files in `docs/ux-refactor/`.
2. Run `git status` and `git diff` (and `git diff --cached`) to confirm the working tree matches §1
   above. Do not reset or revert it.
3. Ask the user **only** the three decisions in §6.
4. Wait for answers before doing anything else.

Do not start P1. Do not refactor further. Do not make speculative fixes.

---

**STATUS: P0 STATIC COMPLETE / P0 RUNTIME INCOMPLETE / P1 NOT APPROVED**

---

# P0 FINAL GATE — 2026-08-22

Baseline commit `6ce756c9d77590f1e482d23b25ccea360db9c0a6`. No commits made; all work is
working-tree state plus `docs/ux-refactor/`.

**Static baseline:** PASS. lint 0 · typecheck 0 · build 0. 22-route bundle table **byte-identical**
to the pre-prune capture (`diff` clean). Prune = 4 dead files (485 lines) + 4 unused dependencies,
zero residual references anywhere in `src/` or `backend/src/main`.

**Runtime baseline:** CAPTURED, with two named gaps. Viewer flow = **3 origin requests, 0 SQL**
(fully cache-served). Production-build login page = **4 requests, 2× `/api/auth/me`**. Admin
`GET /api/cards` = **120.9 KB, 58 statements, N+1 of `1 + 7N`**. 400-player card = **68 KB**.
Isolated dataset created and proven isolated. **Gaps: cold-cache query counts** (`/actuator` is
outside `/api/**`, so the Next proxy never forwards it) and **snapshot checksum** (no R2 credentials
locally). Both recorded as gaps, not estimated.

**Test baseline:** PASS — **114/114, exit 0** (was 103/114). The 11 failures were **two** harness
bugs, not the one recorded: `?case=N` never busts a CommonJS require cache, *and* `sessionStorage`
does not exist in Node. Fixed **test-files-only**; zero product change. A false-passing test was
found and made real. **The phase gate is now "`npm test` is green", not "no new failures".**

**Session behavior:** **B4 RESOLVED.** `maximumSessions(2)` **is** enforced and evicts
least-recently-used — proved by 5 logins with the instrumented session deliberately left idle (the
first probe was inconclusive by construction and is reported as such). Eviction order is the
desirable one. **Sharp edge:** an evicted session gets **200 + public projection** from
`GET /api/cards`, not a 401, including the public version/stage (staff 11 vs public 7). Severity LOW
— three existing defences cover it. **P2 must keep all three.** Still unverified: whether logout
frees a registry slot.

**SSE invariant:** BASELINED. Fixture at `docs/ux-refactor/fixtures/sse-baseline.json`. Versions
strictly monotonic **v2→v10, no gaps**. The load-bearing property: **result save = DELTA
(`changedPairings`), stage change = FULL CARD (`state`)** — confirming §2.2 at runtime. Business
logic spot-checked: `calculatedDiff = min(|420−385|, 350) = 35` ✅.

**Snapshot invariant:** **NOT VERIFIED — environment-blocked.** `NEXT_PUBLIC_SNAPSHOT_ORIGIN` is
unset locally and there are no R2 credentials, so nothing can be published or checksummed here.
Unresolved contradiction: a prior note says the variable is unset in the Worker build while D17 says
it is set in production. **Both cannot be true**; only the owner can settle it.

**Multi-user invariant:** **PASS — verified at runtime 2026-08-22** (`06_P0_RUNTIME_BASELINE.md` R13).
Two simultaneous saves (`Promise.all`) to different pairings in the same card/game from a shared
start version 12: both persisted (`03:48:46.174` / `.177`), responses carried **distinct sequential
versions 13 and 14**, card ended at **14 = +2 exactly**, one audit row each, 2 of 4 pairings written
and no phantom rows, capped-diff correct on both paths (200 / 40). **No lost update.** The `FOR UPDATE`
serialisation of §3.3 is confirmed empirically. *Limitation:* both writers were the same principal
(`staff`), so per-username audit attribution under concurrency remains untested.

**DB/query baseline:** CAPTURED. Idle floor: a **5-second `runtime_settings` poller** (~17,280
txn/day with zero users) caused by `HEARTBEAT_TICK_MS = 5_000` exactly equalling the 5 s cache TTL,
with the read *inside* the guard expression. It contaminated every early measurement and had to be
excluded. Public/viewer endpoints: **0 SQL** warm. Admin card list: `1 + 7N`. **Player import: 800
row-by-row INSERTs for 400 players, inside the `FOR UPDATE` card lock — `batchUpdate` appears nowhere
in the backend.**

**Remaining blockers:**

| ID | Status |
|---|---|
| **B7** ⚠️ | **HIGHEST.** `GET /api/cards` serves every card + all player rosters anonymously, and is **internet-reachable** (no filter at any layer; no `middleware.ts` exists). Pre-existing. **Owner decision required.** |
| B2 | OPEN — pre-flight removal still blocked until P1 adds a readable error |
| B3 | **RE-SCOPE FIRST** — summaries endpoints already exist (`/api/public/cards`, `/api/public/tournaments/{token}/cards`) in the exact `CardSummary` shape. P1 may be far smaller than "build a new endpoint" |
| B9 | Row-by-row import — recorded, fix is additive |
| B8 | 5 s poller — config-only fix |
| B1, B5, B6 | CLOSED (B1/B5 re-verified; B5 risk is *larger* than recorded — 8 `publicScopeToken` sites, not 3) |

**Evidence:** `01_P0_BASELINE.md` §4 (harness), `06_P0_RUNTIME_BASELINE.md` R1–R12 (runtime),
`04_BLOCKERS.md` B1–B9, `fixtures/sse-baseline.json` (Invariant B).
Docs corrected for **line-number drift** — every claim's substance held, but citations were off by up
to 11 lines and `applyResultPatch :445-478` pointed *inside* `mutateCard`. Locate frozen code by
symbol, never by line.

**Environment restored:** Postgres `log_min_duration_statement` back to `default`; `.claude/launch.json`
restored byte-exact (hash verified); pre-existing data **byte-identical** (25 + 84 = 109 players).

**Recommendation:** **P0 is complete enough to close, with three caveats that are the owner's to
weigh, not mine.**

1. **B7 should be decided before the competition, independent of this refactor.** It is the only
   finding with a real-world blast radius.
2. **Invariant E should be run before P1 touches anything concurrent** — it is cheap (two logged-in
   browsers, two result saves) and it is the one invariant with no runtime evidence.
3. **Re-scope B3 before implementing it.** Building a new summaries endpoint may be redundant.

Nothing found contradicts the P1 design. The prune is behaviour-neutral, the test gate is real again,
and the SSE contract has a diffable baseline.

**P1 REMAINS NOT APPROVED — awaiting owner sign-off.**
