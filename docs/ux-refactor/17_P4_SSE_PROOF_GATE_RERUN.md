# P4 SSE PROOF GATE, re-run after A + B + D — **PASSED**

```
VERDICT:   PASSED — the concurrent-draft warning is UNBLOCKED
FIXES:     f0e3be1 (A, frontend gap detection) · 43a8d02 (B, backend delivery safety)
           0bcc232 (D, actor identity)
GATES:     backend 336 run / 0 failures / 0 SKIPPED · npm test 151/151 · lint 0 · typecheck 0 · build 0
FROZEN:    use-card-sync.ts, use-public-sync.ts, snapshot-api.ts, card-overview.tsx — 0 changes
DB:        accounts 4 · tournaments 3 · cards 7 · players 518 · matches 149 · members 2 · 0 leftovers
```

Supersedes `16_P4_SSE_PROOF_GATE.md` (the FAILED first run). That document stands as the record of
what was broken; this one records that it no longer is.

---

## 1. Required coverage, item by item

| # | Gate requirement | Result | Evidence |
|---|---|---|---|
| 1 | Two genuinely independent authenticated sessions | **PASS** | `SseDeliveryProofDatabaseTest` — two accounts, two cookie jars, real login, real Tomcat |
| 2 | Normal result delivery | **PASS** | every persisted save reaches B, one event each |
| 3 | Dropped / overflow event behaviour | **PASS** | `SseDropReachabilityTest` — real executor factory, real rejection policy |
| 4 | Version-gap detection | **PASS** | `sse-gap-recovery.test.ts` — gapped event reported unpatched, nothing half-applied |
| 5 | Automatic full-card resync | **PASS** | `sse-gap-resync.test.ts` — the chain ends with B holding the server's state |
| 6 | DB persistence and card-version correctness | **PASS** | versions asserted against `tournament_cards.version` via JdbcTemplate |
| 7 | Actor identity correctness | **PASS** | `bLearnsWhoChangedTheResult` — wire value equals `matches.submitted_by` and `audit_logs.actor` |
| 8 | Event payload agreement | **PASS** | delivered `scoreOne` equals the persisted `matches.score_one` |
| 9 | No lost updates | **PASS** | complete, ordered, contiguous, no duplicates, including rapid bursts |
| 10 | No silent stale client state | **PASS** | see §2 — every drop path now terminates in a refetch |

## 2. The chain that used to break, closed link by link

The first run failed because a drop was **silent** and the staff client **could not tell**. Both
halves are now covered, and the recovery is proven to *close the hole* rather than merely detect it:

```
A submits              -> persisted                       verified in PostgreSQL
publisher overflows    -> delta discarded                 SseDropReachabilityTest
                       -> debt recorded for that stream   owedResyncCount() == 1
heartbeat tick         -> `card` hint, AUTHORITATIVE ver  hint version == current, debt cleared
B receives the hint    -> hinted > held, so refetch       sse-gap-resync.test.ts (handler predicate)
   ...or a later event -> version != held + 1 -> false    sse-gap-recovery.test.ts
B calls syncCard       -> one request, not a storm        sse-gap-resync.test.ts
B holds the truth      -> the LOST result is now present  asserted on the resulting state
```

The last line is the one that matters: after the resync, the table whose result was carried by the
**dropped** event is present in B's state. That is what makes it safe for the warning to rely on
"B knows".

**Two independent recovery paths**, deliberately. The hint (B) covers the case where the dropped
event was the *last* one and no later event would expose the gap. The gap check (A) covers everything
else and needs no server cooperation. Either alone leaves a hole; together they do not.

## 3. What each fix actually changed

**A — `applyResultPatch` rejects any version that is not `card.version + 1`** (`f0e3be1`).
A result event is a delta and is only meaningful landing on the version you hold. Returning `false`
reuses the recovery contract every caller already had — `use-card-sync.ts`'s `if (!patched) void
syncCard(cardId)`, `submitResult`'s identical fallback, and `use-public-sync`'s `applyDelta`. That is
why **both frozen sync hooks are byte-identical in this work**; the signal existed and was simply
never sent. The owner-approved frozen-file change is one function, justified in the commit.

**B — an overflowed delta is downgraded to a supersedable hint instead of vanishing** (`43a8d02`).
Queued writes became a named `SendTask` so the rejection handler can distinguish a droppable
heartbeat from a delivery; `RecordDiscardedAsResyncDebt` keeps DiscardOldest semantics but records
the victim; the heartbeat tick flushes the debt as a `card`/`message` event carrying the stream's
authoritative version, clearing the debt only once it is actually written.

> **A real bug in the first cut of B, caught by its own dead-stream test.** The debt was a `Set`
> keyed by a record whose component was the subscribers **map**. `ConcurrentHashMap` hashes by
> *content*, so the instant `remove()` dropped the emitter the key moved bucket and the debt became
> unfindable — it would have leaked in production. Now keyed by the emitter, whose hash is identity.

**D — the staff result event names the acting account** (`0bcc232`).
`actor` is `authentication.getName()`; `actorRoles` is the authority list derived exactly as
`GET /api/auth/me` derives it. No new identity source: the end-to-end test asserts the wire value
equals both `matches.submitted_by` and `audit_logs.actor` for the same write.

> **Privacy note.** `ResultChangeEvent` also rides the **anonymous** viewer stream. The staff delta is
> therefore a **separate record** (`StaffResultChangeEvent`) rather than a nullable field, so a staff
> account name cannot reach a viewer by a careless edit. A test asserts the public record has no such
> component at all, and the e2e test asserts the public projection never contains the writer's name.

## 4. Evidence

| Artifact | Covers |
|---|---|
| `backend/.../SseDeliveryProofDatabaseTest.java` (4 tests) | 1, 2, 6, 7, 8, 9 — two real sessions, real Tomcat, real SSE, verified against PostgreSQL |
| `backend/.../SseDropReachabilityTest.java` (5 tests) | 3, 10 — real executor factory and rejection policy; drop, debt, authoritative hint, healthy-stream silence, dead-stream cleanup |
| `backend/.../CardEventPublisherTest.java` (8 tests) | 7 — actor on the staff event, structurally absent from the public one |
| `src/application/tournament/sse-gap-recovery.test.ts` (7 tests) | 4 |
| `src/application/tournament/sse-gap-resync.test.ts` (4 tests) | 5, 10 |
| `src/application/tournament/result-event.test.ts` (5 tests) | 7 — client parses the exact frame the backend emits, incl. Invariant D absence |

**Honest scope limit, stated rather than glossed.** The two handler predicates in
`sse-gap-resync.test.ts` (the `card` hint rule and the `!patched` rule) are **quoted** from the
P0-frozen `use-card-sync.ts`, not executed inside it: running the hook needs a DOM and an
`EventSource`, and this repo has no React test setup. They are pinned as tests so a change to either
side breaks visibly. Everything else in the chain runs the real code.

## 5. Gates

| Gate | Result |
|---|---|
| Backend `mvn test` | **336 run, 0 failures, 0 SKIPPED** — with `DATABASE_PASSWORD` set, so every real-DB integration test executed |
| `npm test` | **151 pass, 0 fail** (139 → 151) |
| lint / typecheck / build | **0 / 0 / 0** |
| Frozen files | `use-card-sync.ts`, `use-public-sync.ts`, `snapshot-api.ts`, `card-overview.tsx` — **0 changes across all of P4** |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **7/7 OK** |
| Database | reconciled exactly; **0** `p4-%` rows left |

## 6. Consequence

**The concurrent-draft warning is unblocked** and may now be implemented to the approved
specification, including the "รับทราบ" acknowledgement and the cancel-draft-then-show-latest
behaviour. It can rely on:

- **B is told.** Either the delta arrives, or a gap is detected, or a hint arrives — and every one of
  those paths ends in authoritative state.
- **B can name who.** `actor` + `actorRoles` ride the staff event.
- **B can show old → new.** The old value is the row B already holds; the new value is on the event.

Still open and untouched: B7/SECURITY-01, D17, P1-D, D3 admin narrowing, `HttpSessionEventPublisher`.
