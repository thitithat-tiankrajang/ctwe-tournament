# P4 — CLOSED. Final gate **PASS**.

```
P4 STATUS: CLOSED — all three deliverables shipped, plus the three SSE correctness fixes they needed
HEAD:      a3dc2562731fbc6c3f9c8df1097955d41ef9b12a
BASELINE:  d77492e (P3 closed)
TREE:      clean · frozen evidence 7/7 OK · DB unchanged · no processes left running
GATES:     backend 337 run / 0 fail / 0 SKIPPED · npm test 171/171 · lint 0 · typecheck 0 · build 0
```

Plan: `00_MASTER_PLAN.md` §3. Gate record: `16_P4_SSE_PROOF_GATE.md` (FAILED) →
`17_P4_SSE_PROOF_GATE_RERUN.md` (PASSED).

---

## 1. What P4 turned out to be

P4 was scoped as *"UI primitives, concurrent-draft warning, viewer view-picker"*. Two of those were
straightforward. The third was not, and the reason is the phase's main result:

**The concurrent-draft warning was blocked by a proof gate it initially failed.** The UX depends on
"B is told", and measurement showed the staff realtime path could silently fail to tell them. Rather
than build the warning on that, P4 fixed the transport first — three commits — re-ran the gate, and
only then implemented the feature. The full record is in `16_` and `17_`.

## 2. Commits

| # | Commit | Delivers |
|---|---|---|
| 1 | `2293fb8` | SSE proof gate **FAILED** — evidence, and the warning blocked |
| 2 | `f0e3be1` | **Fix A** — staff path detects a dropped result event |
| 3 | `43a8d02` | **Fix B** — a dropped send can no longer leave a client silently stale |
| 4 | `0bcc232` | **Fix D** — the acting account rides the staff result event |
| 5 | `cb35f84` | SSE proof gate **re-run: PASSED** |
| 6 | `c64c6b0` | **Retract wording** |
| 7 | `ac64d81` | **D15 / UX-F3** — view picker + publish banner |
| 8 | `a3dc256` | **Concurrent-draft warning** |

## 3. The eight deliverables, and the evidence for each

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | **D15 / UX-F3** | **PASS** | desktop 1280 → `role=group`, Ranking+Pairing both open; phone 390 → `role=radiogroup`, picking replaces; publish → banner, **screen does not move**; follow/dismiss both work. 8 unit tests pin the selection rule |
| 2 | **Retract wording** | **PASS** | button tooltip and retracted-state note both state "up to about 5 minutes", matching `max-age=300` + best-effort purge. Acknowledgment copy untouched (backend validates its revision) |
| 3 | **Concurrent-draft warning** | **PASS** | runtime: B types `123/99`, A commits `611:410` → dialog names `director-a - DIRECTOR`, pairing 1, `จาก ยังไม่มีผล เป็น 611 : 410`, button exactly `รับทราบ`; ack → draft gone, inputs show `611/410` disabled, `แก้ไข` required. 12 unit tests |
| 4 | **SSE gap detection + recovery** | **PASS** | runtime: version jumped by 3 → **full-card refetch fired** (1 → 2 card requests), row shows the server's `333 : 222`. 7 + 4 unit tests |
| 5 | **SSE overflow recovery** | **PASS** | `SseDropReachabilityTest` 5/5 — drop still happens, debt recorded once per stream, hint carries the authoritative version and clears the debt, healthy stream accrues nothing, dead stream owes nothing |
| 6 | **Actor identity propagation** | **PASS** | `SseDeliveryProofDatabaseTest` — wire value equals `matches.submitted_by` **and** `audit_logs.actor` for the same write; `result-event.test.ts` 5/5 parses the same frame client-side |
| 7 | **Public viewer actor-free** | **PASS** | see §4 |
| 8 | **Existing SSE behaviour intact** | **PASS** | `CardEventPublisherTest` 9/9, `SseDeliveryProofDatabaseTest` 4/4, full backend 337 with **0 skipped** |

## 4. Proof that no actor leaks to the public stream

Three independent checks, because this is the one property where a mistake is a privacy incident
rather than a bug:

1. **Structural** — the staff delta is a *separate record*. `ResultChangeEvent` (public) has no
   `actor` component at all; `StaffResultChangeEvent` does. A test asserts the public record's
   components via reflection, so the two can never be conflated by a later edit.
2. **Serialised** — `serialisedPublicFrameCarriesNoActor` serialises **both** records and asserts the
   bytes: the public frame contains no `actor`, no account name, no `ROLE_`. Reflection alone would
   not have caught a nulled field, and Jackson's app-wide `non_null` would have hidden it.
3. **End to end** — `viewerStreamCarriesNoActor` writes a real result as a real logged-in director
   and asserts the public projection never contains that account name.

`publishPublicResult` is unchanged in P4 and still constructs the public record.

## 5. Frozen code — exactly two approved changes, both minimal

| Frozen item | Status |
|---|---|
| `use-card-sync.ts` | **CHANGED — owner-approved exception.** 13 insertions, of which the functional part is: two optional interface fields, one store selector, one call, one dep-array entry. No second EventSource; lifecycle, connection model, caps and every other handler untouched |
| `store.ts` `applyResultPatch` | **CHANGED — owner-approved (fix A).** The entire behavioural change is one line: `if (version !== card.version + 1) return card;` |
| `store.ts` `replaceCard` | **byte-identical** |
| `store.ts` `applyPairingsPatch` | **byte-identical** |
| `store.ts` `applySnapshotPublish` | **byte-identical** |
| `store.ts` `mutateCard` | **byte-identical** |
| `use-public-sync.ts` | **unchanged** |
| `snapshot-api.ts` | **unchanged** |
| `backend/…/publicsnapshot/**` | **unchanged** |
| `TournamentCardService.java` | **unchanged** |

The `noteRemoteResultChange` call sits deliberately **before** `applyResultPatch`: the dialog must say
"จาก X เป็น Y", and after the patch the previous scores are gone. It records only what the warning
needs to *say* — reconciliation remains `applyResultPatch` or the version-gap resync, unchanged. That
is why the warning is not a second state-reconciliation mechanism.

## 6. Change surface — nothing unrelated

Twenty files across P4, every one traceable to an approved deliverable:

```
backend main (2)   CardEventPublisher.java (B + D) · CardController.java (D)
backend test (4)   CardEventPublisherTest · SseDropReachabilityTest
                   SseDeliveryProofDatabaseTest · CardControllerCacheRoutingTest (signature)
frontend src (6)   store.ts (A + notice) · use-card-sync.ts (approved) · result-entry-grid.tsx
                   card-overview.tsx (D15) · snapshot-publication-panel.tsx (wording) · result-event.ts
frontend test (5)  sse-gap-recovery · sse-gap-resync · concurrent-draft-warning
                   result-event · overview-view-picker
styles (1)         globals.css — banner + dialog score line
docs (2)           16_ and 17_
```

**No owner-decision item was touched:** B7/SECURITY-01, D17, P1-D, D3 admin narrowing and
`HttpSessionEventPublisher` are all absent from the diff.

## 7. Gates

| Gate | Result |
|---|---|
| `npm test` | **171 pass, 0 fail, 0 skipped** (P3 closed at 151) |
| `npm run lint` / `typecheck` / `build` | **0 / 0 / 0** |
| Backend `mvn test` | **337 run, 0 failures, 0 SKIPPED** — `DATABASE_PASSWORD` set, so every real-DB integration test executed |
| Per-suite | `CardEventPublisherTest` 9 · `SseDropReachabilityTest` 5 · `SseDeliveryProofDatabaseTest` 4 · `sse-gap-recovery` 7 · `sse-gap-resync` 4 · `concurrent-draft-warning` 12 · `result-event` 5 · `overview-view-picker` 8 |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **7/7 OK** |
| Working tree | **clean** |

## 8. Environment

| | |
|---|---|
| Database | `accounts 4 · tournaments 3 · cards 7 · players 518 · matches 149 · members 2` — identical to the P3 baseline. **Zero accounts created today**; the `ittest` row predates this work (2026-08-04) |
| Processes | harness on `:3101`/`:8092` stopped. The user's `:3000` and `:8080` verified healthy (200) |
| Build artifacts | isolated dist dirs removed; `tsconfig.json` and `next-env.d.ts` restored |
| Credentials | none used. The DB tests carry their own test-only staff hash and throwaway accounts |

## 9. Honest limits, stated rather than glossed

- **No React test setup in this repo.** The dialog's and picker's *rendering* is proven by the runtime
  runs above, not by component tests; their *rules* (`selectConflicts`, `nextOverviewViews`) are pure
  functions with unit tests. Adding a React testing stack would be unrelated scope.
- **Two handler predicates in `sse-gap-resync.test.ts` are quoted from the frozen `use-card-sync.ts`,
  not executed inside it** — running the hook needs a DOM and an `EventSource`. They are pinned as
  tests so either side changing breaks visibly.
- **The matchMedia `change` listener is covered by mount-time value plus unit tests**, because a CDP
  viewport override does not fire the event. A real browser resize does.
- **`SseDropReachabilityTest` uses a queue depth of 2, not production's 4096.** It uses the *real*
  executor factory and rejection policy; only the depth differs, because the trigger is a stalled
  socket rather than volume.

## 10. Verdict

**P4 FINAL GATE: PASS.** All eight deliverables verified, working tree clean, frozen evidence intact,
database unchanged, no unrelated source changes, no actor leakage, no gap/resync regression.

P5 (information architecture + URL state) is **not started**, per the §4 scope freeze which lists it
under *CUT IF LATE*.
