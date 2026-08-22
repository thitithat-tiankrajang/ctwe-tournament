# CTWE UX/Data Refactor — Master Plan

Status date: 2026-08-22
Baseline commit: `6ce756c9d77590f1e482d23b25ccea360db9c0a6` (branch `main`)

> **P0 IS CLOSED** (2026-08-22, owner acceptance) — evidence frozen, see `07_P0_CLOSURE.md`.
> **P1 IS CLOSED** (2026-08-22) — approved, implemented, committed (`40ee7f4..1bd0604`) and its
> final gate executed and measured. See `10_P1_CLOSURE.md`. **P1-D was deferred; P1-C was a
> measurement only (`09_...`).**
> **P2 IS NOT STARTED** — its prerequisites are satisfied; it awaits owner approval.
> **B7 is carved out of this refactor entirely** — see `SECURITY-01_ANONYMOUS_CARD_EXPOSURE.md`.
> Read `07_P0_CLOSURE.md`, then `08_P1_PLAN.md`, then `10_P1_CLOSURE.md`.
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
| **P2** | Auth + login request consolidation (frontend) | **not started — unblocked**, awaiting owner approval |
| **P3** | Data layer, summaries consumption, URL scope authority, query layer, selectors | not started |
| **P4** | UI primitives, concurrency warning, viewer view-picker | not started |
| **P5** | Information architecture + URL state | not started |
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
| Requests on window refocus (console) | 4 | ≤1 |
| `shutdown-readiness` calls per admin page load, N tournaments | N+1 | 1 |
| Password re-auth round trips | 2 (pre-flight + mutation) | 1 |
| AppShell renders per SSE result event | 1 | 0 |
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
| `SECURITY-01_ANONYMOUS_CARD_EXPOSURE.md` | B7, carved out — pre-existing, owner decision required |
| `EVIDENCE.sha256` | Checksums of the frozen evidence set (`shasum -c`) |
