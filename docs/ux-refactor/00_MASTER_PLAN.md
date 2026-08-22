# CTWE UX/Data Refactor — Master Plan

Status date: 2026-08-22
Baseline commit: `6ce756c9d77590f1e482d23b25ccea360db9c0a6` (branch `main`)

> **P0 IS CLOSED** (2026-08-22, owner acceptance) — evidence frozen, see `07_P0_CLOSURE.md`.
> **P1 IS CLOSED** (2026-08-22) — approved, implemented, committed (`40ee7f4..1bd0604`) and its
> final gate executed and measured. See `10_P1_CLOSURE.md`. **P1-D was deferred; P1-C was a
> measurement only (`09_...`).**
> **P2 IS CLOSED** (2026-08-22) — implemented, committed (`1bd0604..87f2e5a`) and its final gate
> executed. See `12_P2_CLOSURE.md`. One item is left open as an **owner decision**:
> `HttpSessionEventPublisher` (`11_P2_PLAN.md` §6).
> **P3 IS CLOSED** (2026-08-22) — plan `13_P3_PLAN.md`, closure `15_P3_CLOSURE.md`. All six
> chunks A/B/C/D1/D2/E are complete and measured. **P3-D2's query migration was measured and
> declined** — the consoles have no duplicate to collapse on cold load and are already at one
> request per focus, while every console read sits on a mutation's refresh path
> (`15_P3_CLOSURE.md` §2). M1's "≤ 8 requests on /admin" is **not met** and needs a backend
> batch endpoint or D3 — both outside P3.
> **P4 IS CLOSED** (2026-08-22) — closure `18_P4_CLOSURE.md`. The concurrent-draft warning was
> **blocked by a proof gate it failed** (`16_`): the staff realtime path could silently drop a
> persisted result and the client could not tell. Three fixes landed first — gap detection, overflow
> recovery, actor identity — the gate was re-run and **passed** (`17_`), and only then was the warning
> built. Two frozen items changed, both owner-approved and minimal: `use-card-sync.ts` (forward the
> actor) and `applyResultPatch` (one contiguity line).
> **P5 IS PARTIAL BY DECISION** (2026-08-22) — `19_P5_PARTIAL_CLOSURE.md`. P5 never had a plan
> document; the preflight found most of its scope should not be built. **D21 shipped** (folders you
> are not working in now collapse: 3 of 3 expanded → 1 of 3, sidebar page links 15 → 5). **D16 and
> "URL state" were declined**, not deferred — no measured problem, and no staging with a competition
> ~3 weeks out. P5 moves none of the tracked success metrics; the only unmet one (35 sub-11px fonts)
> belongs to P6/P7.
> **B7 is carved out of this refactor entirely** — see `SECURITY-01_ANONYMOUS_CARD_EXPOSURE.md`.
> Read `10_P1_CLOSURE.md`, then `11_P2_PLAN.md` and `12_P2_CLOSURE.md`.
> `05_HANDOFF.md` remains the P0 record.

---

## 1. Goal

Reduce request waste, unify interaction patterns, and fix accessibility defects in the CTWE
Tournament Control app **without changing tournament business logic**.

Optimisation order agreed with the owner:

```
correctness → production safety → measurable performance → UX → visual polish
```

When "nicer architecture" conflicts with "existing code already proven safe in competition",
choose the existing code.

## 2. Context constraints (owner-confirmed)

| Constraint | Value |
|---|---|
| Staging environment | **None.** `render.yaml` defines one service (`ctwe-tournament-api`, production). Branch `staging` deploys nowhere. |
| CI | `.github/workflows/ci.yml` runs `lint`, `typecheck`, `build` (frontend) and `mvn test` (backend). **It does not run `npm test`.** |
| Verification method | Local machine, real Postgres, seeded data + owner spot-checks per chunk |
| Backend changes | Allowed, additive-only preferred |
| Competition window | ~3 weeks from 2026-08-22; system idle until the event |
| Scale target | 1 tournament, 3 cards, ≤400 players/card, 10 staff sessions, thousands of viewers (`docs/EVENT_CAPACITY_RUNBOOK.md`) |

## 3. Phase order (current)

```
P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7
```

| Phase | Scope | Status |
|---|---|---|
| **P0** | Baseline capture + safe prune (no production behaviour change) | **CLOSED** — evidence frozen; 2 gaps waived as environment-bound |
| **P1** | Backend-only additive migration | **CLOSED** — P1-A + P1-B shipped, final gate PASS (`10_P1_CLOSURE.md`); P1-C measurement only, P1-D deferred |
| **P2** | Auth + login request consolidation (frontend) | **CLOSED** — final gate PASS (`12_P2_CLOSURE.md`); re-auth round trips 2 → 1. `HttpSessionEventPublisher` deferred to the owner |
| **P3** | Data layer, summaries consumption, URL scope authority, query layer, selectors | **CLOSED** — all six chunks A/B/C/D1/D2/E, final gate PASS (`15_P3_CLOSURE.md`); /admin 15→10, refocus 7→1 and 4→1, card list 9,592→854 B, **shell renders per SSE result 1→0**. D2's query migration measured and declined; M1's ≤8-request target NOT met (needs backend batch or D3) |
| **P4** | UI primitives, concurrency warning, viewer view-picker | **CLOSED** — final gate PASS (`18_P4_CLOSURE.md`). D15/UX-F3, retract wording and the concurrent-draft warning all shipped, the last one only after an SSE proof gate it first FAILED forced three transport fixes (`16_`, `17_`) |
| **P5** | Information architecture + URL state | **PARTIAL BY DECISION** — D21 (collapse unused sidebar folders) shipped and measured, 3 of 3 folders expanded → 1 of 3 (`19_P5_PARTIAL_CLOSURE.md`). **D16 and "URL state" declined**: D16 is a relocation with no measured problem, and URL state was never specified — the parts that mattered shipped in P3-C and the viewer hash |
| **P6** | Performance + accessibility remainder | not started |
| **P7** | Visual tokens | not started |

### P3 internal gates (must ship as separate commits)

| Gate | Scope |
|---|---|
| P3-A | Add `summaries` field + narrow selectors. **Container type stays `TournamentCard[]`** (see `04_BLOCKERS.md` B1) |
| P3-B | Consume summaries endpoint, with fallback |
| P3-C | URL-derived tournament scope |
| P3-D | Query layer for console data, per-query errors |
| P3-E | AppShell selector + memoisation |

## 4. Scope freeze

| Bucket | Items |
|---|---|
| **MUST DO** | P0 (complete it), P1, P2, P3 A–E, concurrent-draft warning, retract "up to 5 minutes" wording |
| **SHOULD DO** | P4, P6 correctness half |
| **CUT IF LATE** | P5 (IA), P7 (visual), P6 performance half |
| **AFTER COMPETITION** | Bulk result endpoint, terminology rename, Web Push backend removal, modal→drawer, dark mode, virtualisation (unless measured necessary) |

## 5. Removed from scope during review

| Item | Reason | Evidence |
|---|---|---|
| Bulk result endpoint | `cardRow()` takes `SELECT … FOR UPDATE`; batching in one transaction holds the card lock for the whole batch and degrades multi-user editing | `TournamentCardService.java:1996-2010` (`cardRow`), `:2038` (`requireStage`) |
| Parallel `saveAll` | Out-of-order mutation responses defeat the version guard in `applyResultPatch` | `src/application/tournament/store.ts:466` |
| `Card[]` → `Record<id, Card>` | Forces rewriting the frozen SSE patch layer | `04_BLOCKERS.md` B1 |
| Mutation `204` → returned row | Only `setEnabled` would benefit; 4 of 8 endpoints are deletes | `02_ARCHITECTURE_DECISIONS.md` §2.1 |
| Terminology rename (การ์ด → รุ่นการแข่งขัน) | ~40 strings, zero technical benefit, adds briefing load before a competition | owner decision D14, deferred |

## 6. Success metrics

> **Updated 2026-08-22.** The runtime baseline **has** now been captured — the "Current" column below
> is the original source-read estimate, kept for the record. **Measured values supersede it:**
> `06_P0_RUNTIME_BASELINE.md` R6 (login page: 4 requests, 2x `/api/auth/me`), R9 (admin card list:
> 58 statements / 120.9 KB / `1 + 7N`), R8 (400-player import: 800 INSERTs / 285 ms), R10 (SSE).
> Where the two disagree, the measurement wins.
>
> **P1 outcome, measured 2026-08-22** (`10_P1_CLOSURE.md` §3): `GET /api/card-summaries` costs
> **1 SQL SELECT** and **2,392 bytes for 7 cards**, against **53 SELECTs / 154,504 bytes** for
> `GET /api/cards` on the same data — a **64.6x** payload reduction. The endpoint has no callers
> until P3-B consumes it, so none of the login-flow metrics below have moved yet.

| Metric | Current (read from source, **UNVERIFIED at runtime**) | Target |
|---|---|---|
| Requests per staff login | 9, incl. 3× `GET /api/auth/me` | 4, 1× `/api/auth/me` |
| Login payload, director (3 cards × 400 players) | ~1 MB, ~21 DB queries | < 5 KB |
| Login payload, admin | every card platform-wide (no tournament filter) | 0 cards |
| Requests on window refocus (console) | 4 | ≤1 — **DONE, measured**: /admin 7→1, /director 4→1 |
| `shutdown-readiness` calls per admin page load, N tournaments | N+1 | 1 |
| Password re-auth round trips | 2 (pre-flight + mutation) | 1 — **DONE, measured** (`12_P2_CLOSURE.md` §3) |
| AppShell renders per SSE result event | 1 | 0 — **DONE, measured** (`14_P3_HANDOFF.md` §2 M7) |
| Font sizes below 11px | 31 occurrences | 0 |

## 7. Document index

| File | Purpose |
|---|---|
| `00_MASTER_PLAN.md` | This file — scope, phases, metrics |
| `01_P0_BASELINE.md` | Exact commands, results, deletions, bundle table, failing tests |
| `02_ARCHITECTURE_DECISIONS.md` | Owner decisions + verified findings that changed the plan |
| `03_INVARIANTS.md` | Code that must not change, and why |
| `04_BLOCKERS.md` | Blockers with source evidence, risk, required fix |
| `05_HANDOFF.md` | State, corrections, open decisions, next-agent rules, exact next action |
| `06_P0_RUNTIME_BASELINE.md` | Runtime captures: query counts, viewer flow, SSE fixture, R1/R2 findings, what is still blocked |
| `07_P0_CLOSURE.md` | **P0 closed.** Waived gaps, B7 carve-out, evidence freeze manifest |
| `08_P1_PLAN.md` | **The revised P1 plan.** B3 re-scoped, B2 ordering, B4 incorporation, rollback |
| `09_B4_SESSION_REGISTRY_MEASUREMENT.md` | Logout does **not** free a session-registry slot — measured; routed to P2 |
| `10_P1_CLOSURE.md` | **P1 closed.** Final gate executed: §9.4 measurement, Invariants A/B/D, public API regression, remaining gaps |
| `11_P2_PLAN.md` | The P2 plan, derived from the evidence set. §6 holds the one owner decision |
| `12_P2_CLOSURE.md` | **P2 closed.** Final gate executed: re-auth 2 → 1 measured, Invariant D re-run, R6 duplicate characterised |
| `13_P3_PLAN.md` | The P3 plan, derived from fresh measurement. Records that the UI/UX audit is already done |
| `14_P3_HANDOFF.md` | **P3 partial.** Five and a half of six chunks, measured; the deferred query migration and the exact next action |
| `SECURITY-01_ANONYMOUS_CARD_EXPOSURE.md` | B7, carved out — pre-existing, owner decision required |
| `EVIDENCE.sha256` | Checksums of the frozen evidence set (`shasum -c`) |
