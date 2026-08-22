# Architecture Decisions

Two sections: **owner product decisions** (D-series, cannot be derived from code) and
**source-verified findings** that changed the plan.

Labels: **VERIFIED** = read from source, reference given · **UNVERIFIED** = not yet proven ·
**ASSUMPTION** = believed but untested.

---

## 1. Owner decisions (D-series)

| # | Decision | Consequence |
|---|---|---|
| D1 | Backend may be changed, additive-only preferred | New endpoints allowed; old ones stay |
| D2 | Do all 8 phases before the competition; owner will brief staff on IA changes | Menu relocations stay in scope; owner accepts retraining risk |
| D3 | **Admin = platform operator only.** Does not enter the card workspace | Remove the admin path into card pages; admin watches via the public viewer link. Removes the unbounded `/api/cards` query for admins |
| D5 | Delete Web Push entirely (frontend); redesign later | Frontend hook deleted in P0. **Backend `WebPushService` and `public/notification-sw.js` deliberately kept** — see `03_INVARIANTS.md` |
| D6 | Staff log in on shared venue machines → keep the masked password field | `FreshSecretInput` masking stays; its screen-reader leak is still a defect to fix |
| D7 | Emergency access = admin creates a new director account for themselves | No temporary-permission system. Surface account creation date in the accounts list |
| D8 | All console data may be edited concurrently | Use stale-while-revalidate: render cached data immediately, revalidate silently, repaint only on change. No refetch-on-focus |
| D9 | Individual accounts, machines rarely swapped mid-session → keep the 30-minute session, make the logout button prominent | Accepted risk: a person sitting down within 30 minutes acts under the previous user's identity in the audit log |
| D10 | Directors may view/copy the viewer link, but not open/close it | Additive change to the director console |
| D13 | **Keep per-game Max diff and per-edge pairing rule fields** | Earlier proposal to collapse them was rejected by the owner — real tournaments vary these per game |
| D14 | Terminology unification deferred until after the competition | Not in P1–P7 |
| D15 | Viewer view picker: mobile single-select, desktop multi-select; replace auto-jump with a "new ranking published — tap to view" banner | P4 |
| D16 | Move the audit log out of the sidebar into an overflow menu | P5 |
| D17 | `NEXT_PUBLIC_PUBLIC_API_ORIGIN` and `NEXT_PUBLIC_SNAPSHOT_ORIGIN` are set in production | Removes the "viewer traffic burns the Worker quota" risk. Any earlier note claiming they were unset is **stale** |
| D18 | Published results stay public indefinitely; closing the link hides live data; a published snapshot must be **retracted** separately | Matches implementation (`03_INVARIANTS.md` §4) |
| D19/D20 | PDF/Excel workflow unchanged; no print stylesheet | UI placement may change, behaviour may not |
| D21 | Sidebar keeps per-card folders; make the current card strongly prominent and collapse unused folders | P5 |
| D22 | **Final-round winner/wins/losses/total-diff stay manually entered** | Referee decisions, forfeits and withdrawals are outside the system. Do not auto-compute. A read-only "recorded games: A 2 – B 1" reference tally may be added; **do not display a computed Total diff** — the formula is unknown |

---

## 2. Source-verified findings that changed the plan

### 2.1 Mutation `204` → returned row: **REMOVED from P1** — VERIFIED

`backend/.../application/TenantService.java` — every mutating method is `@Transactional`, and most
already return a DTO:

| Returns DTO already | `void` |
|---|---|
| `createTournament` (:44), `setTournamentStatus` (:95), `assignDirector` (:116), `unassignDirector` (:126), `createDirector` (:136), `createStaff` (:172), `grantStaffTournament` (:196), `revokeStaffTournament` (:211) | `deleteTournament` (:103), `deleteDirector` (:161), `deleteStaff` (:188), `setEnabled` (:221), `resetPassword` (:229) |

Of the five `void` methods, three are deletes (returning a row is meaningless) and `resetPassword`
changes nothing visible. **Only `setEnabled` would benefit.** Not worth touching the backend.

### 2.2 `changed()` / `changedWithPublicDelta()` — VERIFIED, untouched by the plan

`backend/.../web/CardController.java:363-395`.

- Pure orchestration around `action.get()`; **not** `@Transactional`, so SSE publishes after commit —
  correct.
- `changedWithPublicDelta` has `catch (RuntimeException) → events.publishPublic(cardId, current)`
  (:389-391), i.e. it degrades to a generic bump rather than losing the update.
- `events.publish(card)` sends the **full card** on the staff stream.
  Implication for P3-B: a summary-only card in the store is upgraded to a full card automatically
  when a `state` event arrives (`use-card-sync.ts` → `applyCardState` → `replaceCard`).

### 2.3 `CardSummary` is sufficient for the back-office list — VERIFIED

`backend/.../web/dto/PublicCardDtos.java:12-25` provides: `id, tournamentId, name, division, status,
runtimeStage, currentGame, gameCount, playerCount, publishedGameCount, version, createdAt`.

`src/ui/components/stage-info.ts:22-39` (`cardStageInfo`) reads only
`playerCount ?? players.length`, `gameCount ?? games.length`, `status`, `runtimeStage`, `currentGame`
— all present. The `??` fallbacks exist precisely for the summary case.

`src/app/cards/page.tsx` and `src/ui/layout/app-shell.tsx` additionally use `id`, `tournamentId`,
`name`, `division` — all present. `stageHref` uses only `runtimeStage`.

**No missing fields for the card list or sidebar.** (`codePrefix` is absent from
`publicSummaryCard` at `store.ts:224-252`, but it is only used on the players page, which needs a
full card anyway.)

### 2.4 Spring routing: literal path beats `{cardId}` — VERIFIED by production precedent

`backend/.../web/PublicCardController.java` declares both:

- `@GetMapping("/cards/versions")` (:57)
- `@GetMapping("/cards/{cardId}")` (:64)

and `/api/public/cards/versions` is called in production by the polling fallback
(`src/application/tournament/use-public-sync.ts:226`). A literal sibling of a UUID path variable
already works in this codebase.

**However**, the security matcher issue is separate and unresolved — see `04_BLOCKERS.md` B3.

### 2.5 `maximumSessions(2)` — UNVERIFIED behaviour, VERIFIED absence of wiring

`backend/.../infrastructure/security/SecurityConfiguration.java:141-142`:

```java
.sessionManagement(session -> session
    .sessionFixation(fixation -> fixation.migrateSession())
    .maximumSessions(2))
```

Grep across `backend/src/main/java/` finds **no** `HttpSessionEventPublisher`, no custom
`SessionRegistry`, and no `maxSessionsPreventsLogin`. All defaults.

**ASSUMPTION (must be tested, not trusted):** without an `HttpSessionEventPublisher`, sessions
destroyed by timeout or logout may not be removed from the registry, so the per-user session count
could grow and a later login could expire an active session. Given D6/D9 (shared machines, repeated
logins) this must be exercised at runtime before P2 touches session handling.

### 2.6 `setActiveTournament` couples scope, dedup and the zero-origin-request invariant — VERIFIED

`src/application/tournament/store.ts:556-562`:

```ts
setActiveTournament: (tournament) => {
  publicScopeToken = tournament?.accessToken ?? null;   // module-level
  ...localStorage write/remove...
  set({ activeTournament: tournament });
}
```

- `publicScopeToken` guards the viewer bundle against being clobbered by the app-wide catalog load
  (`store.ts:390`) and decides the scoped-bundle path in `load()` (`store.ts:669`).
- `activeTournament?.published` is read by `use-public-sync.ts:103` and `:188`, which gate
  `shouldUseRealtime()` — i.e. **whether an SSE stream and a realtime-config request happen at all.**

**Constraint for P3-C:** calling `setActiveTournament({ id, name })` without `accessToken`/`published`
nulls the scope token and re-enables realtime on a published tournament. Therefore the URL-derived
scope resolution **must live in the `/cards/[id]` route page only, never inside `CardOverview`**,
which is shared with `/tour/[token]` (`src/ui/components/tournament-viewer.tsx:126`).

---

## 3. Target architecture (unchanged from review, corrected)

```
auth-store (zustand, NOT React context — see 04_BLOCKERS.md B1 rationale for request())
  └─ session · roles · CSRF token · marker cookie + sessionStorage (sole writer)

request data layer (query cache)
  └─ tournaments · accounts · archives · publish status · readiness · audit

card-store (SSE-driven)                 <-- FROZEN, see 03_INVARIANTS.md
  └─ cards: TournamentCard[]  (array kept)
  └─ summaries: PublicCardSummary[]  (new field)
  └─ applyResultPatch / applyPairingsPatch / applySnapshotPublish / replaceCard

local UI state: drafts, dialogs, column widths
URL: game · view · tab · block selector
```

`auth-store` responsibilities: session state, CSRF token storage, marker cookie + sessionStorage,
deciding a session is dead and redirecting, exposing derived role booleans.

`auth-store` **non**-responsibilities: tournament data, general API calls, resource-level permission
("can I edit this card?"), general error state, password re-authentication (that is an action of a
mutation, not a property of the session).

Boundary rule to prevent a God provider: **it answers "who are you", never "may you do this".**

### Stale-while-revalidate applicability

| Resource | SWR? | Reason |
|---|---|---|
| tournaments, accounts, archives | yes | a one-second lag is harmless |
| publish status | **no** | decision input for an irreversible action |
| shutdown readiness | **no** | decision input for an irreversible action |
| audit log | **no** | used during disputes; stale is wrong |
| card data | n/a | SSE-driven, not in the query layer |
