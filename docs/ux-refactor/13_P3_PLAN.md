# P3 — Data layer, summaries consumption, scope authority. PLAN.

```
STATUS: PLAN — derived 2026-08-22 from the evidence set + fresh runtime measurement.
PREREQUISITE: P2 CLOSED (12_P2_CLOSURE.md). Baseline HEAD 2cd0828.
NUMBERING: this is 13_, not 12_ — 12_P2_CLOSURE.md already exists.
```

Labels: **MEASURED** = counted at runtime this session · **VERIFIED** = read from source ·
**UNVERIFIED** = believed, untested.

---

## 1. Goal, and what P3 is *not*

`00_MASTER_PLAN.md` §3 defines P3 as *"Data layer, summaries consumption, URL scope authority,
query layer, selectors"* with five internal gates A–E that must ship as separate commits.

**P3 is a data-flow refactor, not a visual redesign.** That is not a judgement call — it follows from
evidence:

> **The UI/UX audit is already done.** `design.md` (repo root, 2026-07-15) audited every page and
> role and coded every item. Its status block records **two completed validation rounds**: UI-R1–R10,
> UI-F1–F13, UI-A1–A4, UX-F1, F2, F4–F9, UX-R2, UX-A3, UX-A5 and all of Section 4 are **implemented**.
> Spot-checked and confirmed this session: `DataGrid` now honours `resetKey`
> (`data-grid.tsx:473-485`), the `/cards` empty state links to `/` rather than `/admin`, and the
> dev-tools badge reads "ADMIN ONLY".
>
> The **only** un-implemented items are explicitly marked *"ยังไม่ถูก validate"* — UX-F3, UX-R1,
> UX-R3, UX-A1, UX-A2, UX-A4, UI-A5 — and they are owner-validation items, not defects. **UX-F3
> (segmented picker that is really multi-select) is decision D15, already assigned to P4.** IA
> restructuring is P5 under the §4 scope freeze.

So the remaining measurable problems are **all in data flow**, which is exactly where the
measurements below point.

## 2. Measured problems — the baseline P3 must beat

All counted at the backend with a Tomcat access log, production frontend build, one browser,
poller excluded, on the real dataset (3 tournaments, 7 cards, 518 players).

| # | Flow | MEASURED today | Target |
|---|---|---|---|
| **M1** | `/admin` page load, **3 tournaments** | **15 requests** — incl. **5× `/api/admin/system/shutdown-readiness`** and **3× `/api/admin/tournaments/{id}/public-snapshot/status`** | ≤ 8, readiness **1×** |
| **M2** | **Window refocus** on `/admin` | **7 requests** (3× readiness again) | **≤ 1** |
| **M3** | Staff/admin login → landing | **7 requests, 3× `/api/auth/me`**, 10,676 B | 4 requests, **1×** |
| **M4** | Director authenticated card list | `GET /api/cards` = **94,918 B** uncompressed | `/api/card-summaries` = **649 B** — **146×** |
| **M5** | Admin authenticated card list | `GET /api/cards` = **156,551 B** uncompressed | `/api/card-summaries` = **2,392 B** — **65×** |

> **Honesty note on payload.** M4/M5 are uncompressed body sizes. On the wire the browser receives
> gzip — the admin `/api/cards` measured **9,592 B** compressed. The payload win is therefore
> smaller on the wire than the raw ratio suggests, but the **58-statement DB cost (R9) and the
> client-side parse/retain cost are unaffected by compression**, and those are the real targets.

### 2.1 Root cause of M1/M2 — VERIFIED, and the fix already exists in a sibling

`ShutdownReadinessPanel` builds its fetch callback as

```ts
const refresh = useCallback(async () => { … onError(…) }, [loadShutdownReadiness, onError]);
useEffect(() => { void refresh(); }, [refresh]);
```

and `admin/page.tsx:320` passes **`onError={(message) => toast.error(message)}` inline**, so `onError`
gets a new identity on every admin render → `refresh` changes → the effect re-fires → another
readiness request. The admin page re-renders roughly five times while tournaments, directors,
archives and three snapshot statuses land, which is exactly the **5×** measured.

**`SnapshotPublicationPanel` already solved this**, with the pattern and a warning comment:

```ts
const onStatusRef = useRef(onStatus);
const onErrorRef  = useRef(onError);
useEffect(() => { onStatusRef.current = onStatus; onErrorRef.current = onError; });
// "…one request storm per mounted row, forever."
```

P3 applies the established in-repo pattern rather than inventing one.

### 2.2 Why refocus costs 7 — VERIFIED

`useBackOfficeSessionGuard` calls `ensureSessionAlive()` on `focus`/`visibilitychange`, which sets a
**new `auth` object** even when nothing changed. Every `state.auth` subscriber re-renders, the admin
page's inline callbacks change identity, and the effects above re-fire. Fixing identity stability at
the source removes a whole class of cascades. D8 also requires **no refetch-on-focus** for console
data.

### 2.3 P3-B has a missing half — VERIFIED, and it is the real work

The summary→full upgrade path exists **only for the viewer**:
`use-public-sync.ts:195` fetches the full card when `openCard?.summaryOnly`, and
`card-overview.tsx:272` shows a placeholder meanwhile. **There is no authenticated equivalent** —
`use-card-sync.ts` opens the SSE stream but never proactively upgrades a summary.

So switching the authenticated `load()` to summaries **without** adding that trigger would leave a
director staring at "กำลังโหลดข้อมูลการแข่งขัน…" until an SSE `state` event happened to arrive.
P3-B must add the authenticated upgrade. **`use-card-sync.ts` is frozen**, so the trigger goes in a
new hook called from `app-shell.tsx` — the same "pass arguments, don't edit the frozen hook"
technique P2-D used.

## 3. Chunks, in implementation order

Ordered by **measured value ÷ risk**, not alphabetically. The master plan requires separate commits,
not a particular sequence; A still precedes B because B consumes A.

| # | Chunk | Delivers | Risk |
|---|---|---|---|
| **P3-D1** | Stabilise console fetch callbacks + `auth` identity | **M1, M2** — the request storms | **low** — no frozen code, no store surgery |
| **P3-A** | `summaries: BackOfficeCardSummary[]` in the store + narrow selectors. **Container stays `TournamentCard[]`** (B1) | foundation for B | low |
| **P3-B** | Consume `GET /api/card-summaries` on the authenticated path, with 400/404/405 fallback to `/api/cards`, **plus the authenticated summary→full upgrade** | **M4, M5** | **medium** — touches `load()` |
| **P3-E** | AppShell selectors + memoisation | AppShell renders per SSE event → 0 | medium |
| **P3-D2** | Console data into the TanStack Query layer with `staleTime`, per-query errors | **M2** properly; D8 stale-while-revalidate | medium |
| **P3-C** | URL-derived tournament scope, **in the `/cards/[id]` route page only** (B5) | correctness | medium |

**Deferred out of P3 (unchanged):** B7/SECURITY-01, D17, `HttpSessionEventPublisher`, P1-D,
**D3 admin narrowing** (admin still receives a card list; narrowing it is a behaviour change needing
the owner). UX-F3/D15 and IA remain P4/P5.

## 4. Files expected to change

```
P3-D1  src/ui/components/shutdown-readiness-panel.tsx     ref-stabilise onError
       src/app/admin/page.tsx                             stable callback identities
       src/application/tournament/store.ts                auth identity stability
P3-A   src/application/tournament/store.ts                + summaries field, + selectors
P3-B   src/application/tournament/store.ts                load() consumes summaries + fallback
       src/application/tournament/use-full-card.ts        NEW — authenticated upgrade trigger
       src/ui/layout/app-shell.tsx                        call the new hook
P3-E   src/ui/layout/app-shell.tsx                        narrow selectors + memo
P3-D2  src/infrastructure/query/*                         real queries (the provider is a shell today)
       src/app/admin/page.tsx, src/app/director/page.tsx  consume queries
P3-C   src/app/cards/[id]/page.tsx                        URL-derived scope (route page ONLY)
```

**No backend change. No API contract change.** `GET /api/card-summaries` already exists and is
already authenticated-only (P1-B); P3 is its first consumer, which is exactly what it was built for.

## 5. Invariants

| ID | P3 impact |
|---|---|
| **A** | untouched — no write path changes |
| **B** | **`replaceCard`, `applyResultPatch`, `applyPairingsPatch`, `applySnapshotPublish`, `use-card-sync.ts`, `use-public-sync.ts` stay byte-identical.** P3-A adds a *sibling* field, per B1; the array container is NOT changed |
| **C** | snapshot path untouched |
| **D** | New FE + Old BE is the exposed direction: a pre-P1-B backend answers `/api/card-summaries` with **404**, which is precisely why P3-B carries the 400/404/405 fallback |
| **E** | untouched |
| **B1** | array container preserved — the whole point of P3-A |
| **B5** | URL scope lives in the route page, never in `CardOverview` (shared with `/tour/[token]`) |
| **B4** | all three defences preserved |

## 6. Rollback boundary

Frontend-only; each chunk its own commit. `git revert` per chunk, no migration, no data repair.
P3-B is the only chunk with a user-visible data path change, and it degrades safely: if
`/api/card-summaries` fails for any reason the fallback restores today's `/api/cards` behaviour
exactly. **The P1-A ordering rule still stands** — never revert P1-A while P2-B is in.

## 7. Gates

| Gate | Requirement |
|---|---|
| `npm test` | green, plus new tests for the summaries fallback and selector behaviour |
| lint / typecheck / build | exit 0 |
| Backend `mvn test` | 325/325 — P3 touches no backend code |
| **M1** | `/admin` readiness calls **1×**; total ≤ 8 |
| **M2** | refocus **≤ 1** request |
| **M4/M5** | authenticated card list served by `/api/card-summaries`; fallback proven by forcing a 404 |
| **Invariant B** | SSE fixture diff unchanged |
| **Invariant D** | director + staff flows, card list, card pages, result entry |
| Runtime | production build, access-log counted — never `next dev` |
