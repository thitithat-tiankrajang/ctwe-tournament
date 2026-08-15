# Public Snapshot — Implementation Plan

**Derived from:** [PUBLIC_SNAPSHOT_ARCHITECTURE.md](PUBLIC_SNAPSHOT_ARCHITECTURE.md) (approved).

**Status:** Phase 0, A0, A1, A2, C, B, D, E and F are **implemented**. Phases G and H are **partly
implemented** — every code-side deliverable is built, and the parts that need infrastructure
deliberately are not: Phase G's effectors (see the Phase G row) and Phase H's certifying measurements
(see the Phase H row, which explains why the instrumentation could be built without Phase I even
though the numbers cannot be taken without a CDN). Phase I is still plan only. Where this document describes an implemented phase, it is a record of what was built, not a
proposal — the normative rules those phases established are architecture §7.5 (card state is a
precondition), §7.6 (pointer vs. allocator), §7.7 (the three-state configuration policy), §7.8
(reconciliation, and why `verify` and `reconcile` are separate operations), §4.2/§4.3 "as built"
(approval authorization, the fingerprint, and why the approval record rather than the state column is
authoritative), and §4.5 "as built" (the retraction intent marker, and no-resurrection on every path
that can write the public object).

---

## 0. Ground rules applied to every phase

| # | Rule | How this plan honours it |
| --- | --- | --- |
| 1 | Preserve LIVE behaviour | No phase alters a live request path until Phase D, and Phase D is behind an env flag that is unset by default |
| 2 | No unrelated refactoring | Exactly **one** existing-code refactor is proposed (A1, a pure extraction). It is required for the equivalence invariant and is justified in §A |
| 3 | Excel export + purge stays separate | Phase 0 (naming) runs first; guardrails G1/G2 land before any snapshot code |
| 4 | PostgreSQL is source of truth | No phase adds a read path that treats R2 as authoritative |
| 5 | R2 holds derived snapshots only | Enforced by the regeneration test in Phase C |
| 6 | Publication never modifies PG tournament data | No `DELETE`/`UPDATE`/`INSERT` on tournament tables in any phase — **including forcing cards `CLOSED`**. `FINISHED`/`CLOSED` is a precondition checked before publishing (architecture §7.5). Asserted by a CI guardrail over the `…publicsnapshot` package and by before/after row digests |
| 7 | Zero-compute only after publication is proven | Phase G is gated on Phase I completing for ≥1 real event |
| 8 | Don't modify `App.tsx` | **There is no `App.tsx`** — this is Next.js App Router. The equivalents are [`src/app/layout.tsx`](../src/app/layout.tsx) and [`src/ui/layout/app-shell.tsx`](../src/ui/layout/app-shell.tsx). **No phase modifies either.** Phase D touches the store and viewer only; Phase G puts system-off messaging on specific pages, not in the shell |
| 9 | Small isolated changes | Each phase is 1–2 days of work and touches ≤ 6 files |
| 10 | Independently testable + rollbackable | Every phase below has explicit rollback; see §0.2 for the Flyway caveat |

### 0.1 Phase dependency graph

```text
  Phase 0 ──► A ──► C ──► B ──► D ──────► I ──► G
 (naming)    gen   equiv  R2    viewer   prod   zero-compute
                     │     │      ▲       ▲
                     │     └► E ──┘       │
                     │      approval      │
                     │        │           │
                     │        └► F ───────┘
                     │          retract
                     └──────────► H ──────┘
                                load test

  A and C are pure backend, no infra, no client. Both are reversible by revert.
  B introduces the first external dependency (R2).
  D is the first phase a public viewer can observe — and only when the flag is set.
  G requires I to have completed for at least one real event.
```

### 0.2 Flyway rollback caveat (applies to B, E, F, G)

Flyway is forward-only here (`spring.flyway.enabled: true`, V1→V30, no undo scripts). **"Rolling back a
migration" is not a thing.** Therefore every migration in this plan is designed so that *rolling back the
application alone is sufficient*:

- All new columns are `NULL`-able or have defaults.
- All new tables are unreferenced by existing queries.
- No existing column is altered, renamed, or dropped.
- No existing constraint is changed.

Consequence: reverting the application leaves inert, unused schema. If the schema must genuinely be
removed, that is a *new* forward migration (`V3x__drop_public_snapshot.sql`), planned deliberately —
never an emergency action.

---

## Phase 0 — Naming and guardrails (prerequisite, no feature code)

> Required first because of the near-miss recorded in the architecture doc §0 Finding B:
> `POST /api/admin/tournaments/{id}/archive` already means *permanently delete this tournament*.

| Aspect | Detail |
| --- | --- |
| **Files** | Rename `application/TournamentArchiveService.java` → `application/excelexport/TournamentExcelExportService.java`; method `archiveAndDelete` → `exportToExcelAndPurgeLiveData`; update the 3 call sites ([`AdminController:79`](../backend/src/main/java/com/ctwe/tournament/web/AdminController.java#L79), [`ArchiveController`](../backend/src/main/java/com/ctwe/tournament/web/ArchiveController.java), [`PublicArchiveController`](../backend/src/main/java/com/ctwe/tournament/web/PublicArchiveController.java)). Add `PurgeConfirmation` request record + `reauth.requireCurrentPassword`. Update Thai copy in [`admin/page.tsx:159`](../src/app/admin/page.tsx#L159) and the store's `archiveTournament` to send the password |
| **Migrations** | none |
| **API changes** | `POST /api/admin/tournaments/{id}/archive` now requires a JSON body `{ password, tournamentName }`. **Breaking for that one endpoint only** — it is admin-only and has a single caller |
| **Frontend** | `admin/page.tsx` purge dialog gains a password + type-the-name field; `store.archiveTournament(id, password, name)` |
| **Cloudflare/R2** | none |
| **GitHub Actions** | Add `backend-package-independence` check to `ci.yml` (asserts nothing yet; stays true forever) |
| **Tests** | `TournamentExcelExportServiceTest`: purge still works end-to-end; rejects a wrong password; rejects a mismatched tournament name. Package-independence test (G2) |
| **Failure cases** | Missed call site → compile error (safe). Frontend/backend deploy skew → purge returns 400 until the frontend ships; acceptable for an admin-only, rarely-used action. Sequence the backend first |
| **Rollback** | `git revert`. No schema, no infra, no data touched |
| **Acceptance** | Excel export + purge behaves identically apart from requiring re-auth; `/api/public/archives/**` and `tournament_archives` unchanged; CI package check green |

---

## Phase A — Public Snapshot generation

**Goal:** produce the snapshot payload in memory from PostgreSQL. No storage, no HTTP surface for the
public, no client change.

### A1 — Extract the public projection as a pure function *(the only refactor in this plan)*

Today the public projection lives inline inside a `@Cacheable` method
([`PublicCardReadCache.card()`](../backend/src/main/java/com/ctwe/tournament/application/PublicCardReadCache.java#L74)).
The snapshot must use the **same** projection but must **not** read Caffeine (a stale cached card would
be frozen into a permanent artifact — architecture §8 step 1).

```java
// AFTER — behaviour identical, cache semantics identical
@Cacheable(cacheNames = TournamentCaches.PUBLIC_CARD_DETAILS, key = "#cardId", sync = true)
@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
public CardDtos.CardResponse card(UUID cardId) {
    return PublicCardProjection.of(cards.get(cardId, false), version(cardId));
}
```

`PublicCardProjection.of(source, publicVersion)` is a **pure static function** — no I/O, no Spring, no
state. The snapshot builder calls the same function inside its own uncached transaction. This is what
makes the equivalence invariant structural rather than coincidental: there is one projection, not two.

### A2 — Snapshot builder + canonical serializer

| Aspect | Detail |
| --- | --- |
| **New files** | `application/publicsnapshot/PublicCardProjection.java` (pure)<br>`application/publicsnapshot/PublicSnapshotBuilder.java`<br>`application/publicsnapshot/SnapshotJson.java` (dedicated canonical `ObjectMapper`)<br>`application/publicsnapshot/dto/SnapshotEnvelope.java` |
| **Modified files** | `application/PublicCardReadCache.java` — **one method body replaced by a delegation call.** Nothing else |
| **Migrations** | **none** — Phase A persists nothing |
| **API changes** | One admin-only endpoint: `POST /api/admin/tournaments/{id}/public-snapshot/dry-run` → returns the payload JSON, uploads nothing, writes nothing |
| **Frontend** | **none** |
| **Cloudflare/R2** | **none** |
| **GitHub Actions** | none beyond existing `mvn test` |
| **Tests** | `PublicCardProjectionTest` — characterization: for a fixture card, output is byte-identical to what `PublicCardReadCache.card()` produced before the extraction (golden file captured in A0, below).<br>`SnapshotJsonDeterminismTest` — same input twice ⇒ identical `sha256`; flipping `jackson.default-property-inclusion` in a test profile does **not** change the digest (proves the dedicated mapper is isolated).<br>`PublicSnapshotBuilderTest` — `rules`/`tables`/`audit` empty, no `submittedBy`/`submittedAt`, no `accessToken`, `finalRound` gating matches the live projection.<br>Extend `RestoreAndPairResultIntegrationTest` fixture usage: multi-card tournament with byes, penalties, terminate/restore, Gibsonization, final round |
| **Failure cases** | Extraction changes ordering ⇒ caught by the A0 golden file. Builder reads Caffeine by mistake ⇒ caught by a test that mutates a card, does *not* evict, and asserts the snapshot reflects the DB not the cache. Large tournament OOM on 512 MB ⇒ builder streams per card and asserts a size ceiling |
| **Rollback** | `git revert`. Two new packages disappear; `PublicCardReadCache.card()` returns to its inline body. No schema, no infra, no client, no data |
| **Acceptance** | ① Golden file proves the projection is byte-identical pre/post extraction. ② `dry-run` on a real finished tournament returns valid JSON. ③ Determinism test green. ④ Full existing backend suite green. ⑤ **Zero diff in any public HTTP response** |

---

## Phase C — Snapshot validation / equivalence testing

> Sequenced **before** Phase B deliberately: prove the artifact is right before building the machinery
> that publishes it. Publishing a wrong snapshot is the expensive mistake.

| Aspect | Detail |
| --- | --- |
| **New files** | `application/publicsnapshot/PublicSnapshotValidator.java`<br>`backend/src/test/.../publicsnapshot/SnapshotLiveEquivalenceTest.java` ← **the load-bearing test of the whole project** |
| **Modified files** | none |
| **Migrations** | none |
| **API changes** | `dry-run` response gains a `validation` block (`{ ok, checks[], bytes, checksum }`) |
| **Frontend** | none |
| **Cloudflare/R2** | none |
| **GitHub Actions** | `SnapshotLiveEquivalenceTest` runs in the existing `backend` CI job — it must be a **blocking** check |
| **Tests** | **Equivalence:** boot the app, seed a fixture tournament, call `GET /api/public/tournaments/{token}/bundle`, build the snapshot, assert `snapshot.payload` deep-equals the live body **modulo the omitted `accessToken`**.<br>**Validation rejections** (each must fail closed): card count ≠ DB; a card not `FINISHED`/`CLOSED`; per-card player count ≠ DB; a foreign `tournament_id`; any `accessToken`; non-empty `rules`/`tables`/`audit`; `submittedBy` present; payload > 8 MB; unsupported `schema`.<br>**Non-destructive proof:** snapshot every table's row count and a content digest before and after a build; assert unchanged (Rule 6) |
| **Failure cases** | Fixture too thin to catch drift ⇒ the fixture must include bye, penalty, draw, terminated+restored player, Gibsonized player, and a final round. Equivalence passes locally but not against real data ⇒ Phase I §I1 re-runs it against a production clone |
| **Rollback** | `git revert`. Test-only + one new validator class |
| **Acceptance** | ① Equivalence test green in CI. ② Every rejection case fails closed with a specific message. ③ Non-destructive proof green. ④ A deliberately introduced field in `CardDtos.CardResponse` makes the equivalence test **fail** (proves the guard actually guards) |

---

## Phase B — R2 publication

**Goal:** get a verified snapshot onto the public CDN. Still invisible to viewers (Phase D wires the client).

| Aspect | Detail |
| --- | --- |
| **New files** | `infrastructure/storage/SnapshotObjectStore.java` + `R2SnapshotObjectStore` (the only classes reading R2 credentials)<br>`application/publicsnapshot/PublicSnapshotPublisher.reconcile` — the §7.8 reconciler; `verify` stays a pure read beside it<br>`infrastructure/storage/PublicSnapshotFetcher.java` + `HttpPublicSnapshotFetcher` — read-back **through the public hostname**, deliberately separate from the S3 port (an S3 read proves the write, not the reachability)<br>`infrastructure/storage/SnapshotStorageProperties.java` — owns the three-state configuration policy (§7.7)<br>`infrastructure/storage/UnconfiguredSnapshotStorage.java` — the ABSENT stand-ins<br>`infrastructure/cdn/CachePurgeClient.java`<br>`application/publicsnapshot/PublicSnapshotPublisher.java` (pipeline §7.2)<br>`application/publicsnapshot/PublicSnapshotState.java` — all DB bookkeeping, kept out of the publisher so no row lock is held across the network<br>`web/PublicSnapshotController.java` (admin)<br>`application/publicsnapshot/SnapshotKey.java` (the SHA-256 derivation + the §3.5 caveat in its Javadoc) |
| **Modified files** | `backend/pom.xml` — add `software.amazon.awssdk:s3`, **excluding `apache-client` in favour of `url-connection-client`** (smaller, faster boot; matters for Phase G resume time and the 512 MB budget)<br>`application.yml`, `render.yaml` — R2 + purge env (`sync: false`) |
| **Migrations** | **V31** — `tournaments.snapshot_state VARCHAR(16) NOT NULL DEFAULT 'NOT_PUBLISHED'` (CHECK over all six lifecycle values, so Phases E and F need no further migration), `snapshot_version BIGINT NOT NULL DEFAULT 0`, `published_at TIMESTAMPTZ NULL`, `snapshot_checksum VARCHAR(71) NULL` (the checksum is stored in the same `sha256-…` form the artifact and envelope carry, so all three compare without reformatting); new table `public_snapshot_publications`. **Additive only**; no existing object altered |
| **API changes** | `POST …/public-snapshot/publish` (ADMIN), `GET …/public-snapshot/status`, `GET …/public-snapshot/dry-run`, `POST …/public-snapshot/rollback`, `POST …/public-snapshot/verify`, `POST …/public-snapshot/reconcile`. All under `/api/admin/**`, already `hasRole("ADMIN")`. **`verify` and `reconcile` are deliberately separate** (architecture §7.8): `verify` detects and writes nothing, `reconcile` converges |
| **Frontend** | **none** in this phase (admin UI lands in Phase E with the approval flow) |
| **Cloudflare/R2** | **Not provisioned by this repository — an operations task, listed here so it is done deliberately.** Create **two** buckets: `ctwe-snapshots` (private, S3 API only) and `ctwe-snapshots-public` (custom domain `snapshot.ct-we.com`). CORS for `GET`/`HEAD` from the site origins, expose `ETag`. Cache Rules: cache `404` on `/s/*` at edge (~60 s); long `s-maxage` on 200s; **the cache key must keep the query string on `/s/*`** so the `?verify=` read-back misses the edge (Cloudflare's default — a constraint on future rules). Transform Rule → Modify Response Header adding `X-Robots-Tag: noindex` for `/s/*.staging-*.json`, which `PutObject` cannot set itself. Both are explained in architecture §7.4. Scoped R2 token; scoped Cloudflare cache-purge token |
| **GitHub Actions** | none |
| **Tests** | `PublicSnapshotPublisherTest` with a fake store — inject failure at each pipeline step; assert the previous public version survives every one. Plus the **reconciler** (§7.8): completes the commit for a promoted-but-uncommitted object without uploading anything; is idempotent (repeat runs write nothing); refuses to commit onto bytes no recorded checksum matches; restores the pointer's version from private history rather than rebuilding; never re-creates an absent object; refuses a `RETRACTED` tournament; reports *inconclusive* instead of acting on an unreachable read.<br>`SnapshotKeyTest` — fixture vectors incl. legacy 32-hex tokens and a 64-char slug, shared verbatim with the TypeScript suite.<br>`SnapshotStorageConfigurationTest` — the §7.7 policy: ABSENT disables, COMPLETE enables, and **every** PARTIAL shape fails fast (missing credential, missing bucket, missing/`http` public origin, public origin alone, lone Cloudflare value, half a purge pair, scheme-less URL).<br>`PublicSnapshotPublicationDatabaseTest` — the state machine against real SQL, plus the §7.5 invariant: card rows digested before and after both a rejected and a successful publish; and the reconciler's SQL: the completed commit and its audit row, idempotence over the real row, an unstuck `PUBLISHING`, a restore, an absent object, and a refused `RETRACTED`.<br>Guardrail: no source file under `…publicsnapshot` writes to any tournament data table.<br>`SnapshotObjectStoreIT` — against a real R2 staging bucket (manual/nightly, not on every PR).<br>Concurrency: two simultaneous publishes for one tournament ⇒ row lock serializes; `n` increments once |
| **Failure cases** | Every row of architecture §7.3. Additionally: AWS SDK inflates boot time ⇒ measure and record boot delta as an acceptance criterion (feeds Phase G). **Configuration follows the three-state policy of architecture §7.7** — ABSENT disables publication and leaves everything else untouched (this is the normal state for local development and CI); PARTIAL **fails startup** with a message naming the missing/invalid keys; COMPLETE enables publication. A partial configuration is never silently downgraded to disabled |
| **Rollback** | ① Revert the app (schema stays inert per §0.2). ② Delete objects from both buckets. ③ Leave the buckets provisioned — costless. No viewer is affected in any case, because nothing reads these objects yet |
| **Acceptance** | ① A published snapshot is fetchable at `https://snapshot.ct-we.com/s/{h}.json` and checksum-verifies. ② Rollback to `v{n-1}` works and is observed within the purge window. ③ Killing the process between steps 6 and 9 converges via the reconciler (§7.8) — and a stuck `PUBLISHING` converges too, from evidence rather than a timeout. ④ **Zero change to any live viewer request.** ⑤ Recorded: Spring Boot boot-time delta and heap delta from the SDK. ⑥ **Publication mutates no tournament data** — a rejected publish leaves every card row and the publication state untouched, and a successful publish does too (§7.5). ⑦ **The three-state configuration policy holds** (§7.7): the application boots and serves every live feature with no snapshot configuration at all, and refuses to boot on a partial one |

### B.1 — Acceptance ⑤: the AWS SDK's cost, measured

Recorded once so Phase G can plan resume time against a number rather than a guess. Method: the
packaged application, exploded and started from a plain classpath, three boots per configuration,
`-XX:+UseSerialGC -Xmx512m`, Flyway off, against the local PostgreSQL. "Heap + metaspace" is read
after a forced GC; the class count comes from `jcmd GC.class_histogram`.

| Configuration | Boot (3 runs) | Heap + metaspace | Metaspace | `software.amazon.*` classes loaded |
| --- | --- | --- | --- | --- |
| SDK **absent from the classpath** (baseline) | 5.10 / 5.45 / 5.60 s | ~132.9 MB | 79.7 MB | 0 |
| SDK present, snapshot config **ABSENT** | 5.30 / 5.54 / 5.64 s | ~133.6 MB | 79.7 MB | **0** |
| SDK present, snapshot config **COMPLETE** | 5.54 / 5.56 / 6.80 s | ~143.2 MB | 85.9 MB | 640 |

Readings:

- **Boot-time delta from merely carrying the SDK: none measurable.** The spread between the fastest
  and slowest run *within* a configuration (~0.3 s, and one 6.8 s outlier) is larger than the
  difference between configurations. Nothing is eagerly initialised by the dependency alone.
- **Heap delta when publication is disabled: ~0.7 MB**, and metaspace is identical to the baseline —
  because **not one SDK class is loaded**. `SnapshotStorageConfiguration` returns
  `UnconfiguredSnapshotStorage` in the ABSENT case, so `S3Client.builder()` is never reached. This is
  the configuration local development, CI, and any deployment that has not enabled publication run in.
- **Enabling publication costs ~9.6 MB of heap + metaspace** (640 classes), paid once at startup when
  the `S3Client` is built. Against the 512 MB budget that is ~2%.
- **Deploy artifact: +7.9 MB** across 29 jars (`s3` plus transitives, with `apache-client` and
  `netty-nio-client` excluded in favour of `url-connection-client`).

---

## Phase D — Public viewer integration

**Goal:** the viewer resolves published tournaments from the CDN. **First phase a viewer can observe —
and only when `NEXT_PUBLIC_SNAPSHOT_ORIGIN` is set.**

| Aspect | Detail |
| --- | --- |
| **New files** | `src/infrastructure/http/snapshot-api.ts` — `SNAPSHOT_ORIGIN`, `snapshotKey(token)` (Web Crypto), `snapshotUrl(token)`, `fetchSnapshotBundle(token)`, session memo<br>`src/ui/components/snapshot-preconnect.tsx` — the `<link rel="preconnect">` for both viewer routes; renders nothing when the flag is unset, so the document stays byte-identical to today |
| **Modified files** | `src/application/tournament/store.ts` — `loadBundle()` gains the static-first probe and envelope unwrap. **Hook into `loadBundle`, not `enterPublicTournament`**, so the existing in-flight dedupe (`bundleInflight`) and the app-wide `load()` path both benefit. `published` lands on `ActiveTournament` (the store's own type) rather than on `TournamentCard`.<br>`src/application/tournament/use-public-sync.ts` — no-op when published, checked inside both hooks so no call site can reintroduce origin traffic by forgetting.<br>`src/application/tournament/use-realtime-config.ts` — gains an `enabled` parameter. **Required for the zero-origin-request guarantee:** this hook fetches `/api/public/realtime-config` from Render unconditionally, which would otherwise put one origin request straight back on the published path.<br>`src/ui/components/tournament-viewer.tsx` — published description; distinguish published-404 from dead-link.<br>`src/app/tour/[token]/page.tsx`, `src/app/t/[token]/page.tsx` — mount the preconnect. Both routes resolve snapshots from the **access token**, never the URL shape, so the legacy link is not a special case.<br>`next.config.ts` — CSP `connect-src` += snapshot origin |
| **NOT modified** | `src/app/layout.tsx`, `src/ui/layout/app-shell.tsx`, `card-overview.tsx`, `data-grid.tsx`, `standings-grids.tsx`, `final-round-board.tsx`, `history.ts`, `tournament-pdfs.ts`, `tournament-sheets.ts` (Rule 8). Also **not** `use-push-notifications.ts`: the earlier sketch listed it, but `usePushNotifications` has no callers anywhere in the app, so it never runs on the viewer path and there is nothing to gate. Also **no Worker change at all** — `wrangler.jsonc` and `open-next.config.ts` are untouched, which is the strongest form of architecture §2.2's rejection of Option C |
| **Migrations** | none |
| **API changes** | none — the public API is untouched (architecture D1) |
| **Cloudflare/R2** | Set `NEXT_PUBLIC_SNAPSHOT_ORIGIN` as a **build variable** in the Worker build config (same pattern as `NEXT_PUBLIC_PUBLIC_API_ORIGIN`). Add `<link rel="preconnect">` to the snapshot origin on the `/tour/[token]` route |
| **GitHub Actions** | none |
| **Tests** | Store units: probe 200 ⇒ hydrate from `.payload`, **assert no live fetch was issued**; 404 ⇒ exact live path; network error ⇒ live path; timeout (1.2 s) ⇒ live path; malformed/unsupported schema ⇒ live path.<br>`use-public-sync`: no `EventSource`, no polling timer when published.<br>Key parity: the TS `snapshotKey` matches the Java `SnapshotKey` on shared fixture vectors — **CI-blocking on both sides**; a mismatch silently makes every snapshot unreachable.<br>Render an archived bundle through `CardOverview` and diff the DOM against the live-bundle render |
| **Failure cases** | CSP blocks the fetch ⇒ caught in preview; the fetch failure falls through to live, so the worst case is today's behaviour. Probe adds latency ⇒ Phase H measures it. Web Crypto unavailable (non-HTTPS) ⇒ local dev leaves the origin unset, so the probe never runs |
| **Rollback** | **Unset `NEXT_PUBLIC_SNAPSHOT_ORIGIN` and redeploy the Worker.** No backend change, no data change, no R2 change. The probe code short-circuits and every viewer is back on the live path |
| **Acceptance** | ① With the flag unset, network traces are byte-identical to today. ② With it set, a published tournament renders identically and issues **zero** Render requests — including no `realtime-config` call and no SSE. ③ A live tournament's Render request sequence is unchanged, and the probe response IS the data on the published path (never a probe plus a fetch). ④ Key parity green on both sides. ⑤ Refresh on a published tournament is served from cache. ⑥ Every failure mode — 404, timeout, network error, malformed body, unsupported schema, no Web Crypto — falls through to the live path rather than throwing |

---

## Phase E — Publication approval

| Aspect | Detail |
| --- | --- |
| **New files** | `application/publicsnapshot/SnapshotApprovalService.java`; `web/dto/PublicSnapshotDtos.java`; `src/ui/components/snapshot-acknowledgment.tsx` (the §4.4 text + its revision constant); `src/ui/components/snapshot-publication-panel.tsx` |
| **Modified files** | `application/publicsnapshot/PublicSnapshotState.java` — `beginPublishing` calls the approval gate, **inside the row lock it already holds**.<br>`web/PublicSnapshotController.java` — `approve`/`revoke` endpoints; `publish` gains the §4.2 authorization check.<br>`src/application/tournament/store.ts` + `src/domain/tournament/types.ts` — approval calls and their types.<br>`src/app/admin/page.tsx` — approval dialog + the per-row panel.<br>**Not** `src/app/director/page.tsx` — see the O1 decision below |
| **Migrations** | **V32** — `public_snapshot_approvals` (tournament_id, approved_by, approved_at, acknowledgment_rev, content_fingerprint, expires_at, **revoked_at, revoked_by**). Additive; the two revocation columns are a documented extension (architecture §4.3 "as built") |
| **API changes** | `POST …/public-snapshot/approve` `{ password, tournamentName, acknowledgmentRev }`; `DELETE …/public-snapshot/approve`. Both return the full status. Authorization: ADMIN or a DIRECTOR assigned to that tournament, **enforced in the service**; the routes stay under `/api/admin/**` pending O1 |
| **Frontend** | Per-tournament panel showing publication state, approval validity and its reason. The bilingual acknowledgment (§4.4) is rendered in the row above the approve button — not buried in the modal — and the dialog adds password re-auth + type-the-name, reusing the existing `PromptDialog`. Rows show both badges (link OPEN/CLOSED **and** published state). Status is fetched per row on demand, never for every row on mount |
| **Cloudflare/R2** | none |
| **GitHub Actions** | none |
| **Tests** | `SnapshotApprovalDatabaseTest` (real PostgreSQL, 32 cases). Publish rejected: no approval; revoked; expired; **fingerprint changed after approval**; a card added after approval; another tournament's approval. Authorization matrix per §4.2 including staff rejection and the director-vs-director isolation case, paired with its positive so neither is vacuous. Acknowledgment revision recorded and stale revisions refused. Audit rows asserted by action name and actor. Refused approvals leave no row, no audit entry and no data change. Cross-language revision parity (`snapshot-acknowledgment.test.ts`) |
| **Failure cases** | Fingerprint too coarse/fine ⇒ derived from `(cardId, public_version)` pairs, which already change exactly when public data changes (V14). Approver leaves the organization ⇒ approval remains valid until expiry; recorded by username. Consent text edited without bumping the revision ⇒ caught by the parity test, and at runtime every approval would 409 rather than record consent to unseen wording |
| **Rollback** | Revert the app; V32's table becomes inert. If snapshots were already published in Phase B/D, they keep serving — approval gates *new* publications only |
| **Acceptance** | ① **Met** — publication is impossible without a valid, unexpired, unrevoked, fingerprint-matching approval; the gate lives in `beginPublishing` under the row lock, and removing it fails five tests. ② **Met** — the acknowledgment is rendered before approval and its revision is stored on the row and asserted in SQL. ③ **Met** — a director assigned to another tournament is refused with 403, while a director of *this* tournament succeeds |

### E.1 — The O1 decision, recorded

Architecture §4.2 grants approve/publish to an ADMIN **or** a DIRECTOR of that tournament, but §11 O1
left "director or admin-only?" explicitly undecided, and Phase B had already mounted the controller
under `/api/admin/**`. Rather than guess, Phase E splits the question:

- **The rule is implemented and tested** in `SnapshotApprovalService` — role (ADMIN or DIRECTOR, never
  STAFF) *and* tenant scope, via the shared `AuthorizationService`.
- **The exposed surface is unchanged**: the routes remain ADMIN-only by URL.

So no new access was granted while O1 is open, and granting it later is one `requestMatchers` line plus
director UI. `src/app/director/page.tsx` is therefore untouched, and acceptance ③ is still proven
non-vacuously, at the layer where the rule actually lives.

---

## Phase F — Retraction

| Aspect | Detail |
| --- | --- |
| **New files** | none in production (`retract` added to `PublicSnapshotPublisher`, retraction bookkeeping to `PublicSnapshotState`); `SnapshotRetractionDatabaseTest` |
| **Modified files** | `web/PublicSnapshotController.java` (+`retract`); `application/publicsnapshot/PublicSnapshotPublisher.java` (retract, the no-resurrection guard applied to **rollback** and reconcile, the reconciler's retraction branch); `application/publicsnapshot/PublicSnapshotState.java` (intent/commit/query + the pending-retraction publish guard); `infrastructure/security/AuthorizationService.java` (`requireTournamentOperator`, the §4.2 rule expressed once and reused by approve/revoke/publish/retract); `src/app/admin/page.tsx`, `src/ui/components/snapshot-publication-panel.tsx`, `src/ui/components/prompt-dialog.tsx` (optional second confirm action), `store.ts` |
| **Migrations** | **V33** — `tournaments.retracted_by VARCHAR(64) NULL`, `retracted_at TIMESTAMPTZ NULL`. Additive. `retracted_at` is written as **intent, before the delete** (architecture §4.5 "as built") |
| **API changes** | `POST …/public-snapshot/retract`. **Authorization deliberately wider than publish:** any ADMIN, or any DIRECTOR of that tournament, **no approval record, no re-auth, no typed confirmation**. Routes stay under `/api/admin/**` pending O1 |
| **Frontend** | Retract action on the row's snapshot panel (`secondary`, never `danger` — G5 reserves that for the Excel purge, and I9 says withdrawal must be easy). The close-tournament dialog gains §4.6's exact warning and a one-click **"ปิดลิงก์และถอนการเผยแพร่"** beside "ปิดลิงก์อย่างเดียว", via a new optional `secondaryConfirmLabel` on the shared `PromptDialog` |
| **Cloudflare/R2** | none beyond the purge already built in Phase B |
| **GitHub Actions** | none |
| **Tests** | `SnapshotRetractionDatabaseTest` (real PostgreSQL, 23 cases): the object is deleted, purged and verified 404; a stale edge does not block the withdrawal; **no-resurrection on publish, rollback, reconcile and approve**; private history survives; retracting A leaves B byte-identical; idempotency; a refused delete rewinds the intent; the reconciler finishes an interrupted retraction and refuses to delete on its own initiative; a pending retraction blocks publish; retraction mutates no tournament data; G1 blocks the Excel purge while published and allows it after retraction; audit rows by action and actor. The client's 404 fall-through is already covered by Phase D's `snapshot-resolution.test.ts` |
| **Failure cases** | Purge fails ⇒ staleness bounded by `max-age=300`; the outcome says so; retry. Delete refused ⇒ intent rewound, nothing changed, retryable. Delete succeeds but the commit fails ⇒ the reconciler observes the intent plus a 404 and completes the transition, keeping the original actor's attribution |
| **Rollback** | Revert the app; the retract endpoint disappears. **Emergency retraction always remains possible by deleting the object in the Cloudflare/R2 dashboard** — the design never depends solely on application code for withdrawal |
| **Acceptance** | ① **Met** — one `DeleteObject` removes the whole public surface (§7.1), asserted on the object map. ② **Met** — the 404 is verified through the public hostname, cache-busted, and reported honestly when an edge still answers. ③ **Met** — enforced on publish, rollback, reconcile *and* approve; disabling the guard fails two tests. ④ **Met** — a neighbouring tournament's object, state and retraction columns are asserted untouched |

---

## Phase H — Load testing

> **Status: instrumentation built; certifying measurements blocked on infrastructure.** Phase H is
> upstream of Phase I in the §0.1 graph — ④ is a hard gate *on* Phase I, not a consequence of it — so
> the harness needed no production rollout to build. What it does need is a target: measurements ②–④
> describe traffic against a Cloudflare-fronted snapshot bucket that this repository does not
> provision. See "Gate and split" below.

| Aspect | Detail |
| --- | --- |
| **New files** | **Built:** `load-testing/scenarios/snapshot-viewer.ts` (the static-first viewer, including its fail-open fallback); `load-testing/lib/snapshot-key.ts` (the object key, pinned to the same fixture vectors as `SnapshotKey.java` and `snapshot-api.test.ts`); `load-testing/lib/snapshot-probe.ts`; `load-testing/lib/request-ledger.ts` (per-fleet destination accounting); `load-testing/scripts/simulate-stack.ts` (stub-stack self-test) |
| **Modified files** | `load-testing/config.ts` (fleet modes, published/live token lists, probe settings, the §2.5 thresholds), `load-testing/lib/evaluate.ts` (the ② and ④ criteria), `load-testing/lib/metrics-hub.ts` (probe outcomes, per-fleet origin/SSE counters, `cf-cache-status` tallies, time-to-first-data), `load-testing/scripts/metrics-collector.ts` (Caffeine hit/miss for ③), `load-testing/scripts/orchestrator.ts` (mixed-fleet ramp + snapshot preflight), `load-testing/runbook-generator.ts` (the Phase H section), `load-testing/README.md`, root `package.json` (the new tests join `npm test`). **Nine files rather than ground rule 9's six** — all inside `load-testing/`, none on any request path, and the extra three are what makes ② a measurement rather than an assertion |
| **Migrations / API / Cloudflare / Actions** | none |
| **Tests / measurements** | ① **Baseline:** live tournament, today's numbers. ② **Published:** same load, assert **zero** Render requests and **zero** SSE connections. ③ **Mixed fleet** (2 live + 2 published): assert the live cards' Caffeine hit ratio improves and live p95 does not regress. ④ **Probe cost:** live-path p95-to-first-data delta ≤ 25 ms; `cf-cache-status: HIT` on 404 probes at steady state |
| **Failure cases** | Probe regresses live p95 ⇒ **do not proceed to Phase I**; the documented fallback is Worker routing (architecture §2.2 option C), which reuses the identical client change and only moves the signal's source. 404s not edge-cached ⇒ fix the Cache Rule before rollout |
| **Rollback** | N/A (measurement only). Must respect the existing safe-test procedure: `CONFIRM_PRODUCTION_LOAD`, `LOAD_TEST_MODE` off afterwards |
| **Acceptance** | ① **Instrumented, unrecorded** — a run with `SNAPSHOT_ORIGIN` unset is the baseline by construction; no staging run exists. ② **Instrumented and proven non-vacuous locally, unrecorded against a real CDN.** ③ **Instrumented, unrecorded** — needs Actuator metrics and two deployments' worth of tournaments. ④ **④a instrumented; ④b requires a Cloudflare edge and is unmeasurable without one.** No run has been performed against staging, so `load-testing/reports/runbook.md` still holds the 2026-07-06 SSE capacity run and none of the four are recorded as production evidence |

### H.1 — Gate and split: what was built, and why the measurements were not taken

**What the code does.** The four measurements are fully instrumented and their verdicts are computed,
reported and unit-tested. Three design choices matter more than the plumbing:

- **Origin traffic is counted, not assumed.** Every request a scenario makes goes through one counted
  client (`lib/request-ledger.ts`) that classifies it by URL origin and attributes it to the fleet
  that issued it. The published viewer reproduces the client's fail-open fallback faithfully, so a
  tournament that is not actually published produces origin requests, and ② fails. "Zero Render
  requests" is therefore an observation, never a property of the harness declining to make requests.
- **A fleet that resolved no snapshot fails rather than passes.** Zero origin traffic from viewers
  that never reached the CDN is the most plausible false PASS available, so it is an explicit breach —
  and the orchestrator refuses to start at all when a `PUBLISHED_TOKENS` entry does not resolve.
- **`NOT MEASURED` is a first-class verdict.** An absent `cf-cache-status` header is never folded
  into HIT or MISS, and a local or metrics-incomplete run cannot report the Phase I gate as satisfied
  no matter how green its criteria are.
- **④ is measured as §2.5 states it, not as a convenient proxy.** ④a is the *delta* in live
  p95-to-first-data between a probe-on run and a probe-off baseline; the probe's own p95 is reported
  beside it as a single-run bound, and both must hold. A baseline that itself probed is refused as a
  control. ④b is judged *at steady state*: the first lookup of a key populates the edge's negative
  cache and is expected to MISS, so cold first-lookups are excluded from the ratio and reported
  separately — and a run where every key was probed exactly once is `NOT MEASURED`, not a 0% hit
  rate.

**What blocks the numbers.** ②, ③ and ④ describe a fleet loading `snapshot.ct-we.com`. That host, its
two R2 buckets, its Cache Rules and the published objects behind them are an operations task the
Phase B row already records as *"not provisioned by this repository"*, and provisioning them is out of
scope here. ④b is the sharpest case: `cf-cache-status` is emitted by Cloudflare, so with no edge in
front of the bucket the measurement has no evidence to read — which the report states rather than
approximates. ③ additionally needs `LOADTEST_ADMIN_USER`/`PASS` against a deployment for the Caffeine
counters.

| Measurement | Instrumented | Recorded as production evidence | Blocker |
| --- | --- | --- | --- |
| ① baseline | yes | no | needs a staging deployment; the harness change is a superset of the pre-Phase-H behaviour |
| ② zero Render / zero SSE | yes, proven non-vacuous against stub hosts | no | needs published snapshots on a real CDN |
| ③ mixed fleet | yes | no | needs a deployment with Actuator credentials and four tournaments |
| ④a first-data delta | yes, paired against a probe-off baseline | no | needs two runs over a real network path; a local stub's 2 ms is meaningless |
| ④b edge-cached 404s | yes, steady-state only, and honestly refuses to guess | no | **needs Cloudflare.** No edge, no evidence |

Nothing here can publish, purge, deploy, or reach production: the harness holds no credentials and
sends traffic only to hosts it is explicitly pointed at, behind the existing `CONFIRM_PRODUCTION_LOAD`
guard, which now covers the CDN host as well.

---

## Phase I — Production rollout

| Aspect | Detail |
| --- | --- |
| **Files** | none (configuration + operations) |
| **Migrations** | none |
| **API/Frontend/Actions** | none |
| **Cloudflare/R2** | Set `NEXT_PUBLIC_SNAPSHOT_ORIGIN` in the Worker **build** variables; redeploy |
| **Steps** | **I1** Re-run the Phase C equivalence test against a production clone (Neon branch).<br>**I2** Obtain organizer/legal sign-off on permanent publication of athlete names + schools (architecture R3) — **blocking**.<br>**I3** Publish **one canary** tournament; verify by hand; leave the client flag **off** for 24 h.<br>**I4** Enable the flag in preview; verify; enable in production.<br>**I5** Backfill remaining finished tournaments **oldest-first, one at a time**, verifying each.<br>**I6** Monitor Render request rate, Caffeine hit ratio, SSE counts, Neon compute for one week |
| **Failure cases** | A backfilled tournament renders wrongly ⇒ retract that one (others unaffected, I10). Load rises unexpectedly ⇒ unset the flag. Organizer objects post-publication ⇒ retract (Phase F) |
| **Rollback** | **Unset one build variable and redeploy.** Snapshots keep existing in R2, harmlessly unread |
| **Acceptance** | ① Measured drop in Render/Neon load. ② No viewer-visible change for live tournaments. ③ Every published tournament verified. ④ One week with no snapshot-related incident |

---

## Phase G — Zero-compute backend lifecycle

> **Gated on Phase I completing for at least one real event** (Rule 7). Suspending the backend before
> finished tournaments are reliably published would take historical results offline.

| Aspect | Detail |
| --- | --- |
| **New files** | **Built:** `web/SystemController.java`; `application/systemlifecycle/ShutdownReadinessService.java`; `src/app/system/page.tsx`; `src/infrastructure/http/system-state.ts`; `src/ui/components/system-off-panel.tsx`; `src/ui/components/shutdown-readiness-panel.tsx`.<br>**NOT built — infrastructure:** `.github/workflows/backend-lifecycle.yml`. See "Gate and split" below |
| **Modified files** | `src/app/staff-login/page.tsx` — system-off panel<br>`src/app/page.tsx` — system-off panel<br>`src/ui/components/tournament-viewer.tsx` — "system off" vs "link dead"<br>`src/application/tournament/store.ts` — treat a 503 from `/api/auth/me` as *system off*, not *session expired*<br>`src/app/admin/page.tsx` — "Shutdown readiness" panel<br>**Not** `app-shell.tsx` or `layout.tsx` (Rule 8) |
| **Migrations** | **V34** — `tournaments.shelved_at TIMESTAMPTZ NULL` plus `shelved_by VARCHAR(64) NULL` (the same attribution V33 records for retraction). Additive |
| **API changes** | `GET /api/admin/system/shutdown-readiness` → `{ activeTournamentCount, unpublishedFinished[], publishedSnapshots[{tournamentId,name,h,version,sha}], shelved[], readyToStop }`, `no-store`; `POST …/system/tournaments/{id}/shelve` (password re-auth) and `DELETE` the same path to undo it. ADMIN-only by the existing `/api/admin/**` rule; O1 untouched |
| **Tests** | `ShutdownReadinessDatabaseTest` (real PostgreSQL, 18 cases) — §19.1's count including its belt-and-braces clause, RETRACTED/PUBLISH_FAILED blocking, shelving and unshelving, idempotency and attribution, cross-tournament isolation, and proof that neither reading nor shelving touches card/game data or the snapshot columns. `system-state.test.ts` (10 cases) — every unreadable-file path fails toward available. `session-guard.test.ts` — a 503 is system-off, not an expired session |
| **Cloudflare/R2** | `system/state.json` in the public bucket (`system/` prefix — separate from `s/`, so retraction semantics are unaffected); `max-age=30`, purged on write |
| **GitHub Actions** | Secrets: `RENDER_API_KEY`, `RENDER_SERVICE_ID`, R2 write creds **scoped to `system/` if the account supports prefix scoping**, `CF_PURGE_TOKEN`. Daily `reconcile` schedule (catches a forgotten resume silently billing) |
| **Tests** | Start: 5 cold starts pass the readiness gate; a deliberately broken `STAFF_PASSWORD_HASH` fails safely and **leaves the service suspended**. Stop **aborts** for (a) an active tournament, (b) a finished-but-unpublished tournament, (c) a snapshot URL returning 404. Concurrency: two dispatches serialize. With the backend suspended, every route behaves per architecture §20 |
| **Failure cases** | All ten in architecture §23. Sub-phase Z3 must also confirm the Neon-wake mitigation (§22.2a) — Hikari `connection-timeout: 5000` with `MIN_IDLE: 0` against a scaled-to-zero Neon is a first-boot certainty once stop/start is routine |
| **Rollback** | Resume the service from the **Render dashboard** (always available, no code path). Revert the app for the UI changes. Delete `system/state.json` — the UI fails toward the login form (Z8) |
| **Sub-phases** | **Z1** observe-only reconcile → **Z2** messaging → **Z3** start workflow → **Z4** stop workflow → **Z5** operationalize + full dry run 48 h before a real event |
| **Acceptance** | ① **Not verifiable yet** — needs Phase I and a real origin blackhole (Z0). ② **Backend half met**: the gate reports all three abort conditions and is proven to keep the gate shut for each; the workflow that enforces them is not built. ③ **Not built** — the start workflow is an infrastructure effector. ④ **Not met** — no runbook, no workflows to run |

### G.1 — Gate and split: what was built, and why the rest was not

Two independent things stop Phase G from being finished here, and neither is a code problem.

**The architecture gates it.** Ground rule 7 and Z0 both require Part I Phase 5 — this plan's Phase I —
to have completed for at least one real event, with the gate *"a published tournament renders with
Render deliberately unreachable"*. Phase I is not implemented, needs production rollout, and is itself
blocked on R3 (organizer/legal sign-off). Switching the backend off before published snapshots are
proven in production would take historical results offline, which is exactly what rule 7 exists to
prevent.

**The effectors are infrastructure.** Z3, Z4's workflow and Z5 are GitHub Actions holding
`RENDER_API_KEY`, `RENDER_SERVICE_ID`, R2 write credentials and `CF_PURGE_TOKEN`, plus a
`system/state.json` object in the public bucket. Provisioning or deploying any of that is out of scope.

So Phase G was split along that line:

| Sub-phase | Status |
| --- | --- |
| **Z1** observe | **Partly built.** `/system` page and the `system/state.json` schema + reader are in the repo. The reconcile-only Action is not |
| **Z2** messaging | **Built in full.** Login page, landing page, viewer "system off" vs "link dead", `/api/auth/me` 503 handling — all fail-toward-available (Z8) |
| **Z3** start workflow | **Not built** — infrastructure effector |
| **Z4** stop workflow | **Backend built:** V34, `GET …/shutdown-readiness`, shelve/unshelve, and the admin console panel. The workflow that consumes them, and §19.3's external verification, are not |
| **Z5** operationalize | **Not built** — daily Action, runbook, and the pre-event dry run |

**Nothing built here can switch anything off.** The application deliberately holds no Render
credentials and no effector: `ShutdownReadinessService` answers a question and cannot act on the
answer (§17.1), which is why this code is safe to land while rule 7's gate is still closed.

---

## Recommended first implementation: **Phase A, step A1**

**A0 (prerequisite, test-only, zero production code):** capture a golden file of
`PublicCardReadCache.card()` output for a rich fixture tournament, plus the current
`GET /api/public/tournaments/{token}/bundle` body. Commit them as test resources. This adds no
production code at all and establishes the baseline that every later phase is measured against.

**A1 (safest production change):** extract `PublicCardProjection.of(source, publicVersion)` as a pure
static function and have `PublicCardReadCache.card()` delegate to it.

### Why A1 cannot affect existing LIVE tournaments

1. **It is a pure extract-function refactor.** The same expressions, in the same order, move from a
   method body into a static function. No SQL changes, no new query, no new I/O, no new state, no
   Spring wiring, no thread or transaction boundary change.
2. **Every cache attribute is preserved verbatim.** `@Cacheable(cacheNames = PUBLIC_CARD_DETAILS, key
   = "#cardId", sync = true)` and `@Transactional(readOnly = true, isolation = REPEATABLE_READ)` stay
   on the same method with the same signature. The eviction path
   ([`@EvictPublicCard`](../backend/src/main/java/com/ctwe/tournament/infrastructure/cache/EvictPublicCard.java))
   is untouched because it keys off the method, not its body.
3. **No public surface changes.** No controller, no DTO, no route, no header, no cache policy, no
   `public_version` semantics, no SSE payload. A viewer cannot observe it even in principle.
4. **It is already covered by existing tests** — `PublicCardReadCacheTest`,
   `PublicCardControllerTest`, `TournamentCardCacheEvictionTest`, `CardControllerCacheRoutingTest` —
   plus A0's golden file, which fails on any byte-level drift.
5. **Nothing in production calls the new class.** Until A2, `PublicCardProjection` has exactly one
   caller: the method it was extracted from. From the live path's perspective the change is a no-op.
6. **Rollback is one `git revert`** of a commit touching one existing file and adding one new file.
   No migration, no configuration, no infrastructure, no data, no client, no deploy coordination.

### Why it must be first rather than later

The equivalence invariant (architecture R1, Phase C) is only meaningful if the snapshot and the live
API provably share **one** projection. If the builder were written independently and reconciled by
tests afterwards, the two would drift the first time someone adds a field to `CardDtos.CardResponse` —
and the failure mode is a silently stale permanent public artifact. A1 makes that class of bug
structurally impossible before any snapshot code exists to be wrong.

### Explicit sequencing note

Phase 0 (naming + guardrails) should still land **before or alongside** A1. It touches entirely
different files, carries no snapshot logic, and removes the documented risk of confusing publication
with the destructive Excel purge while both are being worked on.
