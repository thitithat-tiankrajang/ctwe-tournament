# P2 — Auth consolidation. PLAN, derived from evidence.

```
STATUS: PLAN — derived 2026-08-22 from the existing evidence set, then executed in this run.
PREREQUISITE: P1 CLOSED (10_P1_CLOSURE.md). P1-A committed and verified -> B2's ordering is satisfied.
```

P2 had no plan document of its own; its scope was scattered across `00_MASTER_PLAN.md` §3/§6,
`04_BLOCKERS.md` B2/B4, `03_INVARIANTS.md` §1, and `09_B4_SESSION_REGISTRY_MEASUREMENT.md` §5.
This file consolidates it. It cites the frozen evidence rather than editing it.

Labels: **VERIFIED** = read from source or measured · **UNVERIFIED** = needs runtime ·
**ASSUMPTION** = believed, untested.

---

## 1. Objective

`00_MASTER_PLAN.md` §3: *"Auth + login request consolidation (frontend)."* Concretely, the metrics
P2 owns (§6):

| Metric | Baseline | Target | Owned by |
|---|---|---|---|
| Password re-auth round trips | **2** (pre-flight + mutation) | **1** | P2-B |
| Requests per staff login | 9, incl. 3× `/api/auth/me` (login *page* measured at 4 / 2×, R6) | 4, 1× | P2-D/E |

Plus two correctness items routed here by earlier phases:

- **B2 removal half** — delete the frontend pre-flight now that P1-A supplies a readable error.
- **`09_...` §4** — an evicted session's first response is `200` + a non-JSON body, which makes
  `JSON.parse` throw a `SyntaxError` instead of surfacing as a session expiry.

## 2. Chunks

| Chunk | Delivers | Touches |
|---|---|---|
| **P2-A** | A typed API error carrying `status` + `code`, so clients can discriminate `BAD_PASSWORD` from CSRF. No behaviour change | `store.ts` |
| **P2-B** | Remove the **3** pre-flight `verifyPassword` calls; the mutation's own 403 now supplies the message | `store.ts` consumers ×3 |
| **P2-C** | Handle the `200` + non-JSON eviction response as a session expiry, not a parse error | `store.ts` |
| **P2-D** | Gate the two sync hooks on `!loading` (the pre-agreed `03_INVARIANTS.md` §1 exception) | `app-shell.tsx` |
| **P2-E** | `/api/auth/me` duplication on the login page (R6) — **measure first**, fix only if the cause is outside frozen code | tbd |
| **DEFERRED** | `HttpSessionEventPublisher` | **owner decision — see §6** |

### 2.1 P2-A — discriminate on the body `code`, never on status

**VERIFIED.** `readError` (`store.ts:254-261`) returns only a string, so the `code` P1-A added is
discarded. `request()` (`:284`) throws a plain `Error`.

`08_P1_PLAN.md` §3.3 makes this mandatory, not cosmetic:

> *"CSRF failure is also 403, so status alone is ambiguous … therefore clients must discriminate on
> the body `code`, never on status."*

Without this, removing the pre-flight would make a CSRF failure indistinguishable from a mistyped
password. Add an `ApiError` carrying `status` and `code`; keep `message` identical so every existing
`error.message` consumer is unaffected.

### 2.2 P2-B — remove the pre-flight, but only where it is one

**This is the correction that matters.** `verifyPassword` has **5** call sites, and they are **not**
all pre-flights (**VERIFIED**, read individually):

| # | Site | Kind | Action |
|---|---|---|---|
| 1 | `app/cards/[id]/tables/page.tsx:101` — before `swapPlayers` | pre-flight; the same password is then sent to the mutation | **REMOVE** |
| 2 | `app/cards/[id]/games/page.tsx:269` — before `swapPlayers`; its own comment reads *"The API verifies the password again as well"* | pre-flight | **REMOVE** |
| 3 | `ui/components/reopen-registration.tsx:52` — before `reopenRegistration` | pre-flight | **REMOVE** |
| 4 | `app/cards/[id]/games/page.tsx:156` — `onUnlockPublishedEdit`, returns the password to unlock final-round editing | **standalone gate**, no mutation follows | **KEEP** |
| 5 | `app/cards/[id]/games/page.tsx:302` — `confirmPw`, sets `editUnlocked` local state | **standalone gate**, no mutation follows | **KEEP** |

Sites 4 and 5 have **no subsequent request to carry the password**. Deleting them would either
remove the check entirely or invent a new one. The metric being chased — "2 round trips → 1" — only
exists where a pre-flight is *followed by* a mutation carrying the same password. **`verifyPassword`
therefore stays in the store.**

**VERIFIED** the 3 removable sites all forward the password: `swapPlayers` (`store.ts:777`) and
`reopenRegistration` (`:765`) both put it in the request body.

**VERIFIED** the message will still reach the user: `mutateCard` → `request()` → `readError` reads
`payload.error`, and P1-A's handler emits `error: "รหัสผ่านไม่ถูกต้อง"` with `code: "BAD_PASSWORD"`.
Proven end-to-end through the production proxy in `10_P1_CLOSURE.md` §6.

**Scope note.** A 403 *without* a `code` (CSRF, permission, stage) still renders Spring's English
`"Forbidden"`, because `include-message: never` strips every other reason. That is **pre-existing on
the mutation path** — the pre-flight never covered it — and surfacing the other 75 messages was
explicitly deferred by P1-A as *"a separate, reviewable change"*. P2 must not make it worse, and does
not: keying on `code` means a non-password 403 can never be reported as a wrong password.

### 2.3 P2-C — the evicted-session parse error

**VERIFIED** (`09_...` §4, measured): the first request after a `maximumSessions(2)` eviction returns
**`200`** with the plain-text body `"This session has been expired (possibly due to multiple
concurrent logins…)"`. `request()` (`store.ts:311-313`) treats any `2xx` as success and calls
`JSON.parse`, which throws a `SyntaxError`.

Fix: catch the parse failure and, for a caller that held a staff session, confirm via
`/api/auth/me` and route to the normal expiry path. This **adds** a defence; it removes none, so
B4's rule ("P2 must keep all three") is respected.

### 2.4 P2-D — gate the sync hooks on `!loading`

`03_INVARIANTS.md` §1: *"Permitted exception already agreed: gating the two sync hooks in
`app-shell.tsx:151-152` on `!loading` (two lines, P2)."*

**VERIFIED** the hooks currently run before `load()` resolves, when `isStaff` is still `false`, so a
staff user briefly opens the *public* sync path. `app-shell.tsx` does not currently select `loading`,
so this costs one extra selector line.

### 2.5 P2-E — the duplicate `/api/auth/me`

R6 measured **2×** on the login page in a production build, so it is not a StrictMode artifact.
Reading the source did **not** settle the cause (**UNVERIFIED**): `provider.tsx:12` `load()` does not
call `/api/auth/me` without a staff hint, and `staff-login/page.tsx:32` should fire `refreshAuth()`
once. **P2-E is therefore measure-first.** P2-D may itself remove it. If the cause turns out to sit
inside `use-public-sync.ts` or `use-card-sync.ts` — both **frozen** — P2-E is deferred rather than
forced.

## 3. Invariants and what protects them

| ID | How P2 respects it |
|---|---|
| **A** | No change to any write path or to the card payload |
| **B** | **The SSE layer is not touched.** `replaceCard`, `applyResultPatch`, `applyPairingsPatch`, `applySnapshotPublish`, `use-card-sync.ts`, `use-public-sync.ts` are untouched. P2-D changes only the *arguments* `app-shell.tsx` passes to two hooks |
| **C** | Snapshot path untouched |
| **D** | P2 changes the frontend only; the backend is unchanged, so **New FE + Old BE** is the direction at risk. A pre-P1-A backend returns `401` for a wrong password — the removed pre-flight would then surface `"Unauthorized"`. **This is exactly why B2 mandates the ordering, and why P1-A must never be reverted after P2 ships** (`08_P1_PLAN.md` §8.4) |
| **E** | No change to concurrent write behaviour |
| **B4 defences** | All three kept: `replaceCard`'s version guard, SSE death → `ensureSessionAlive()`, `use-session-guard.ts`. P2-C adds a fourth |

## 4. Rollback boundary

- **Frontend-only.** No backend change, no migration, no schema, no config. Rollback is a pure code
  revert, and the Worker/Next bundle is the only artefact rebuilt.
- Each chunk is its own commit and independently revertible; P2-A is inert on its own.
- **The one-way door:** once P2-B ships, reverting **P1-A** would restore `"Unauthorized"` in an
  all-Thai UI. **Rule (unchanged): revert P2-B first, then P1-A. Never the other way round.**
- Nothing is pushed; production moves only on a merge to `main`.

## 5. Gates

| Gate | Requirement |
|---|---|
| `npm test` | must stay green and gain tests for the new contract |
| `npm run lint` / `typecheck` / `build` | exit 0 |
| Backend `mvn test` | unchanged — 325/325 (P2 touches no backend code) |
| **Invariant D** | re-run: director + staff, wrong-password swap **now served by the backend**, card list, console |
| **Invariant B** | SSE unchanged — re-run the fixture diff |
| Re-auth round trips | **measure**: must fall from 2 to **1** |
| DB cleanliness | counts reconcile; probe accounts deleted |

## 6. Owner decision — NOT taken by this agent

**`HttpSessionEventPublisher`.** `09_...` §3 measured that a logout does **not** free its
`maximumSessions(2)` registry slot, so the effective cap degrades across an event day (D6/D9: shared
venue machines, repeated logins). The fix is an additive three-line bean.

**It is deferred deliberately, not overlooked.** Every document that mentions it calls it a
*decision* — `08_P1_PLAN.md` §5: *"registering it is a **P2 decision** … because it changes session
behaviour."* The reasons not to guess:

- It alters **authentication behaviour in production, three weeks before a competition.**
- The current behaviour is **measured and benign in the desirable direction** (R12: LRU eviction; the
  actively-used session is the last to go). Registering the publisher changes *which* sessions are
  counted, and no measurement exists for the post-change behaviour.
- `00_MASTER_PLAN.md` §1: *"When 'nicer architecture' conflicts with 'existing code already proven
  safe in competition', choose the existing code."*

**Recommendation for the owner:** register it, but only with a fresh repeat of the `09_...` harness
(control + measurement arms) proving the cap behaves as intended afterwards — and ideally after the
competition, since the degradation is gradual and a logout-free event day never triggers it.
**Until the owner decides, P2 ships without it.**
