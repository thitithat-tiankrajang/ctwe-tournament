# P4 SSE PROOF GATE — **FAILED. HARD STOP.**

```
VERDICT:   FAILED — the concurrent-draft warning MUST NOT be implemented on the current SSE contract
SCOPE:     the staff/back-office realtime path only (/api/cards/{id}/events)
BASELINE:  d77492e (P3 closed)
EVIDENCE:  SseDropReachabilityTest · SseDeliveryProofDatabaseTest · sse-gap-recovery.test.ts
GATES:     backend 329 run / 0 fail · npm test 139/139 · lint 0 · typecheck 0
DB:        reconciled — accounts 4 · tournaments 3 · cards 7 · players 518 · members 2 · 0 leftovers
```

**Two of the three P4 items are unaffected and remain approved: D15/UX-F3 and the retract wording.
Only the concurrent-draft warning is blocked.**

---

## 1. What the gate asked, and what was actually found

The proposed UX depends on: *A submits → persisted → SSE emitted → **B receives** → B is warned →
B's stale draft is cancelled.* The gate exists to prove the "B receives" link.

The healthy path is **sound**. The failure is that **the link can break silently, and B cannot tell.**

| # | Property | Result |
|---|---|---|
| 1 | Persisted in PostgreSQL | **PASS** |
| 2 | SSE event emitted after commit | **PASS** — `CardController:213-215`, service first, publish second |
| 3 | B receives the event (healthy path) | **PASS** |
| 4 | Event identifies the right card | **PASS** |
| 5 | Event version correct vs DB | **PASS** |
| 6 | Versions monotonic, no duplicates | **PASS** |
| 7 | Payload agrees with DB | **PASS** |
| 8 | Rapid consecutive updates | **PASS** — complete, ordered, contiguous |
| **9** | **No event can be lost while B's stream stays healthy** | **FAIL** |
| **10** | **B detects a loss if one happens** | **FAIL** |

## 2. Finding 1 — the server can discard a persisted result silently

`CardEventPublisher` writes every event from **one** bounded writer thread under
`ThreadPoolExecutor.DiscardOldestPolicy` (`CardEventPublisher.java:80-91`). That policy is sound for
change *hints*, where a newer event supersedes an older one — the code says so. But `result` events
carry `changedPairings` **deltas**. A discarded delta is data, not a superseded hint.

`SseDropReachabilityTest` reproduces it with production's exact policy (one thread, bounded queue,
`DiscardOldestPolicy`) at a miniature queue depth:

```
subscriber knows version 10
A persists results at versions 11,12,13,14,15,16,17,18   (all committed to PostgreSQL)
B is delivered:                                  17,18
versions 11..16 are gone
```

The decisive part is not the loss — it is the **silence**:

- the emitter is **never completed** (`completed == false`), so EventSource never reconnects;
- **no error** reaches the client (`failed == false`);
- `enqueue()` swallows `RejectedExecutionException` outright (`CardEventPublisher.java:340-344`).

**Reachability is not theoretical.** Production's queue is 4096 deep, but the trigger is not volume —
it is **one stalled socket**. A single mobile client with a full TCP window holds the single writer
thread, and everything queued behind it belongs to *every other subscriber*. That is an ordinary
event-day condition, and it is precisely the condition the async-send design was introduced to
survive.

**There is also no replay.** `grep -ri "last-event-id" backend/src/main/` returns **nothing**: the
server never reads `Last-Event-ID`, so a reconnect cannot recover the interval either.

## 3. Finding 2 — the staff client does not notice, and the fix already exists in this repo

The two clients disagree, and the **staff** client — the one user B is on — is the weaker.

**Viewer** (`use-public-sync.ts:256-266`) guards every delta:

```ts
/** Shared guard for delta events: apply exactly version+1, resync on any gap or failure. */
if (known === undefined || version !== known + 1) { void syncCard(cardId, version); return; }
```

**Staff** (`use-card-sync.ts:77-88`) has **no contiguity check at all**. It applies whatever version
arrives and refetches only when `applyResultPatch` returns `false` — and `applyResultPatch`
(`store.ts:560-591`) returns `true` whenever an open snapshot exists, *regardless of how far the
version jumped*.

Measured (`sse-gap-recovery.test.ts`, and reproduced standalone before being written as a test):

```
card at version 10; events 11 and 12 were discarded; event 13 arrives
applyResultPatch(card, 13, [table2]) -> returns TRUE   => use-card-sync.ts:84 does NOT resync
card.version                          -> 13            => adopts a version it never reconciled
table 1 (the persisted v11 result)    -> scoreOne null => absent, and nothing will ever fetch it
```

**B ends up believing it is at version 13 while missing a persisted result, with no signal of any
kind.** That is the gate's explicit hard-stop condition: *"B remaining unaware of a persisted
update."*

## 4. Why this is fatal for the concurrent-draft warning specifically

The warning's whole purpose is to guarantee B cannot submit over A's change. Built on the current
contract it would be **worse than no warning**, because it converts "B might be stale" into "B is
told they are never stale unless a popup appears" — an assurance the transport cannot honour. The
exact dangerous sequence from the gate brief is reachable today:

```
A submits          -> DB holds A's result
event discarded    -> stream healthy, no error, no reconnect, no replay
B never warned     -> no popup, because no event arrived
B keeps editing    -> and submits stale data over A's persisted result
```

## 5. Finding 3 — the event cannot populate the approved popup even when it *does* arrive

Independent of delivery. The approved popup must show **account name + role**, the affected match,
and **old → new**. The `result` event carries:

```java
record ResultChangeEvent(UUID cardId, long version, Instant updatedAt, List<PairingResponse> changedPairings)
record PairingResponse(String id, int gameNumber, int tableNumber, String playerOneId, String playerTwoId,
                       String winnerId, Integer scoreOne, Integer scoreTwo, String resultType,
                       Integer calculatedDiff, boolean playerOneGibsonized, boolean playerTwoGibsonized,
                       boolean pairingPublished)
```

**Neither carries an actor.** `AuditResponse` has `user`, `oldValue` and `newValue`, but it rides
only inside the full `CardResponse.audit` — i.e. a `state` event or a full refetch, never a `result`
event. **Role** is nowhere in either. *Old → new* is recoverable client-side (B holds the previous
row), but **account name and role are not obtainable from the realtime event at all**.

## 6. Minimum architectural fix required

Ordered by necessity. **(A) alone is enough to unblock the UX**; (B) and (C) close the underlying
hole rather than only detecting it.

**(A) Give the staff path the contiguity guard the viewer already has. — REQUIRED, frontend-only.**
Apply exactly `known + 1`; on any gap call `syncCard(cardId)`. This is a port of `applyDelta` from
`use-public-sync.ts` into `use-card-sync.ts`'s `result` handler. It converts a **silent wrong state**
into a **self-healing refetch**, which is all the UX needs to be safe: after any gap B holds
authoritative data. Note `use-card-sync.ts` is a P0-frozen file, so this needs the owner's explicit
unfreeze, or the same "caller moves, frozen file stays" technique P2-D and P3-E used.

**(B) Stop discarding result deltas. — RECOMMENDED, backend.**
Either give `result` events a non-discarding path, or on overflow deliberately downgrade to a
`card` change-hint (which *is* safely supersedable and makes the client refetch). Silently dropping
a delta and leaving the stream healthy is the actual defect; (A) only detects it afterwards.

**(C) Honour `Last-Event-ID`. — OPTIONAL.**
Would let a reconnecting client recover the interval instead of refetching the whole card. A
performance refinement once (A) and (B) are in, not a correctness requirement.

**(D) Put the actor on the event. — REQUIRED for the popup's text, backend.**
Add `submittedBy` (and role, or a role lookup) to `ResultChangeEvent`. Additive and backward
compatible; without it the popup cannot name who changed the result, which is the one thing it
exists to say.

## 7. Evidence

| Artifact | What it proves |
|---|---|
| `backend/.../SseDropReachabilityTest.java` | the discard is reachable, and silent (stream healthy, no error, no completion) |
| `backend/.../SseDeliveryProofDatabaseTest.java` | the healthy path is correct: two real authenticated sessions, real Tomcat, real SSE, verified against PostgreSQL — persistence, identity, version, monotonicity, contiguity, payload agreement, rapid bursts |
| `src/application/tournament/sse-gap-recovery.test.ts` | the staff client applies a gapped patch instead of resyncing; the viewer's guard would have caught it |

`SseDeliveryProofDatabaseTest` uses throwaway tournaments, cards and accounts with generated
passwords and a test-only staff hash, exactly like the existing `*DatabaseTest` suite. The user's
credentials were never used. Database reconciled after the run, 0 `p4-%` rows left.

> **Assertion corrected mid-run, recorded rather than buried.** The reachability test first asserted
> a gap *between delivered events* and failed: the writer delivered `[17, 18]`, which is trivially
> contiguous. Six of eight events had been dropped outright, so the hole is between the subscriber's
> **known** version and the first event it receives — which is exactly the predicate the viewer
> guards and the staff client ignores. The assertion was rewritten to that property.

## 8. Status of the three P4 items

| Item | Status |
|---|---|
| **Concurrent-draft warning** | **BLOCKED** by this gate. Not implemented, not started |
| **D15 / UX-F3** viewer view picker | approved, unaffected — the viewer path has the guard |
| **Retract "up to 5 minutes" wording** | approved, unaffected — copy only |

Owner decisions still open and untouched: B7/SECURITY-01, D17, P1-D, D3 admin narrowing,
`HttpSessionEventPublisher`. Fix (A) additionally needs a decision on unfreezing `use-card-sync.ts`.
