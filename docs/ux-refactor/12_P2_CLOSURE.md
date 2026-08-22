# P2 — FINAL GATE. Executed and measured.

```
P2 FINAL GATE: PASS
P2 STATUS:     CLOSED for the chunks it defined (A–E)
OPEN:          ONE owner decision — HttpSessionEventPublisher (§7). P2 ships without it.
P3 STATUS:     NOT STARTED
```

Plan: `11_P2_PLAN.md`. Prerequisite: `10_P1_CLOSURE.md` (P1 closed, P1-A verified).
This document is new evidence; it does not modify the frozen set (`01`–`06` + `fixtures/`), whose
checksums verified `OK` before and after this run.

---

## 1. Commit range

| | |
|---|---|
| Branch | `ux-refactor/p0-p1` |
| HEAD | `87f2e5a8b621c212cd8e2ce33a1fa2335afd9355` |
| P2 range | `1bd0604..87f2e5a` |
| Working tree | **clean** |
| Pushed | **no** — production unaffected |

```
3e7f5a0  docs(ux-refactor): close P1 with the executed final gate        P1 closeout
6c476c6  docs(ux-refactor): derive the P2 plan from the evidence set     P2 plan
895af39  feat(frontend): carry status and code on API errors             P2-A
45d673b  feat(frontend): drop the pre-flight password check              P2-B
4fc3ca8  fix(frontend): treat an evicted session's 200 as expiry         P2-C
87f2e5a  perf(frontend): hold the sync hooks until the initial load      P2-D
```

**Frontend-only, as planned.** `git diff --name-only 1bd0604..HEAD -- backend/` is **empty**.
Files touched: `store.ts`, `app-shell.tsx`, `tables/page.tsx`, `games/page.tsx`,
`reopen-registration.tsx`, plus one new test file.

**Frozen code untouched — verified mechanically.** `use-card-sync.ts`, `use-public-sync.ts`,
`snapshot-api.ts`, `publicsnapshot/**` are absent from the diff entirely, and inside `store.ts` the
P2 diff contains **zero** lines touching `replaceCard`, `applyResultPatch`, `applyPairingsPatch`,
`applySnapshotPublish` or `mutateCard`.

## 2. Tests — exact

| Gate | Result |
|---|---|
| Backend `mvn -o test` | **325 run, 0 failures, 0 errors, 0 skipped** — unchanged, as expected for a frontend-only phase |
| `npm test` | **119 pass, 0 fail, 0 skipped** (114 baseline + **5** new) |
| `npm run lint` | exit **0** |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |

The five new tests (`src/application/tournament/reauth-error.test.ts`) pin the contract P2 depends on:
a wrong password is `403` + `BAD_PASSWORD` + the Thai message **in one request**; a CSRF rejection is
the *same status with no code* and must not be reported as a wrong password; `isBadPassword` ignores
message text; an evicted session's `200` + plain-text body is an expiry rather than a `SyntaxError`;
and a malformed `200` with a **live** session is *not* reported as an expiry.

**No existing test was weakened or deleted.** `session-guard.test.ts`'s 401 case still stands — it
pins that a 401 carrying a body message does not log a user out, which remains true for the genuine
no-session paths.

## 3. §6 metric — password re-auth round trips: **2 → 1**

Measured through the **unmodified production request path** (Next production build → proxy →
backend), counting at the backend with a Tomcat access log.

One wrong-password pairing swap driven **through the UI**:

```
[13:00:29] GET  /api/auth/me                      200   <- page load, 29s earlier
[13:00:58] POST /api/cards/{id}/tables/swap       403   <- the entire user action
---
requests for the action  : 1
/api/auth/verify-password: 0
```

**Before P2 this was 2** (`POST /api/auth/verify-password` then the swap), and up to 3 when the old
401 branch added an `/api/auth/me` confirmation. `verify-password` is now called **zero** times on
this path. **Target met.**

## 4. R6's duplicate `/api/auth/me` — characterised, and fixed where it occurs

R6 (frozen) measured **4 requests / 2× `/api/auth/me`** on the login page. Investigating it produced
a correction worth recording:

| Scenario | pre-P2 (`1bd0604`) | P2 (`87f2e5a`) |
|---|---|---|
| Clean anonymous load, no staff hint | 3 requests, **1×** `/api/auth/me` | 3 requests, **1×** |
| **Stale `CTWE_STAFF` hint present** | 2 requests, **2×** `/api/auth/me` | 3 requests, **1×** |

**R6's duplicate does not reproduce on a clean anonymous load** — pre-P2 and P2 are identical there.
It reproduces only when a **stale staff-session hint** is present, which is the normal state for a
returning staff member whose server session has expired but whose `CTWE_STAFF` cookie has not.
In that scenario `load()` calls `fetchAuthState()` *and* the login page's `refreshAuth()` fires.

**P2 removes the duplicate in the scenario that produces it: 2× → 1×.** Both builds were measured
back to back against the same backend, same browser and same data, so the comparison is controlled.

> **Honest limit.** The precise causal chain by which gating the hooks on `!loading` collapses the
> two calls into one was **not traced to a single line**. The measurement is reproducible and
> directional; the mechanism is stated as the plausible one, not as a verified one. The total moves
> 2 → 3 in that scenario because the pre-P2 flow short-circuited into a redirect before loading the
> public catalog, while P2 completes it. Both are below the §6 target of 4.

## 5. Invariants

| ID | Result |
|---|---|
| **D — Old FE + New BE** | **PASS**, re-run in full. See §6 |
| **B — SSE** | **PASS.** The frozen hooks are byte-identical. Verified live: a `pairings/confirm` issued from another session flipped the browser from the tables page to game-4 result entry **with no reload**, carrying the swapped pairings |
| **A** | Unaffected — P2 adds no write path and changes no payload. The swap's effect was confirmed in the DB and in the browser |
| **C** | Snapshot path untouched. Still environment-blocked and waived |
| **E** | Unaffected — no change to concurrent write behaviour |
| **B4's three defences** | All three intact. P2-C **adds** a fourth |

## 6. Invariant D — re-run in full

Unmodified production frontend against the P1 backend, both roles.

| Check | Result |
|---|---|
| DIRECTOR login, correctly scoped | **PASS** |
| STAFF login, correctly scoped | **PASS** — and the registration card still reads **"ลงทะเบียน · 401 คน"**, the staff truth |
| Card list and card pages load | **PASS** |
| **Wrong-password swap → Thai message** | **PASS** — dialog reads **"ยืนยันตัวตนไม่สำเร็จ / รหัสผ่านไม่ถูกต้อง"**, identical to before P2, but now sourced from the backend rather than hard-coded next to the call |
| 403 does not log the user out | **PASS** — the session stayed alive and the page kept working |
| **Correct password still succeeds** | **PASS** — the swap went through |
| **Business errors still surface** | **PASS** — the same swap raised the backend's `SCHOOL_CONFLICT` warning (HTTP **400**), the confirm dialog appeared, and the confirmed retry succeeded and swapped B007/B003. The new `isBadPassword` early-return does **not** swallow non-password failures |
| Live SSE | **PASS** (§5) |
| Console | **every** error accounted for — see below |

### Console errors, each explained

| Error | Cause |
|---|---|
| `403` ×1 | the deliberate wrong password |
| `400` ×1 | `SCHOOL_CONFLICT`, the backend business rule working correctly |
| `405` ×2 | two `GET /logout` navigations made by the operator during teardown; only `POST /logout` is mapped |
| `401` ×1 | anonymous SSE `/api/cards/{id}/events` before logging in — pre-existing |
| `ERR_CONNECTION_REFUSED` ×35 | the throwaway **pre-P2 comparison server on :3200** after it was stopped; console buffer persists across navigations |

**None is a P2 regression.**

## 7. The one open item — OWNER DECISION, not taken

**`HttpSessionEventPublisher`.** Deferred deliberately; the full reasoning and recommendation are in
`11_P2_PLAN.md` §6. In short: it changes authentication behaviour in production three weeks before a
competition; the current behaviour is measured and benign in the desirable direction (R12: LRU, the
actively-used session evicted last); and no measurement exists for the post-change behaviour.
`08_P1_PLAN.md` §5 and `09_...` §5 both call it a *decision*, not a task.

**Recommendation:** register it only alongside a repeat of the `09_...` harness (control +
measurement arms) proving the cap still behaves as intended — and preferably after the competition,
since the degradation is gradual and a logout-free event day never triggers it.

## 8. Environment discipline

| | |
|---|---|
| Probe accounts | 2 throwaway (`p2gate-director/staff-<sfx>`), generated password, **deleted — 0 remain**. No real credential used |
| DB reconciliation | `accounts 4 · tournaments 3 · cards 7 · players 518 · members 2 · access 1` — **identical to session start on all six** |
| Pre-existing data | untouched; all writes confined to the isolated `P0 BASELINE (ux-refactor) DO NOT USE` tournament |
| Postgres settings | never altered this run; verified still at the P0 baseline (`-1`, `'%m [%p] '`). Request counting used a **Tomcat access log flag on the throwaway backend process**, not a config change |
| Other processes | the backend on `:8080` and dev server on `:3000` already running on this machine were **not touched**; all work used `:8081` / `:3100` / `:3200` |
| Throwaway worktree | pre-P2 build at `1bd0604` for the controlled comparison — **removed** |
| `next-env.d.ts` | rewritten by `next build` (the known issue in `04_BLOCKERS.md`) and **restored**; tree ended clean |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **all 7 OK** |

**Intentional data change:** the isolated `P0 SSE Fixture` card advanced `v28 → v32`
(unpair → preview → swap → confirm), which is what produced the Invariant B and D evidence.

## 9. Remaining gaps

| # | Gap | Status |
|---|---|---|
| 1 | `HttpSessionEventPublisher` | **OPEN — owner decision** (§7) |
| 2 | R6's duplicate `/api/auth/me` mechanism | **Characterised, fixed where it occurs**; the exact causal line is **UNVERIFIED** (§4) |
| 3 | A 403 *without* `code` still renders Spring's English `"Forbidden"` | **Pre-existing on the mutation path**, not introduced by P2. Surfacing the other 75 messages was deferred by P1-A as a separate reviewable change |
| 4 | Invariant C — snapshot checksum | **UNVERIFIED — environment-blocked**, waived |
| 5 | B7 / SECURITY-01 | **OPEN — owner decision.** Untouched by P2 |
| 6 | `npm test` still not in CI | **OPEN — owner call.** Suite is green at 119 |
| 7 | P1-D batch player import | **DEFERRED** by owner |

## 10. Rollback

Frontend-only: no backend change, no migration, no config. Each chunk is its own commit and
independently revertible; P2-A is inert alone.

**The one-way door, unchanged:** now that P2-B has shipped, reverting **P1-A** would restore
`"Unauthorized"` in an all-Thai UI. **Revert P2-B first, then P1-A. Never the other way round.**

```
git revert 87f2e5a     # P2-D, sync-hook gating
git revert 4fc3ca8     # P2-C, eviction handling
git revert 45d673b     # P2-B, restores the pre-flight   <-- before any P1-A revert
git revert 895af39     # P2-A, inert plumbing
```
