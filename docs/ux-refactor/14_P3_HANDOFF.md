# P3 — PARTIAL. Five and a half of six chunks.

```
P3 STATUS: PARTIAL — P3-A, P3-B, P3-C, P3-D1, P3-E complete; P3-D2 HALF complete
HEAD:      e4c5b9826ccc21d9e107bfd58dae68f8bca34c4c
TREE:      clean · frozen evidence verifies · DB reconciled · no processes left running
NOT a closure. P3-D2's query-layer half is deliberately deferred — see §5.
```

Plan: `13_P3_PLAN.md`. Baseline: `2cd0828` (P2 closed).

---

## 1. Commits

```
4c6b946  docs(ux-refactor): plan P3 from measurement, not from taste
7dfd09b  fix(frontend): stop the console refetch storms on /admin              P3-D1
abe5aac  feat(frontend): add the summaries field and a merging selector        P3-A
6a64784  feat(frontend): serve the authenticated card list from summaries      P3-B
43c459b  docs(ux-refactor): hand off P3 at a clean checkpoint
f8b058d  perf(frontend): stop SSE result patches re-rendering the whole shell  P3-E
1438c5e  fix(frontend): stop the director console refetching on every focus    P3-D2 (half)
e4c5b98  feat(frontend): recover the tournament scope from the URL             P3-C
```

Frontend-only throughout: `git diff --name-only 2cd0828..HEAD -- backend/` is **empty**. No frozen
file appears in any diff — `use-card-sync.ts`, `use-public-sync.ts`, `snapshot-api.ts`,
`publicsnapshot/**` and `card-overview.tsx` are all untouched, and inside `store.ts` no line touching
the four SSE patch functions or `mutateCard` was changed.

## 2. Measured outcomes

Backend Tomcat access log, **production build**, one browser, real data (3 tournaments, 7 cards,
518 players). Bytes are on the wire unless marked otherwise.

| # | Metric | Before | After | Chunk |
|---|---|---|---|---|
| M1 | `/admin` load | **15 requests**, readiness **5×** | **10**, readiness **1×** | D1 |
| M2 | `/admin` refocus | **7** | **1** | D1 |
| M2b | **`/director` refocus** | **4** | **1** | D2 |
| M4 | Admin card list | `/api/cards` **9,592 B** | `/api/card-summaries` **854 B** | B |
| M5 | Director list, uncompressed | **94,918 B**, `1+7N` statements | **649 B**, **1** statement | B |
| M6 | Card page full-card fetches | — | **1** (2 in a first cut) | B |
| **M7** | **Shell renders per SSE result event** | **1 per event** | **0** | **E** |
| M7b | Shell renders per stage change | 1 | **still re-renders** — required | E |
| M8 | Shell renders during card-page load | 5 | **3** | E |

The single request left on either console's refocus is `/api/auth/me` from
`useBackOfficeSessionGuard` — B4's third defence, deliberately kept.

## 3. What measurement caught that reasoning would not

**Twice, the obvious fix was not the fix.**

**P3-B** — the first `useFullCard` fetched whenever the store held only a summary, but
`use-card-sync`'s `connected` handler already does that. Result: **2** full-card requests per card
page — P3-B was *adding* duplication. It is now a fallback (immediate only when SSE is off, else a
1.5 s timer a healthy stream cancels). Re-measured: **1**.

**P3-E** — subscribing to a signature instead of `cards` was necessary but **not sufficient**. The
counter showed the signature was already stable across a result patch and the shell *still*
re-rendered. The real driver was that AppShell **hosted the sync hooks itself**: `use-card-sync`
subscribes to the open card's `version`, which increments on every result patch, and
`use-public-sync` subscribes to the whole `cards` array. Both are frozen, so the caller moved — they
now live in `CardSyncHost`, which renders `null`. Reasoning from source alone would have shipped the
selector change and claimed the metric.

## 4. Invariants and business flows

| Check | Result |
|---|---|
| **Invariant B — SSE** | **PASS.** Frozen files byte-identical. Result grid updated live to values written by another session; `results/review` moved the page to the Review screen |
| **Invariant A** | **PASS.** Result save persisted `505:433`, winner B003, `calculatedDiff = min(72,350) = 72`, card version advanced |
| **Invariant D** | **PASS.** Director and admin login, tenant scoping, card pages, result entry |
| **B5 — viewer path** | **PASS, verified both ways.** As a director, `/cards/{id}` with no stored scope now restores the tournament and both card folders. As an **anonymous viewer**, opening a card under `/tour/bkk` issued **zero** origin requests and zero back-office calls — so P3-C provably does not run there, and the viewer's zero-request invariant holds |
| **B1** | array container preserved; `summaries` is a sibling field |
| **B4** | all three defences intact |
| Stage change still reaches the shell | **PASS** — required by the sidebar nudge and the stage-change redirect; pinned by tests in both directions |

**One observation, not a regression:** a single `GET /api/cards/{id}/events 500` appeared at
client-side navigation away from a card page, after **8,445 bytes had already streamed** and with no
backend exception logged. That is the signature of an aborted async stream at teardown, and the same
teardown happened before P3-E — only the component owning the stream changed.

## 5. P3-D2 — half done, half deliberately deferred

**Done and measured:** the console refetch defects. `/admin` (P3-D1) and `/director` (this chunk)
both had `refresh` depending on the whole `auth` **object**, which `ensureSessionAlive()` replaces on
every window focus. Both now depend on a role **boolean**. Refocus: 7 → 1 and 4 → 1. **D8's "no
refetch-on-focus" now holds for both consoles.**

**Deferred: migrating console reads to the TanStack Query layer.**

The evidence for doing it: `/api/tournaments` is fetched **twice within 13 seconds** across a
`/director → / → /director` navigation, and `QueryClient` already exists in
`src/infrastructure/query/provider.tsx` with `staleTime: 30_000`, used for nothing.

The evidence against doing it **now**:

- The benefit is **~259 bytes per navigation**, plus per-query error granularity.
- The cost is rewiring the **mutation → `refresh()`** path of the two consoles that perform the
  irreversible actions: tournament deletion, Excel **export & purge**, snapshot publish/retract,
  account creation and deletion. An operator acting on stale state there is a materially worse
  outcome than a duplicated 259-byte GET.
- `00_MASTER_PLAN.md` §1: *"When 'nicer architecture' conflicts with 'existing code already proven
  safe in competition', choose the existing code."* The optimisation order is
  correctness → production safety → measurable performance.

**Recommendation:** take it after the competition, or with time to exercise every destructive flow
end to end. It is a performance refinement, not a defect fix — the defects D2 named are fixed.

> Also checked and deliberately **not** changed: `/admin` discards the return of `loadArchives()`,
> which looks like a wasted request but is not — `loadArchives()` populates `state.archives`, which
> the page renders. Verified in the store before touching it.

## 6. The `/admin` N+1 — established, and it needs a backend change

Per instruction, the origin was established before proposing anything. The remaining three requests
are `GET /api/admin/tournaments/{id}/public-snapshot/status`, **one per tournament**, issued by the
`SnapshotPublicationPanel` mounted on each row.

**This is one request per distinct resource, not a pathological N+1.** The pathological one — five
calls to the *same* readiness endpoint — is fixed. Collapsing three distinct tournament statuses into
one request requires either:

- a **backend batch endpoint** — outside P3's frontend-only scope, and not proven necessary by the
  259-byte-scale numbers involved; or
- **D3 admin narrowing** — an owner decision, explicitly excluded.

A query layer would **not** help: the three URLs are distinct, so caching dedupes repeats, not the
first load. **Reported rather than actioned**, and `13_P3_PLAN.md`'s "≤ 8 requests" target for
`/admin` is therefore **not met** — it is 10.

## 7. Tests

| Gate | Result |
|---|---|
| `npm test` | **135 pass, 0 fail** (119 at P2 + 6 selector + 5 fallback + 5 shell) |
| lint / typecheck / build | exit **0 / 0 / 0** |
| Backend `mvn -o test` | **325/325**, 0 failures — P3 touches no backend code |

P3-C has **no unit test**: the repo has no React hook-testing setup and adding one would be unrelated
scope. It is covered by the two runtime checks in §4 instead, and that is stated rather than glossed.

## 8. Environment

| | |
|---|---|
| Processes | all mine stopped (`:8081`, `:3100`). The user's `:8080` backend and `:3000` dev server never touched |
| Probe accounts | `p3gate-*`, `p3e-*`, `p3d2-*` created with generated passwords, **all deleted** — 0 remain |
| DB | `accounts 4 · tournaments 3 · cards 7 · players 518 · members 2 · access 1` — **identical to session start** |
| Postgres settings | never altered (`log_min_duration_statement` = `-1`); counting used a Tomcat access-log flag on the throwaway backend process |
| Instrumentation | the temporary AppShell render counter was **removed before the P3-E commit**; `grep TEMP-P3E` returns 0 |
| `next-env.d.ts` | restored after every build; tree clean |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **all 7 OK** |

**Intentional data change:** the isolated `P0 SSE Fixture` card advanced `v33 → ~v40` (game-4 results
and a `results/review`) producing the Invariant A/B and P3-E evidence. All writes stayed inside the
isolated P0 tournament.

## 9. Exact next action

1. `git log --oneline -1` → expect `e4c5b98`.
2. **Decide P3-D2's query migration** (§5). If taking it: migrate `/admin` and `/director` reads to
   `useQuery`, keep `refresh()` as `refetch()` so mutation semantics are unchanged, and exercise
   every destructive flow — delete tournament, export & purge, publish/retract, account CRUD —
   against a throwaway tournament before committing.
3. Then `15_P3_CLOSURE.md`, and only then may P3 be called complete.

**Rollback:** each chunk is its own commit and independently revertible. P3-B is the only one with a
user-visible data-path change and it degrades safely — its 400/404/405 fallback restores the old
`/api/cards` behaviour exactly. The P1-A ordering rule still stands: never revert P1-A while P2-B is
in.
