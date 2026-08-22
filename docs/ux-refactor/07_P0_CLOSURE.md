# P0 — CLOSED. Evidence frozen.

**Closed 2026-08-22 by owner acceptance of the P0 FINAL GATE** (`05_HANDOFF.md`, final section).

```
P0 STATUS: CLOSED
P1 STATUS: CLOSED — approved, implemented, committed 40ee7f4..1bd0604,
           final gate executed and measured (see 10_P1_CLOSURE.md)
P2 STATUS: NOT STARTED — prerequisites satisfied, awaiting owner approval
```

> **Status line updated 2026-08-22.** The P1 line above originally read "PLAN SUBMITTED — AWAITING
> OWNER APPROVAL — NO CODE WRITTEN". That was true when P0 closed and is no longer. Everything else
> in this document is unchanged and still describes P0. This file is **not** part of the
> checksum-frozen set (`EVIDENCE.sha256` covers `01`–`06` + `fixtures/`).

---

## 1. What "closed" means

P0's deliverable was a **baseline**, not a change: capture the system's real behaviour, prove the
dead-code prune was behaviour-neutral, and make the test gate trustworthy. All three landed.

| P0 deliverable | Outcome |
|---|---|
| Static baseline | **PASS** — lint 0, typecheck 0, build 0; 22-route bundle table byte-identical pre/post prune |
| Safe prune | **DONE** — 4 dead files (485 lines) + 4 unused dependencies, zero residual references |
| Test gate | **PASS** — `npm test` 114/114, exit 0 (was 103/114); test files only, zero product change |
| Runtime baseline | **CAPTURED** — R1–R13, two gaps waived below |
| SSE invariant (B) | **BASELINED** — `fixtures/sse-baseline.json`, versions v2→v10 monotonic, no gaps |
| Multi-user invariant (E) | **PASS** — verified at runtime, no lost update (R13) |
| Session behaviour (B4) | **RESOLVED** — cap enforced, LRU eviction, proven by 5-login experiment |

**No commits were made during P0.** Everything is working-tree state plus `docs/ux-refactor/`.

## 2. Waived — not to be chased further (owner instruction, 2026-08-22)

Both are environment-bound, not analysis-bound. Neither blocks P1.

| Gap | Why it cannot be closed here | Status |
|---|---|---|
| **Snapshot checksum (Invariant C)** | `NEXT_PUBLIC_SNAPSHOT_ORIGIN` is unset locally and the local `.env` carries no R2 credentials, so nothing can be published or checksummed on this machine | **WAIVED — closed as environment-bound** |
| **Cold-cache query counts** | `/actuator/**` is ADMIN-only *and* sits outside `/api/**`, so the Next proxy (`src/app/api/[...path]/route.ts`) never forwards it; `/actuator/caches` returns the app's own 404 HTML. Forcing a miss by mutation also fails, because the eviction path does not cover player inserts (R11) | **WAIVED — closed as environment-bound** |

Every warm-path number that matters **is** captured. These two were secondary metrics.

### One unresolved contradiction is carried forward, not waived

A prior note records `NEXT_PUBLIC_SNAPSHOT_ORIGIN` as **unset in the Worker build**, while decision
**D17** states it **is** set in production. **Both cannot be true.** This cannot be settled from this
machine — it needs the production/Worker configuration. **Owner to resolve.** It does not block P1
(P1 is backend-only and does not touch the snapshot path).

## 3. Carved out of the refactor entirely

| Item | Where it now lives |
|---|---|
| **B7** — anonymous `GET /api/cards` exposes every card + roster, internet-reachable | **`SECURITY-01_ANONYMOUS_CARD_EXPOSURE.md`** |

**B7 must not be modified or fixed as part of this refactor** (owner instruction). It is pre-existing,
it has a real-world blast radius, and it is an owner decision on its own timeline. P1 is designed so
that it neither depends on B7 nor widens it — see `08_P1_PLAN.md` §4.3.

## 4. Evidence freeze

The files below are **frozen as of 2026-08-22**. They are the record P1 is built on. **Do not edit
them.** Corrections go in a new document that cites what it supersedes.

```
965086fba86aa03a3c13628000c2e5c138d45e1e8c2bb369497195fcb740f072  01_P0_BASELINE.md
6c26463cab0c7835d0ec8ba7e421802ada4d4ca4aa5739c591b1364492dc5bfc  02_ARCHITECTURE_DECISIONS.md
dc20ea078a715443f520bedb61fd64c71918dfbfc3983c6b7a8e9482a118753d  03_INVARIANTS.md
2faccf22c3654c46c0fef678c0a6326f8bdb87f0b8b94a7af25c3562508791d7  04_BLOCKERS.md
af896afd97d76173bff9236e873f8913de74f56ff5ec6891d4d73175a41e47de  05_HANDOFF.md
148240fa56e28014487088bfeee83d6739f3755ba44c85c5201ddecb7a71ca68  06_P0_RUNTIME_BASELINE.md
449813b637bce4e00e33eb9bd52e5f4ab85a3aeb6e7060aa5593f0fffcd72217  fixtures/sse-baseline.json
```

Verify at any time with:

```
shasum -c docs/ux-refactor/EVIDENCE.sha256
```

`00_MASTER_PLAN.md` is deliberately **not** frozen — it is the living index and status table.

### Baseline the evidence describes

| | |
|---|---|
| Commit | `6ce756c9d77590f1e482d23b25ccea360db9c0a6` (`main`) |
| Subject | 2026-08-21 18:01:14 +0700 — "Merge branch 'staging': give metaspace the headroom the running app needs" |
| Node | 22.23.2 (`.nvmrc`; machine default v26.6.0 does **not** match) |
| Working tree | 4 deletions staged + `package.json`/`package-lock.json` modified + 2 modified test files + 1 new test file. **Preserve — do not reset, revert or stash** |

### Environment restored after capture

Postgres `log_min_duration_statement` returned to `default` (`-1`); `.claude/launch.json` restored
byte-exact (hash verified); pre-existing data byte-identical (25 + 84 = 109 players). The isolated
P0 dataset (`P0 BASELINE (ux-refactor) DO NOT USE`, id `476d110b-e1bc-40cb-9915-ebe1714801d6`) was
created under decision A and is proven not to have touched any pre-existing row.

## 5. Carried into P1 as live constraints

Closing P0 does not close these. They are inputs to `08_P1_PLAN.md`.

| ID | Carried as |
|---|---|
| **B2** | Must be fixed **in P1**, before P2 may remove the pre-flight `verifyPassword` |
| **B3** | **Re-scoped in P1** on the R7 finding that summary endpoints already exist |
| **B4** | Resolved, but its findings **constrain P1's endpoint design** (see `08_P1_PLAN.md` §4.3) |
| **B1, B5** | Design constraints for P3 — must not be reintroduced |
| **B8** | 5 s `runtime_settings` poller — config-only fix, P6 candidate |
| **B9** | Row-by-row player import — additive fix, **offered as optional P1-D** |
| **B6 residual** | CI still does not run `npm test`. Safe to add now (suite is green). Owner call |
