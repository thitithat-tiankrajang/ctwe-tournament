# P3 — PARTIAL. Handoff at a clean checkpoint.

```
P3 STATUS: PARTIAL — 3 of 6 chunks done, each measured and committed
HEAD:      6a647849ef5f8f67a0f02fb2f60c042b338be81d
TREE:      clean · frozen evidence verifies · DB reconciled · no processes left running
NOT a closure. Do not mark P3 complete on the strength of this document.
```

Plan: `13_P3_PLAN.md`. Baseline: `2cd0828` (P2 closed).

---

## 1. Commits

```
4c6b946  docs(ux-refactor): plan P3 from measurement, not from taste
7dfd09b  fix(frontend): stop the console refetch storms on /admin        P3-D1
abe5aac  feat(frontend): add the summaries field and a merging selector  P3-A
6a64784  feat(frontend): serve the authenticated card list from summaries P3-B
```

Frontend-only. `git diff --name-only 2cd0828..HEAD -- backend/` is **empty**. The frozen SSE files
(`use-card-sync.ts`, `use-public-sync.ts`, `snapshot-api.ts`, `publicsnapshot/**`) are absent from
every diff, and inside `store.ts` no line touching `replaceCard`, `applyResultPatch`,
`applyPairingsPatch`, `applySnapshotPublish` or `mutateCard` was changed.

## 2. Measured outcomes

All counted at the backend with a Tomcat access log against a **production build**, one browser,
real data (3 tournaments, 7 cards, 518 players). Byte figures are **on the wire** (gzipped) unless
marked otherwise.

| Metric | Before | After | Chunk |
|---|---|---|---|
| `/admin` page load | **15 requests**, readiness **5×** | **10 requests**, readiness **1×** | P3-D1 |
| Window refocus on `/admin` | **7 requests** | **1** — the session guard's own check, a B4 defence | P3-D1 |
| `/cards` list payload (admin) | `/api/cards` **9,592 B** | `/api/card-summaries` **854 B** | P3-B |
| Director list, uncompressed | **94,918 B**, `1+7N` statements | **649 B**, **1** statement | P3-B |
| Card page full-card fetches | n/a (list was already full) | **1** (was 2 in a first cut — see §4) | P3-B |
| Director card page, total | — | **3 requests** | P3-B |

## 3. Tests

| Gate | Result |
|---|---|
| `npm test` | **130 pass, 0 fail** (119 at P2 + 6 selector + 5 fallback) |
| lint / typecheck / build | exit **0 / 0 / 0** |
| Backend `mvn -o test` | **325/325**, 0 failures — P3 touches no backend code |

## 4. What runtime verification caught that tests did not

**The first cut of `useFullCard` doubled a request.** It fetched the full card whenever the store
held only a summary — but `use-card-sync.ts`'s `connected` handler *already* fetches when the store
has no version for that card. Measured: **2** full-card requests per card page, i.e. P3-B was adding
the very duplication P3 exists to remove.

It is now a genuine fallback: fetch immediately only when SSE is switched off, otherwise wait 1.5 s
so a healthy stream wins and cancels the timer. Only a stream that never connects — refused at the
connection cap, or blocked by a proxy — lets it fire, and a blank card page is the alternative.
Re-measured: **1**. This is the reason the plan insisted on production-build measurement rather than
reasoning from source.

## 5. Business flows verified after P3

Driven through the UI as a real director, on the isolated P0 card:

| Flow | Result |
|---|---|
| Director login, tenant scoping | **PASS** — one tournament, 2 cards |
| Admin login, tenant scoping | **PASS** — 3 tournaments, counts 2/4/1 = 7 cards, from summaries |
| Card page renders full data | **PASS** — pairings, view picker, PDF panel; no loading placeholder |
| **Result entry** | **PASS** — draft → save → `PUT …/matches/g4t1/result` **200**, one request |
| **Invariant A** | **PASS** — DB row `505:433`, winner B003, `calculatedDiff = min(72,350) = 72`, card version 32 → 33 |
| **Invariant B** | **PASS** — the UI advanced to "1/4 คู่" and the row flipped to saved, live |
| Console | one `405`, from a `GET /logout` navigation the operator made; `POST` is the only mapping |

## 6. Remaining P3 chunks — none started

| Chunk | Scope | Notes for the next agent |
|---|---|---|
| **P3-E** | AppShell selectors + memoisation; target "AppShell renders per SSE result event → 0" | `app-shell.tsx` still does `useTournamentStore((state) => state.cards)`, so every SSE patch re-renders the shell. Replace with narrow, primitive selectors (`…find(c => c.id === id)?.name` etc.). The `tournamentCards` memo is already in place from P3-B |
| **P3-D2** | Console data into the TanStack Query layer, per-query errors, `staleTime` for D8 stale-while-revalidate | `src/infrastructure/query/provider.tsx` is a **shell** — it creates a `QueryClient` and uses it for nothing. This is where the remaining `/admin` fan-out (3× per-tournament snapshot status) should be deduplicated |
| **P3-C** | URL-derived tournament scope | **B5 constraint is load-bearing**: it must live in the `/cards/[id]` route page only, never in `CardOverview`, which is shared with `/tour/[token]`. `publicScopeToken` is read/written at 8 sites |

### Known gap against the plan's own target

`13_P3_PLAN.md` §2 set `/admin` at **≤ 8** requests. Achieved **10**. The three remaining are one
`public-snapshot/status` per tournament — a real N+1. Removing it needs either a **batch endpoint**
(a backend change, outside P3's frontend-only scope) or **D3 admin narrowing** (an owner decision).
**Recorded as not met**, not quietly rescoped.

## 7. Scope decisions taken, with evidence

**P3 is a data-flow refactor, not a visual one — because the UI/UX work is already done.**
`design.md` records two completed validation rounds; the items left are explicitly awaiting owner
validation, UX-F3 is decision **D15 already assigned to P4**, and IA is P5 under the scope freeze.
Three items the audit called real bugs were spot-checked and are all fixed in current source
(`DataGrid` `resetKey`, the `/cards` empty-state link, the dev-tools badge).

**Not implemented, unchanged:** B7/SECURITY-01, D17, `HttpSessionEventPublisher` (**still an owner
decision — do not enable**), P1-D, D3 admin narrowing.

## 8. Environment state

| | |
|---|---|
| Processes | all mine stopped (`:8081`, `:3100`, `:3200`). The user's `:8080` backend and `:3000` dev server were never touched |
| Probe accounts | 3 `p3gate-*` created with a generated password, **all deleted** — 0 remain |
| DB | `accounts 4 · tournaments 3 · cards 7 · players 518 · members 2 · access 1` — **identical to session start** |
| Postgres settings | never altered this run (`log_min_duration_statement` = `-1`). Request counting used a Tomcat access-log **flag on the throwaway backend process** |
| `next-env.d.ts` | rewritten by each `next build` and restored every time; tree ended clean |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **all 7 OK** |

**Intentional data change:** the isolated `P0 SSE Fixture` card advanced `v32 → v33` from the
verification result save (game 4, table 1). All writes stayed inside the isolated P0 tournament.

## 9. Exact next action

1. `git log --oneline -1` → expect `6a64784`.
2. Start P3-E: narrow `app-shell.tsx`'s store subscriptions so an SSE result patch no longer
   re-renders the shell. Measure with React DevTools or a render counter *before* and *after* —
   the metric is a render count, not a request count, so the access-log technique does not apply.
3. Then P3-D2, then P3-C.
4. Re-run the §7 gates in `13_P3_PLAN.md` and write `15_P3_CLOSURE.md` when all six chunks are done.

**Rollback:** each chunk is its own commit and independently revertible. P3-B is the only one with a
user-visible data path change and it degrades safely — its 400/404/405 fallback restores the old
`/api/cards` behaviour exactly. The P1-A ordering rule still stands: never revert P1-A while P2-B is
in.
