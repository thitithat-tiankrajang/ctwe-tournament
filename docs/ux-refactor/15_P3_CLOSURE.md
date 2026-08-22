# P3 — CLOSED. Six of six chunks.

```
P3 STATUS: CLOSED — A, B, C, D1, D2, E all complete
HEAD:      0cdf31440a79295879bda00bafdf6e349545956e
BASELINE:  2cd0828 (P2 closed)
TREE:      clean · frozen evidence verifies (7/7 OK) · backend diff EMPTY
GATES:     npm test 135/135 · lint 0 · typecheck 0 · build 0 · Invariant B byte-verified
NOT MET:   M1's "total <= 8 requests on /admin" — established as out of P3's scope, see §5
```

Plan: `13_P3_PLAN.md`. Prior checkpoint: `14_P3_HANDOFF.md` (five and a half chunks).
This document closes the remaining half of P3-D2 and states P3's final position.

---

## 1. Chunks and commits

| Chunk | Commit | Delivers |
|---|---|---|
| **P3-D1** | `7dfd09b` | `/admin` refetch storms — readiness 5× → 1×, refocus 7 → 1 |
| **P3-A** | `abe5aac` | `summaries` field + merging card-list selector (container stays `TournamentCard[]`, B1) |
| **P3-B** | `6a64784` | authenticated card list from `/api/card-summaries` + 400/404/405 fallback + summary→full upgrade |
| **P3-E** | `f8b058d` | AppShell selectors + `CardSyncHost` — shell renders per SSE result 1 → 0 |
| **P3-D2** | `1438c5e`, `0cdf314` | `/director` refocus 4 → 1; query-layer question measured and settled |
| **P3-C** | `e4c5b98` | URL-derived tournament scope, `/cards/[id]` route page only (B5) |

Docs: `4c6b946` (plan), `43c459b`, `842449d` (checkpoints), this file.

**Frontend-only.** `git diff --name-only 2cd0828..HEAD -- backend/` is **empty**.

## 2. P3-D2 — the query-layer decision, measured

`14_P3_HANDOFF.md` §5 deferred this with an estimate ("~259 bytes per navigation"). That estimate
was not good enough to decide on, so it was replaced with measurement.

**Instrument.** A production `next build` served on `:3100` against an instrumented stub origin on
`:8091` that logs every request. The stub is the *control*: D2's question is about **frontend**
request behaviour, so fixed synthetic data (3 tournaments, 6 cards) removes the real dataset as a
variable. The user's `:8080` backend and their database were never read or written for this.

### 2.1 Where the requests actually go

| Flow | Requests | Duplicates |
|---|---|---|
| `/admin` cold load | **11** | **none** — every URL distinct, readiness **1×** |
| `/admin` refocus | **1** | — (`/api/auth/me`, B4's third defence) |
| `/director` refocus | **1** | — |
| `/admin` → `/` → `/admin` | **9** | **1** (`/api/tournaments`) |
| `/director` → `/` → `/director` | **3** | **1** (`/api/tournaments`) |
| `/admin` → `/director` | **2** | **1** (`/api/tournaments`) |

### 2.2 Why the migration was NOT taken

- **Cold load has no duplicate to collapse.** All 11 URLs are distinct. A cache dedupes repeats, not
  first loads, so the layer's headline benefit does not apply to the flow that matters most.
- **Refocus is already at the floor.** 1 request on both consoles. There is nothing left to save.
- **The three snapshot-status calls are one per distinct tournament**, not a pathological N+1. The
  pathological case — five calls to the *same* readiness URL — was P3-D1's fix. Collapsing three
  distinct resources needs a **backend batch endpoint** (outside P3's frontend-only scope) or
  **D3 admin narrowing** (an owner decision, explicitly excluded).
- **The one real duplicate is `/api/tournaments`**, which has four independent callers — `/`,
  `/admin`, `/director` and `use-derived-scope.ts` — and costs one small GET per navigation.
- **Every console read sits on a mutation's `refresh()` path.** Tournament deletion, Excel export &
  purge, snapshot publish/retract, account create/delete. There is no subset that could be served
  from a 30-second cache without putting stale state in front of an irreversible action, so there is
  no "safe half" to migrate.

`00_MASTER_PLAN.md` §1 fixes the order — correctness, then production safety, then measurable
performance — and *"when 'nicer architecture' conflicts with 'existing code already proven safe in
competition', choose the existing code."* One duplicated GET per navigation does not outweigh the
mutation path of the two consoles that perform every irreversible action in the product.

**D2's actual defects — the refetch storms — are fixed and measured. The migration is not taken.**

### 2.3 What the measurement DID find: a live trap

The `QueryClient` in `src/infrastructure/query/provider.tsx` wraps the entire app and is used by
nothing. Its defaults set only `staleTime` and `retry`. TanStack's `refetchOnWindowFocus` therefore
took its default — **on**, gated only on staleness (`queryObserver.ts` `shouldFetchOn`: an undefined
field passes `value !== false`, so the result is `isStale(query, options)`).

Verified with a throwaway `useQuery` on `/director`, data aged past the 30 s `staleTime`:

| | `/director` refocus |
|---|---|
| **Before** — QueryClient defaults as they were | **2 requests** |
| **After** — `refetchOnWindowFocus: false` | **1 request** |

So the *first* `useQuery` anyone added would silently reinstate the focus storm that P3-D1 and
`1438c5e` spent two commits removing, and that **D8 forbids**. `0cdf314` moves that invariant out of
the next author's memory and into the client's configuration. The probe was removed before the
commit; `grep TEMP-P3D2` returns **0**.

> **Measurement correction, recorded rather than buried.** The first run of this experiment showed
> *no* focus refetch, which would have been a false negative. The cause was the harness: a headless
> tab reports `document.visibilityState === "hidden"`, and TanStack's `focusManager.isFocused()`
> short-circuits on it, so the `if (focused)` guard in `queryClient.mount()` never fires. Every
> refocus figure in this document was re-taken with `visibilityState` forced to `"visible"`. This
> also means **P3-D1's and `1438c5e`'s refocus claims are now confirmed under the stricter
> condition**: `/admin` and `/director` are 1 request per focus with the tab genuinely visible.

## 3. P3-C — verified at runtime, not just committed

Carried in `e4c5b98` and re-verified this session against a cleared `localStorage`:

```
GET /api/public/realtime-config · /api/auth/me · /api/card-summaries
GET /api/tournaments            <- useDerivedTournamentScope, ONCE, only because scope was missing
GET /api/cards/{id}/events · /api/cards/{id}
```

`localStorage["ctwe.activeTournament"]` afterwards is `{"id":"t-alpha","name":"Tournament 1"}` —
`{ id, name }` only, **no `accessToken`**, so a staff session is never handed a viewer scope token.
The sidebar's card folders (`players`, `tables`, `games`, `audit`) render again.

**B5 containment** is structural, not incidental: `useDerivedTournamentScope` is imported by exactly
one file, `src/app/cards/[id]/page.tsx`. `CardOverview` — which `/tour/[token]` also renders — does
not reference it. The `authenticated` gate is the second guard.

## 4. Gates

| Gate | Result |
|---|---|
| `npm test` | **135 pass, 0 fail** |
| `npm run lint` | exit **0** |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **7/7 OK** |
| Backend diff | **empty** across all of P3 |
| **Invariant B** | **PASS, byte-verified.** `use-card-sync.ts`, `use-public-sync.ts`, `card-overview.tsx`, `snapshot-api.ts` unchanged across `2cd0828..HEAD`. Inside `store.ts`, `replaceCard`, `applyResultPatch`, `applyPairingsPatch`, `applySnapshotPublish` and `mutateCard` are **byte-identical** |
| **B1** | array container preserved; `summaries` is a sibling field |
| **B4** | all three defences intact; the one refocus request IS the third defence |
| **B5** | hook confined to the route page — verified by import graph |
| M1 readiness | **1×** — PASS |
| M2 / M2b refocus | **1 / 1** — PASS, under corrected visibility |
| M4 / M5 | authenticated list served by `/api/card-summaries`; fallback covered by `summaries-fallback.test.ts` |

**Backend `mvn test` was NOT re-run, deliberately.** P3 changes zero backend files, and the suite
includes real-database integration tests that run against the same `localhost:5432` the user's data
lives in. Re-running it for a frontend-only phase would risk their data to re-confirm a number that
cannot have moved. `10_P1_CLOSURE.md`'s 325/325 stands. **Recorded as a deviation, not a pass.**

## 5. What P3 did not achieve

**`13_P3_PLAN.md`'s M1 target of "≤ 8 requests on `/admin`" is NOT met — it is 11** (10 against the
real backend, which serves `realtime-config` differently). The readiness half of M1 passed; the total
did not. The reason is established in §2.2 and is not a frontend problem: three of the remaining
requests are one-per-tournament snapshot status, and removing them needs a backend batch endpoint or
D3 admin narrowing. **Reported rather than quietly rescoped.**

## 6. Owner decisions still open — none taken by this phase

`B7`/`SECURITY-01` · `D17` · `P1-D` · `D3 admin narrowing` · `HttpSessionEventPublisher` · UX-F3/D15
(P4) · IA (P5).

## 7. Environment

| | |
|---|---|
| Processes | stub origin `:8091` and production frontend `:3100` both stopped |
| Database | **never read or written** this session — no credentials were used and none were needed |
| User's servers | `:8080` backend untouched. **`:3000` dev server was killed by an over-broad `pkill -f next-server` and restarted immediately** (verified 200). Recorded, not hidden |
| Build artifacts | `.next-p3d2/` removed; `tsconfig.json` and `next-env.d.ts` restored after every build |
| Instrumentation | probe query removed pre-commit; `grep TEMP-P3D2` → 0 |

## 8. Rollback

Each chunk is its own commit and independently revertible. `0cdf314` is a pure configuration guard
and reverting it restores TanStack's defaults — which is exactly the trap §2.3 measured, so revert it
only together with any `useQuery` that may later be added. P3-B remains the only chunk with a
user-visible data-path change and it degrades safely via its 400/404/405 fallback. **The P1-A
ordering rule still stands: never revert P1-A while P2-B is in.**
