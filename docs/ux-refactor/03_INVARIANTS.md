# Invariants — code and behaviour that must not change

Owner-declared invariants: pairing logic, ranking logic, diff calculation, Gibson, per-game max diff,
scoring, final-round business logic, publish semantics, PDF/Excel behaviour, SSE patch semantics,
multi-user editing behaviour, published static snapshot behaviour.

Below: the concrete code that implements them, why it is correct, and the traps.

> ### ⚠️ Line numbers in these documents drift — grep, do not trust them
>
> Re-verified 2026-08-22 against the working tree. **Every claim's substance was correct, but several
> line citations were off by up to 11 lines**, and one was actively dangerous:
>
> | Cited | Actual | Note |
> |---|---|---|
> | `replaceCard` :305-325 | **:316** | |
> | `applyResultPatch` :445-478 | **:450** | The cited range **started inside `mutateCard`** (:442) — following it to "the frozen function" lands on the wrong one |
> | `applyPairingsPatch` :484-515 | **:487** | |
> | `applySnapshotPublish` :521-548 | **:523** | |
> | `applyResultPatch` version guard :466 | **:459** | (also :493, :529 for the sibling patches) |
> | `readError` :246 | **:257** | function starts :254 |
> | staff-login redirect guard :213 | **:212** | |
> | `If-Match` :445 | **:445** | correct |
> | `publishedTokens` :364 | **:361** | |
> | `bundleInflight` :381 | **:382** | |
> | `publicScopeToken` :337 | **:337** | correct — but 8 read/write sites, not 1 |
>
> **Locate frozen code by symbol name, never by line number.**

---

## 1. Frozen files — do not modify without explicit owner approval

| File / function | Why frozen |
|---|---|
| `src/application/tournament/store.ts` — `replaceCard` (**:316**), `applyResultPatch` (**:450**), `applyPairingsPatch` (**:487**), `applySnapshotPublish` (**:523**) | The SSE patch layer. Version guards and reference-equality preservation are load-bearing and untyped |
| `src/application/tournament/use-card-sync.ts` | Staff SSE lifecycle |
| `src/application/tournament/use-public-sync.ts` | Public SSE lifecycle, delta gap detection, backoff, published-path gating |
| `src/infrastructure/http/snapshot-api.ts` | Snapshot resolution and fail-open behaviour |
| `backend/.../application/publicsnapshot/**` | Publish/retract pipeline |
| `backend/.../application/TournamentCardService.java` — pairing, ranking, diff, Gibson, final-round methods | Tournament business logic |

Permitted exception already agreed: gating the two sync hooks in `app-shell.tsx:151-152` on
`!loading` (two lines, P2).

## 2. Do NOT delete — looks dead, is not

| Item | Evidence it is live |
|---|---|
| `If-Match` header set in `store.ts:445` (`mutateCard`, defined :442) | `CardController` ignores it, but **`DevToolsController.java:25,31,37,43,50` reads it**. Deleting it breaks the dev tools used to generate test data |
| `backend/.../application/WebPushService.java` | Injected into `CardController`'s constructor and called (`push.pairingPublished(...)`). Removing it means surgery on the hottest backend file. Deferred until after the competition |
| `public/notification-sw.js` | Already registered in returning users' browsers. Deleting the file without an unregister path changes production behaviour |
| `/tournaments` and `/cards/[id]/standings` | Live redirect routes; bookmarks may exist. Deleting turns a redirect into a 404 |
| `store.ts:212` — `if (path === "/staff-login" ...) return;` in `redirectToLoginOnSessionLoss` | Prevents an infinite redirect loop when the login page itself receives a 401 |
| `@tanstack/react-query` dependency | Still imported by `src/infrastructure/query/provider.tsx` |
| Module-level state in the store closure: `publicScopeToken` (**:337**), `publishedTokens` (**:361**), `bundleInflight` (**:382**) | Invisible in any architecture diagram. They implement viewer bundle dedup and scope guarding. A store restructure would silently drop them. **`publicScopeToken` alone is read/written at 8 sites — :272, :337, :390, :557, :669, :683, :890, :894** |
| `realtime-config` module cache + `shouldUseRealtime` gate (`use-realtime-config.ts`, `use-public-sync.ts:50-52`) | Implements "a published tournament issues zero origin requests" |

---

## 3. Verified-correct mechanisms — understand before touching anything nearby

### 3.1 Stale GET cannot roll back newer state — VERIFIED

`store.ts:317-319` (inside `replaceCard`, :316):

```ts
const existing = state.cards.find((card) => card.id === updated.id);
if (existing && existing.version > updated.version) return { error: null };
```

An in-flight `GET` that resolves after an SSE patch is discarded.

### 3.2 `?v=` is a cache key, not a version request — VERIFIED

`backend/.../web/PublicCardController.java:64-71`:

```java
CardDtos.CardResponse body = cards.get(cardId);
boolean versioned = Long.toString(body.version()).equals(request.getParameter("v"));
return cached(request, body, "\"card-" + cardId + "-v" + body.version() + "\"",
    versioned ? IMMUTABLE_POLICY : LIVE_POLICY);
```

The server always returns the **current** version, and marks it `immutable` only when the requested
`v` matches exactly. A client can never be served an older representation.

### 3.3 Concurrent writes serialise on the card row — VERIFIED

`TournamentCardService.java:1996-2010` (`cardRow`) issues
`SELECT … FROM tournament_cards WHERE id = ? FOR UPDATE`, and `requireStage` (:2038-2045) calls it.
Every card mutation therefore holds the row lock for its transaction.

**Trap:** this is why batching 200 result saves into one transaction was rejected — it would hold
that lock for the whole batch and block every other staff member on that card.

### 3.4 Standings are derived, not incrementally maintained — VERIFIED

`recalculateStandings` (`TournamentCardService.java:1957-1987`) resets to zero and replays every
`matches` row with `result_type IS NOT NULL`. Callers: `:399, :524, :742, :979, :1138, :1179, :1210`.

**`submitResult` (:803-877) does not call it.** Standings therefore reflect the last publish/override/
penalty/terminate, not the in-progress block. Partial failures cannot corrupt standings.

### 3.5 Side effects of saving one result — VERIFIED

`TournamentCardService.submitResult` (:803-877) then `CardController.submitResult` (:208-225):

```
requireStage(RESULT_COLLECTION)      -> SELECT … FOR UPDATE
8 validations (bye / both-null / snapshotNo / PENALTY lock /
               activeResultGames / PAIR_RESULT source-group / editExisting)
calculatedDiff = min(|scoreOne - scoreTwo|, match.maxDiff)
saveResultColumns(...)
touch(cardId)                        -> version + 1
audit(SUBMIT_RESULT | EDIT_RESULT)   -> one row per result
PAIR_RESULT: syncPairResultSource(...)          (materialises destination rows)
deferred Swiss: tryMaterializeDeferredSwiss(...) (auto-pairs the bottom group)
if pairingPublishedAt != null || snapshotNo != null: publishPublic() -> public_version + 1
@EvictPublicCard                     -> evicts the Caffeine read cache
--- transaction commits ---
events.publishResult(cardId, patch)                       (staff SSE)
events.publishPublicResult(...) | publishPublicIfBumped() (public SSE)
```

Not touched: standings, publish state, ranking.

### 3.6 Published snapshot pipeline is safe at every failure point — VERIFIED

`backend/.../application/publicsnapshot/PublicSnapshotPublisher.java:80-118` and the class javadoc
(:25-50):

```
1 CLAIM   row lock, state = PUBLISHING, version n
2 BUILD   read-only REPEATABLE_READ straight from Postgres, bypassing the cache
3 STAGE   private history + a public staging key nothing points at
4 VERIFY  GET through the real public hostname; assert 200, length, sha256
5 RECORD  publication row = VERIFIED
6 PROMOTE single atomic PutObject  <-- public traffic switches here and only here
7 PURGE   Cloudflare purge-by-URL, best effort
8 RE-VERIFY cache-busted GET, same checksum
9 COMMIT  state = PUBLISHED
10 CLEANUP delete staging, best effort
```

Deliberately not `@Transactional`; `PUBLISHING` set under the lock in step 1 excludes a concurrent
attempt. **Failure at any step leaves the previously published object serving unchanged.**

### 3.7 Retraction is picked up by viewers — VERIFIED

`src/infrastructure/http/snapshot-api.ts:117-118`:

```ts
const memo = readMemo(accessToken);
if (memo === "live") return null;      // only "live" short-circuits
```

A `"published"` memo still performs the fetch, so a retracted object (now 404) falls through to the
live path. A `"live"` memo expires after `LIVE_MEMO_TTL_MS` = 10 minutes (:50, :164).

**Known bound, not a defect:** purge is best effort and staleness is bounded by `max-age=300`
(`PublicSnapshotPublisher.java:110-111, 307-309`), so a retraction may take **up to 5 minutes** to
disappear from the edge. The admin UI does not say this today — wording fix scheduled for P4.

### 3.8 403 never triggers logout on the frontend — VERIFIED

`expireBackOfficeSession` is reached only from the 401 branch (`store.ts:284`) and from
`refreshAuth`/`ensureSessionAlive`/`load` when `/api/auth/me` confirms a non-staff session.
`verifyPassword` treats 401 **and** 403 the same (`store.ts:829`).

### 3.9 `request()` tolerates a body where 204 was expected — VERIFIED

`store.ts:307-309`:

```ts
if (response.status === 204) return undefined as T;
const body = await response.text();
return body ? JSON.parse(body) as T : undefined as T;
```

---

## 4. Behavioural invariants to assert after every gate

| ID | Invariant | How to check |
|---|---|---|
| **A** | After a save: DB row == card-store == what a second browser renders | Save via UI, query Postgres directly, read the store, read the second browser's DOM |
| **B** | SSE event type, order, payload shape and version semantics are unchanged | Diff against the captured baseline traces for: one result save, one pairing confirm, one results publish. Normalise timestamps and `updatedAt` |
| **C** | Published snapshot is semantically identical | Deep-equal `payload` after sorting `cards[]` by id, `pairings[]` by `(gameNumber, tableNumber)`, `players[]` by code. Normalise `snapshot.publishedAt` and `snapshot.version`; **do not** normalise `snapshot.checksum` — it must match |
| **D** | Old FE + New BE, and New FE + Old BE, both work | Manual matrix, run once after P1, documented |
| **E** | Multi-user editing loses nothing | Two browsers: A saves pair 1, B saves pair 2 → both persist in the DB and appear in both browsers |
