# Public Snapshot — Final Architecture Review (v2)

**Supersedes:** `docs/STATIC_ARCHIVE_ARCHITECTURE.md` (v1, same session).
**Status:** Authoritative design. Phases 0, A, C, B and D are implemented against it; E, F, G, H and I
are not yet built. Sections marked **(normative)** — §7.5, §7.6, §7.7 — state binding rules that
implementation revealed and that supersede any earlier sketch elsewhere in this document.
**Purpose:** Resolve every open point from v1 and serve as the authoritative design for implementation.

Feature name throughout this document: **Public Snapshot** (สแนปช็อตสาธารณะ). The word *archive* is
reserved for the existing Excel-export-and-purge feature — see §5.

---

## 0. New evidence found in this review

Four findings from re-inspecting the repository. Two of them invalidate parts of v1.

### Finding A — `access_token` is publicly enumerable, anonymously, today

[`PublicTournamentController.open()`](../backend/src/main/java/com/ctwe/tournament/web/PublicTournamentController.java#L47)
serves `GET /api/public/tournaments` (permitAll, per
[SecurityConfiguration:107](../backend/src/main/java/com/ctwe/tournament/infrastructure/security/SecurityConfiguration.java#L107))
and returns `PublicTournamentResponse{ id, name, accessToken, … }` for **every OPEN tournament**.
Anyone can `curl` it and receive every open tournament's viewer link.

Note also: `loadPublicTournaments` in [store.ts:831](../src/application/tournament/store.ts#L831) has
**no caller** — `/tournaments` redirects to `/admin`, and the root page only loads Excel archives. The
endpoint is a live, unused token-enumeration surface. (Independent hardening opportunity; see §11-O3.)

**Consequence:** `access_token` is not a secret. §3 rebuilds the key decision on this basis.

### Finding B — v1 proposed a URL that already means "permanently delete the tournament"

`POST /api/admin/tournaments/{tournamentId}/archive` **already exists**
([AdminController:79](../backend/src/main/java/com/ctwe/tournament/web/AdminController.java#L79)) and calls
`archiveAndDelete` — Excel export followed by deletion of all live rows. v1 §15 proposed the *identical
path* for static publication. Had that been implemented, an admin (or a script, or a future developer
reading the route table) could have triggered irreversible data loss while intending to publish.

This is the single strongest argument for §5's naming discipline, and it is now a worked example rather
than a hypothetical.

### Finding C — the most destructive operation has the weakest re-auth

| Operation | Effect | Password re-auth? |
| --- | --- | --- |
| `setTournamentStatus` (OPEN/CLOSE) | Toggles a link | ✅ `reauth.requireCurrentPassword` |
| `archiveAndDelete` | **Deletes every card, player, match, result** | ❌ role + confirm dialog only |

Pre-existing asymmetry, not caused by this project, but §5 makes it worse if left alone (the purge
button gains a visually similar neighbour). Fixing it is folded into the guardrails.

### Finding D — a two-bucket split resolves retraction and cache-lifetime together

v1 put immutable `v/{n}/**` objects with `max-age=31536000, immutable` on the same public hostname as
the pointer. Those objects are only ever read by the backend's verification step — yet publishing them
publicly with a one-year TTL would make retraction structurally incomplete. §7 splits private history
from the public surface, reducing the public surface to **exactly one object per published tournament**.

---

## 1. Decision Table

| # | Problem | Options | Recommended | Reason |
| --- | --- | --- | --- | --- |
| D1 | Snapshot discovery for `/tour/{slug}` | client probe · cached manifest · Worker routing · route metadata · hint in public API · redirect rules | **Client static-first probe, where the probe *is* the data fetch** (§2) | Adds **0 origin requests** on the live path (one edge-cached 404), removes **all** origin requests on the published path, needs no Worker CPU, no new service, and preserves the public API byte-for-byte. Kill switch is one unset env var |
| D2 | Cost of the probe on the live path | accept · eliminate via Worker · eliminate via manifest | **Accept, with four mitigations** (edge-cached 404, browser negative cache, early issuance, session memo) (§2.4) | Mitigations reduce it to a sub-30 ms edge round trip that overlaps JS hydration, and to zero on refresh. Worker/manifest alternatives cost Worker CPU or break per-tournament isolation |
| D3 | Probe failure / slowness | retry · block · fall through | **1.2 s timeout → fall through to the live path** | A snapshot problem must never delay or break a live event |
| D4 | R2 object key | raw `access_token` · tournament UUID · random snapshot id · derived hash | **`base32(sha256("ctwe-public-snapshot-v1\|" + access_token))`, 26 chars** (§3.4) | UUID and random ids are not derivable by the browser from `/tour/{slug}` — they would require exactly the per-request lookup that is forbidden. The hash is browser-derivable with zero lookups, is opaque, fixed-length, domain-separated, decouples storage from routing, and keeps tournament names out of CDN/R2 logs and browser history. **It is not a security control** (§3.5) |
| D5 | Does the published payload echo `accessToken`? | yes (v1) · no | **No** (§3.6) | The client already holds the token from the URL. Echoing it writes the routing token into a permanently public file for no benefit |
| D6 | Is `access_token` a security boundary? | yes · no | **No — the boundary is the server-side `status = 'OPEN'` check** (§3.2) | Finding A. Documented explicitly so nobody later assumes secrecy |
| D7 | Publication trigger | automatic on FINISHED · admin one-click · explicit approval then publish | **`FINISHED → NOT_PUBLISHED` by default; explicit approval record, then a separate publish action** (§4) | Publication is irreversible in effect. It must be a deliberate, attributable act, not a side effect of finishing a tournament |
| D8 | Who approves publication | admin only · director only · either | **Director assigned to the tournament (the organizer) or admin — password re-auth + typed acknowledgment** (§4.2) | The director is the event's data controller; the admin is the platform operator. Either may approve; both are recorded |
| D9 | Who may retract | same as publish · wider | **Wider: any admin, or any director of that tournament, no approval record needed** (§4.4) | Retraction must always be easier and faster than publication |
| D10 | Approval validity | permanent · time-boxed · content-bound | **Time-boxed (7 days) *and* bound to a content fingerprint** (§4.3) | Prevents publishing content the approver never saw |
| D11 | Does `CLOSED` hide a published snapshot? | yes · no | **No — but closing a published tournament prompts about the snapshot** (§4.6) | A credential-free CDN object cannot consult the DB. Making that explicit at approval time and again at close time is honest; hiding it behind a Worker check costs Worker CPU and reintroduces compute on the published path |
| D12 | Field exclusion from the snapshot | reduced-PII profile · same public projection | **Same public projection, minus `accessToken`** (§4.7) | The public projection already strips `rules`/`tables`/`audit`/`submittedBy`. A reduced profile would break the UI and the equality invariant. If names+schools cannot be permanently public, the answer is *do not publish* — which is the default |
| D13 | Feature naming | "archive" · "static archive" · "Public Snapshot" | **Public Snapshot** (§5) | Finding B. `archive` is load-bearing for a destructive feature at both the class and HTTP-route level |
| D14 | Preventing Excel-purge / snapshot confusion | docs only · naming only · enforced guardrails | **Six guardrails, one of them load-bearing: purge refuses while a snapshot is published** (§5.3) | Turns an accidental adjacency into an enforced, safe interaction |
| D15 | Source of truth | R2 · Postgres · both | **PostgreSQL. R2 is a derived cache** (§6) | Enables regeneration, makes retraction safe, and keeps the snapshot pipeline non-destructive |
| D16 | Public object layout | version prefixes public · single pointer public | **Exactly one public object per published tournament; all history private** (§7.1) | Makes retraction provably complete (delete one key) and prevents year-long public caching of superseded versions |
| D17 | Atomic switch | delete+write · multi-object · single overwrite | **Single `PutObject` overwrite of one self-contained object, after read-back verification at a staging key** (§7.2) | No window where the old snapshot is gone or a partial one is visible |
| D18 | Concurrent publishes | optimistic · DB row lock | **DB row lock on `tournaments`, version always increments** | The pipeline is admin-triggered and rare; a lock is simplest and sufficient |

---

## 2. Q1 — Snapshot Discovery and Routing

### 2.1 Does the probe cause a double request for live tournaments?

Precise accounting, per cold page load:

```text
                        Worker   CDN-edge   Render     Neon
TODAY (any tournament)
  document /tour/{t}      1         —         —         —
  bundle                  —         —         1        0–1
  realtime-config         —         —         1         0
  SSE stream              —         —         1         0
                        ─────────────────────────────────────
                          1         0         3        0–1

PROPOSED — LIVE (not published)
  document /tour/{t}      1         —         —         —
  probe → 404 (cached)    —         1         —         —      ← the only addition
  bundle                  —         —         1        0–1
  realtime-config         —         —         1         0
  SSE stream              —         —         1         0
                        ─────────────────────────────────────
                          1         1         3        0–1      Δ = +1 edge, +0 origin

PROPOSED — PUBLISHED
  document /tour/{t}      1         —         —         —
  probe → 200 + all data  —         1         —         —      ← this IS the data fetch
                        ─────────────────────────────────────
                          1         1         0         0       Δ = −3 Render, −1 Neon, −SSE
```

**Answer: no.** There is no double *data* request and no double *origin* request. The live path issues
exactly the same requests to Render as today. The addition is one request to a Cloudflare edge that is
answered by an edge-cached `404` and never reaches R2, Render, or Neon.

On the published path the probe **is** the bundle fetch — one request delivers the whole tournament,
matching the existing one-request design ([EVENT_CAPACITY_RUNBOOK.md](EVENT_CAPACITY_RUNBOOK.md)) rather
than regressing it.

The real cost is therefore **latency on the live path**, not request volume. §2.4 addresses it.

### 2.2 Options evaluated

| Option | Latency (live) | Render req | Worker CPU | Frontend change | Public API preserved | Published traffic off Render | Isolation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Client static-first probe** | +1 edge RTT, mitigable to ~0 | **0 added** | **0** | ~40 lines in `store.ts` + `public-api.ts` | ✅ untouched | ✅ fully | ✅ per-prefix |
| B. Cached manifest of published tokens | +1 edge RTT (same) | 0 | 0 | similar | ✅ | ✅ | ❌ **one shared mutable file** — publishing A invalidates the copy cached by every viewer of B/C/D; grows unbounded; a stale manifest either hides a snapshot or points at a retracted one |
| C. Worker routing (R2/KV binding, flag injected into the shell) | **best: 0 added** | 0 | ❌ **subrequest + CPU on every document render** | minimal | ✅ | ✅ | ✅ |
| D. Route metadata / separate route (`/snapshot/{slug}`) | 0 | 0 | 0 | large | ✅ | ✅ | ✅ but ❌ **breaks every published URL** |
| E. Hint embedded in the existing public API response | 0 | ❌ **1 Render request per published viewer, forever** | 0 | tiny | ✅ | ❌ **violates the hard requirement** | ✅ |
| F. Cloudflare Redirect Rules per published tournament | 0 | 0 | 0 | none | ✅ | ✅ | ❌ zone config write per tournament, rule-count limits, no atomicity |

**C is the only option with lower latency than A**, and it is rejected on the criterion the brief lists
third: *minimize Worker CPU*. The Worker is on the free tier with a 100k req/day budget and has already
been optimized for CPU. Adding an R2 `head()` subrequest to every `/tour/{slug}` document render taxes
the one component shared by **all** tournaments — live ones included — to benefit published ones. A is
the only option that keeps the cost entirely on the path that benefits.

**E is worth keeping as a secondary optimization, not as the mechanism.** For in-app navigation (a user
already viewing a live tournament), a `snapshotState` hint in the bundle lets the client skip the probe
entirely. It cannot be the mechanism because deep links — the dominant way tournament links are shared —
never see a prior response.

### 2.3 Recommended flow

```text
resolvePublicTournament(token):

  h = base32(sha256("ctwe-public-snapshot-v1|" + token))       // §3.4, memoized

  ┌─ GET https://snapshot.ct-we.com/s/{h}.json      timeout 1.2 s
  │
  ├─ 200 ─► verify envelope.schema is supported
  │         hydrate store from envelope.payload  (identical shape to the live bundle)
  │         mark published ⇒ no SSE, no polling, no push subscription
  │         ✅ DONE — Render, Neon, and the Worker were never contacted
  │
  ├─ 404 ─► live path, byte-for-byte unchanged:
  │         GET {NEXT_PUBLIC_PUBLIC_API_ORIGIN}/api/public/tournaments/{token}/bundle
  │         + /realtime-config + SSE + existing polling fallback
  │
  └─ timeout / network error / unsupported schema / parse failure
            ─► same live path (fail-open)
```

### 2.4 The four mitigations that make the live cost negligible

| # | Mitigation | Effect |
| --- | --- | --- |
| M1 | Cloudflare **Cache Rule caching `404` for `snapshot.ct-we.com/s/*`** (edge TTL ≈ 60 s) | The probe is answered at the PoP. It never reaches R2, so it costs no R2 operation and no origin work |
| M2 | Serve the 404 with `Cache-Control: public, max-age=60` | The **browser** caches the negative result. A refresh within 60 s issues no network request at all — and refresh is the dominant repeat behaviour during a live event |
| M3 | Issue the probe at **module scope / as early as the token is known**, plus `<link rel="preconnect">` to the snapshot origin in the `/tour/[token]` route | The probe overlaps JS download, parse, and hydration. Measured against a cold page load (document → chunks → hydrate → store init), it should complete before the store is ready to use it |
| M4 | Memoize the result in `sessionStorage` (`live` ≈ 10 min TTL, `published` ≈ session) | Removes the probe for in-session navigation and refreshes beyond the HTTP cache window |

Plus D3's 1.2 s timeout: under no circumstance does the snapshot lookup delay a live tournament by more
than that, and any failure degrades to today's exact behaviour.

### 2.5 Verification before cutover

The existing [`load-testing/`](../load-testing/README.md) harness must show, before the flag is enabled
in production:

1. Live-path p95 to first rendered data does **not** regress beyond an agreed budget (suggest ≤ 25 ms).
2. Probe 404s are served from the edge (`cf-cache-status: HIT`) at steady state.
3. A published tournament under load produces **zero** Render requests and **zero** SSE connections.

If (1) fails, Option C (Worker routing) is the documented fallback — the client change is identical; only
the signal's source moves.

---

## 3. Q2 — `access_token` Semantics and the Object Key

### 3.1 What `access_token` actually is

| Property | Evidence |
| --- | --- |
| Admin-chosen slug, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 3–64 chars | [`TenantService.createTournament`](../backend/src/main/java/com/ctwe/tournament/application/TenantService.java#L44) |
| **Human-guessable** for new tournaments (`bkk-th-ms-championship`) | same |
| Legacy values are 32-hex random (`replace(gen_random_uuid()::text,'-','')`) | V16, V17 |
| `UNIQUE NOT NULL`, no update path — deliberately immutable so published URLs never break | V16; `TenantService` comment: *"published viewer URLs must never break"* |
| Serves both `/tour/{slug}` and legacy `/t/{hex}` | [store.ts:321](../src/application/tournament/store.ts#L321) regex `^/(?:tour\|t)/([^/]+)/?$` |
| **Publicly enumerable for every OPEN tournament by anonymous HTTP GET** | Finding A |
| The actual gate is a server-side status check | `resolveOpenTournament`: `WHERE t.access_token = ? AND t.status = 'OPEN'` |

### 3.2 Verdict

> `access_token` is a **public routing identifier protected by a server-side, revocable gate**
> (`tournaments.status`). It is **not** an unguessable access secret, and it cannot be one while
> `GET /api/public/tournaments` publishes it.

Its cryptographic strength is mixed and irrelevant: legacy tokens are random, new ones are guessable, and
both are handed out by a public endpoint. Closing a tournament does not restore secrecy for any token
that was ever open.

For contrast, the system *does* treat another identifier as a capability:
[`docs/DATABASE_SPEC.md`](DATABASE_SPEC.md#L205) says of `tournament_cards.id` — *"อยู่ใน URL สาธารณะ …
ต้อง unguessable จึงคง UUID"* (must be unguessable, therefore kept as a UUID). The codebase distinguishes
the two cases; this design must not blur them.

### 3.3 Therefore

Placing the token (or anything derived from it) in a public R2 path **does not weaken access control**,
because the token is not the access control. But three real, non-security concerns remain:

1. **Semantic entrenchment.** Publishing the token as an object path forecloses any future decision to
   treat it as a secret, and invites a future reader to assume "it's in a public URL, so it's public
   everywhere" about identifiers where that is false (card UUIDs).
2. **Log and history hygiene.** Human-readable tournament names would appear in CDN logs, R2 request
   logs, browser history, and `Referer` headers.
3. **Coupling.** Storage keys would be tied to a routing string, so any future slug alias, rename, or
   normalization change would orphan snapshots.

### 3.4 Key options and the recommendation

| Key | Browser can derive it from `/tour/{slug}`? | Opaque? | Verdict |
| --- | --- | --- | --- |
| Raw `access_token` | ✅ | ❌ | Works; entrenches semantics and leaks names |
| `tournament_id` (UUID) | ❌ — **requires a lookup**, i.e. exactly the per-request DB query the brief forbids | ✅ | ❌ Reject as the discovery key |
| Random public snapshot id | ❌ — same lookup problem | ✅ | ❌ Reject as the discovery key |
| **`base32(sha256("ctwe-public-snapshot-v1\|" + access_token))[0..25]`** | ✅ via `crypto.subtle.digest` (HTTPS-only; available in all target browsers) | ✅ | ✅ **Recommended** |

```text
public object key :  s/{h}.json            where h = 26-char base32 of the domain-separated SHA-256
private history   :  t/{tournament_uuid}/v/{n}/…      ← keyed by the real internal identity
```

The internal/private side is keyed by `tournament_id`, because there no browser derivation is needed and
the UUID is the true identity. The public side is keyed by the derived hash, because there the browser
must compute it with zero lookups. `tournament_id`, `access_token`, and the tournament name are all
recorded in the private manifest and in `public_snapshot_publications`, so operators can always map
between them.

### 3.5 Stated plainly, so it is never misread

> **The hash is not a security control.** Anyone who knows or guesses the slug can compute the same
> value in one line of JavaScript. It buys decoupling, log hygiene, and semantic clarity — nothing more.
> Any future requirement for genuinely private results must be met by a server-side check, not by this
> path being hard to type.

This sentence belongs verbatim in the Javadoc of the key-derivation function.

### 3.6 The payload must not echo the token

The live bundle includes `accessToken` (`TenantDtos.PublicTournamentBundle`). The snapshot omits it: the
client already has the token from the URL, so nothing is lost, and the permanently public file does not
carry the routing identifier. `store.setActiveTournament` takes the token from the URL on the published
path — a one-line adaptation. The equality test in §9 compares modulo this single field.

---

## 4. Q3 — Publication Policy

### 4.1 The lifecycle is explicitly two-step

```text
   card work finishes                    NOTHING IS PUBLISHED BY DEFAULT
          │
          ▼
   ┌──────────────┐
   │NOT_PUBLISHED │ ◄──────────────────────────────────────────┐
   └──────┬───────┘                                            │
          │  director-of-tournament or admin:                  │
          │  APPROVE  (password re-auth + typed acknowledgment) │
          ▼                                                    │
   ┌──────────────┐   approval expires (7d) or content changes  │
   │  APPROVED    │ ───────────────────────────────────────────►│
   └──────┬───────┘                                            │
          │  PUBLISH (pipeline §7)                              │
          ▼                                                    │
   ┌──────────────┐   pipeline failure ─► PUBLISH_FAILED ───────┤
   │  PUBLISHED   │   (nothing public changed)                  │
   └──────┬───────┘                                            │
          │  RETRACT (admin or any director of the tournament)  │
          ▼                                                    │
   ┌──────────────┐  re-publication requires a NEW approval ────┘
   │  RETRACTED   │
   └──────────────┘
```

`snapshot_state ∈ { NOT_PUBLISHED, APPROVED, PUBLISHING, PUBLISHED, PUBLISH_FAILED, RETRACTED }`,
per tournament, orthogonal to `tournaments.status` (OPEN/CLOSED) and to card status.

### 4.2 Who may do what

| Action | ROLE_ADMIN | ROLE_DIRECTOR (assigned to that tournament) | ROLE_STAFF | Anonymous |
| --- | --- | --- | --- | --- |
| Approve publication | ✅ password re-auth + acknowledgment | ✅ password re-auth + acknowledgment | ❌ | ❌ |
| Publish (run pipeline) | ✅ requires a valid approval | ✅ requires a valid approval | ❌ | ❌ |
| **Retract** | ✅ **no approval needed** | ✅ **no approval needed** | ❌ | ❌ |
| Read a published snapshot | ✅ | ✅ | ✅ | ✅ (that is the point) |
| Write/delete objects directly | ❌ (only via the backend) | ❌ | ❌ | ❌ |

The asymmetry is deliberate: **publication is hard, retraction is easy.**

**As built (Phase E), and the O1 decision.** The rule in the table above is implemented in
`SnapshotApprovalService` as two independent conditions, because either alone is wrong:

- **Role** — ADMIN or DIRECTOR. Checked explicitly. Being *scoped* to a tournament is not entitlement:
  result-entry staff are legitimately scoped in through `staff_tournament_access`, and the table above
  gives them nothing. Scope alone would have let staff consent to permanent publication.
- **Scope** — delegated to the shared `AuthorizationService.requireTournamentAccess`, so approval
  cannot drift from the tenancy rule the rest of the application enforces. Deliberately *not*
  `requireTournamentCapability`, which additionally demands the tournament be OPEN; publication
  readiness is card state (§7.5), not link state, and a tournament worth publishing is usually closed.

Authorization is evaluated **before** re-authentication, so a refusal can never confirm a password
guess for a tournament the caller has no business with.

**O1 remains open at the HTTP layer, deliberately.** The routes stay under `/api/admin/**`, which
`SecurityConfiguration` gates with `hasRole("ADMIN")`, so the surface a director can actually reach is
unchanged. The §4.2 rule is nonetheless real and tested one layer down. Granting directors the
documented access is then a single `requestMatchers` line plus director-side UI — a configuration
decision, not a redesign, which is the point of implementing the rule before exposing it.

### 4.3 The approval record

```sql
-- illustrative shape only; not applied
public_snapshot_approvals (
  tournament_id      UUID NOT NULL,
  approved_by        VARCHAR(64) NOT NULL,
  approved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledgment_rev SMALLINT NOT NULL,   -- which consent text was shown
  content_fingerprint CHAR(64) NOT NULL,  -- sha256 over every card's (id, public_version)
  expires_at         TIMESTAMPTZ NOT NULL -- approved_at + 7 days
)
```

Publishing requires an approval that is **unexpired** *and* whose `content_fingerprint` still matches the
tournament's current state. If any card changes after approval, the fingerprint diverges and re-approval
is required — so nobody can publish content the approver never saw. The fingerprint reuses
`public_version`, which already changes exactly when publicly visible data changes (V14).

**As built (V32), normative.** Four points where the implementation is more specific than the sketch
above, each a deliberate decision rather than a drift:

1. **Revocation is a soft delete.** The plan's API says `DELETE …/approve`, but the row is kept and
   marked with `revoked_at`/`revoked_by` instead of being removed. An approval is an attributable act;
   destroying the row would destroy the record of who accepted permanent publication of minors' names,
   which is the one thing this table exists to preserve. The two extra columns are `NULL`-able, so
   §0.2's revert rule still holds.
2. **The fingerprint is defined exactly.** Lowercase-hex SHA-256 over `"{cardId}:{public_version}\n"`
   for every card, sorted by the id's string form in the application rather than by SQL `ORDER BY`, so
   the digest cannot depend on database collation. Adding or removing a card changes it as surely as
   editing one does. It is stored bare (`CHAR(64)`), not in the `sha256-…` form used for snapshot
   checksums, because it never appears in an artifact and is never compared against one.
3. **The approval record is authoritative; `snapshot_state` is a projection.** Validity is answered
   from `public_snapshot_approvals` at the moment of use — inside the publishing row lock — never from
   the state column. `APPROVED` exists for operators to read; it is not what authorizes anything.
   Consequently the state column follows an approval only where §4.1 has an arrow for it: approving a
   `PUBLISHED` tournament (a republish) leaves it `PUBLISHED`, because something *is* public and the
   pointer still describes it.
4. **Publication does not consume the approval.** §7.2 step 0 admits `PUBLISHED` as a republish state,
   and an unexpired, fingerprint-matching approval still describes exactly the content being
   republished. Re-publishing identical content therefore needs no new consent; changing anything
   invalidates the approval through the fingerprint, which is the guard that matters.

### 4.4 Acknowledgment text (shown at approval, both languages)

> **การเผยแพร่นี้ถาวรและเรียกคืนไม่ได้**
> ข้อมูลที่จะเผยแพร่ประกอบด้วย **ชื่อ-นามสกุลจริง** และ **สังกัดโรงเรียน/สถาบัน** ของผู้เข้าแข่งขัน
> ซึ่งบางส่วนอาจเป็นผู้เยาว์ เมื่อเผยแพร่แล้ว:
> • ผู้ใช้ทั่วไปสามารถดาวน์โหลดและทำสำเนาได้
> • เบราว์เซอร์และ CDN อาจเก็บสำเนาไว้
> • บุคคลที่สามอาจคัดลอกหรือทำดัชนีข้อมูล
> • **การถอนการเผยแพร่ (retract) จะหยุดการเข้าถึงใหม่ แต่ไม่สามารถเรียกคืนสำเนาที่ถูกดาวน์โหลดไปแล้วได้**
> • การปิดลิงก์ (CLOSED) **ไม่** ทำให้ฉบับเผยแพร่หายไป — ต้องกดถอนการเผยแพร่เท่านั้น
>
> *This publication is permanent and cannot be recalled. Retraction stops new access but cannot retrieve
> copies already downloaded. Closing the tournament link does NOT remove a published snapshot.*

Approval requires typing the tournament name, matching the pattern already used for destructive dialogs
in [`admin/page.tsx`](../src/app/admin/page.tsx).

### 4.5 Retraction

```text
RETRACT (admin, or any director of that tournament)
  1. DELETE public object  s/{h}.json                     ← the entire public surface (§7.1)
  2. Cloudflare purge-by-URL for that key
  3. snapshot_state = RETRACTED; retracted_by / retracted_at recorded
  4. audit_logs: 'RETRACT_PUBLIC_SNAPSHOT'
  5. Private history retained (rollback + audit); it was never publicly reachable
```

**Retraction SLA, stated honestly:**

- New requests stop being served within *purge propagation* (seconds).
- Browsers holding a cached copy stop using it within **≤ 5 minutes** (`max-age=300`, §7.3).
- **Copies already downloaded, screenshotted, scraped, or indexed cannot be recalled.** This is a
  property of public publication, not a deficiency of the design, and it is why §4.1 makes publication
  a two-step, attributable act.

Re-publishing after retraction requires a **new** approval — the pipeline refuses to regenerate into a
`RETRACTED` state (§6.4). This prevents an automated verify/repair job from resurrecting withdrawn data.

**As built (V33), normative.** Five points where the implementation is more specific than the sketch
above, each a deliberate decision:

1. **Step 3 is split in two, around step 1.** `retracted_by`/`retracted_at` are written *before* the
   delete, as a statement of **intent**; `snapshot_state` becomes `RETRACTED` only once the object is
   actually gone. The marker exists because "the object is missing" is ambiguous on its own — it is
   equally what a deliberate withdrawal and a lost object look like, and those want opposite repairs.
   With it, the reconciler (§7.8) finishes an interrupted retraction instead of guessing. A delete
   that never happened rewinds the intent, so a refused retraction leaves the tournament exactly as
   it was and is perfectly retryable.
2. **Once the delete succeeds, the destination is fixed.** No later failure returns the tournament to
   `PUBLISHED`: the bytes are gone, and a state claiming otherwise is one a viewer could disprove.
3. **The 404 check reports; it does not veto.** If an edge is still serving a cached copy, the
   withdrawal has still happened, and the SLA above already says how long that lasts. The state moves
   and the operation's result says the 404 was not confirmed yet. Making the commit conditional on a
   cache would leave the database claiming something is published that has already been deleted.
4. **No-resurrection is enforced on every path that can write the public object** — publish (via
   `beginPublishing`), **rollback**, and reconcile — plus approval, so the pipeline cannot be
   re-entered from the front either. Rollback is the one that matters most in practice: it promotes
   bytes straight from private history, so a guard on publish alone would leave a one-call route back
   onto the CDN. A pending (not yet completed) retraction also blocks publication, so the two cannot
   race for the same key.
5. **Which states may be retracted.** The test is the publication *history*, not the state column and
   not the pointer. A publish that promotes and then fails its read-back leaves the pointer at `0` and
   the state at `PUBLISH_FAILED` while `s/{h}.json` is being served — the case where withdrawal
   matters most, and the one G1 blocks the Excel purge over. Only a tournament that never attempted a
   publication is refused, because `RETRACTED` would permanently block one that never published.
   Retraction is refused while a publish is in flight (`PUBLISHING`); reconcile resolves that first.

### 4.6 When tournament privacy changes

`CLOSED` cannot gate a credential-free CDN object (D11). Rather than pretend otherwise, the two controls
are surfaced together:

- The admin tournament row shows both badges: `ลิงก์เปิด/ปิด` **and** `เผยแพร่แล้ว/ยังไม่เผยแพร่`.
- Closing a tournament that has a `PUBLISHED` snapshot raises a confirm dialog:
  *"ทัวร์นาเมนต์นี้มีฉบับเผยแพร่สาธารณะอยู่ — การปิดลิงก์จะไม่ลบฉบับเผยแพร่ ต้องการถอนการเผยแพร่ด้วยหรือไม่?"*
  with a one-click "close **and** retract" option.

### 4.7 Field exclusion

The snapshot publishes **the same public projection the live API already serves**, minus `accessToken`.

Already excluded by [`PublicCardReadCache.card()`](../backend/src/main/java/com/ctwe/tournament/application/PublicCardReadCache.java):
`rules`, `tables`, `audit`, and `finalRound` until visible. Never present in the public projection:
`submittedBy`, `submittedAt`, staff accounts, memberships, push subscriptions, audit logs, runtime
settings, other tournaments' tokens.

A reduced-PII profile (initials, no school) was considered and **rejected**: it would break the viewer UI,
the PDF/Excel exports, the school-conflict display, and the equality invariant that keeps the snapshot
honest — and it would produce a document that misrepresents the event. If an organizer cannot accept
permanent publication of athlete names and school affiliations, the correct answer is the default:
**do not publish**. The tournament remains fully viewable live, exactly as today.

*Optional, deferred:* a `publish_until` date with scheduled auto-retraction, for organizers who want
time-boxed publication of youth events. Not required for v1.

---

## 5. Q4 — Naming and Collision Prevention

### 5.1 Terminology

| Concept | Name | Thai UI | Never call it |
| --- | --- | --- | --- |
| Existing: `.xlsx` export + **delete live rows** | **Excel Export & Purge** | "ส่งออก Excel และลบข้อมูล" (existing: "เก็บเข้าคลัง") | ~~snapshot~~, ~~publish~~ |
| New: immutable public JSON on R2 | **Public Snapshot** | "ฉบับเผยแพร่สาธารณะ" / "เผยแพร่ผลถาวร" | ~~archive~~, ~~เก็บเข้าคลัง~~ |

### 5.2 Concrete names

| Layer | Excel Export & Purge (existing) | Public Snapshot (new) |
| --- | --- | --- |
| Package | `…application.excelexport` | `…application.publicsnapshot` |
| Service | `TournamentExcelExportService` *(renamed from `TournamentArchiveService`)* | `PublicSnapshotBuilder`, `PublicSnapshotValidator`, `PublicSnapshotPublisher` |
| Method | `exportToExcelAndPurgeLiveData(…)` *(renamed from `archiveAndDelete`)* | `publish(…)`, `retract(…)`, `regenerate(…)` |
| Storage port | — | `SnapshotObjectStore` (the only class reading R2 credentials) |
| Controller | `ArchiveController` / `PublicArchiveController` *(HTTP paths unchanged)* | `PublicSnapshotController` |
| HTTP | `POST /api/admin/tournaments/{id}/archive` ⚠️ **destructive — unchanged** | `POST /api/admin/tournaments/{id}/public-snapshot/{approve,publish,retract,regenerate,verify}` |
| DB | `tournament_archives` (unchanged) | `tournaments.snapshot_state / snapshot_version / published_at`, `public_snapshot_publications`, `public_snapshot_approvals` |
| Audit action | `ARCHIVE_TOURNAMENT` (unchanged) | `APPROVE_PUBLIC_SNAPSHOT`, `PUBLISH_PUBLIC_SNAPSHOT`, `RETRACT_PUBLIC_SNAPSHOT` |

Existing HTTP paths and the `tournament_archives` table are **not** renamed:
`/api/public/archives/**` is consumed by [`page.tsx:173`](../src/app/page.tsx#L173) and
[`archive-list.tsx`](../src/ui/components/archive-list.tsx). Renaming them buys nothing and risks
breaking a working public download. Java identifiers, UI copy, and the new namespace carry the distinction.

### 5.3 Six guardrails against a future developer connecting the two

| # | Guardrail | Type |
| --- | --- | --- |
| G1 | **Purge refuses while a snapshot is published.** `exportToExcelAndPurgeLiveData` throws unless `snapshot_state ∈ {NOT_PUBLISHED, RETRACTED}`. Purging live rows destroys the ability to regenerate (Invariant I7), so the two features are wired together *safely and deliberately* instead of being adjacent by accident | **Enforced at runtime — load-bearing** |
| G2 | CI test asserting no class in `…publicsnapshot` references `…excelexport` (or `archiveAndDelete`/`TournamentArchiveService`) and vice versa | **Enforced in CI** |
| G3 | Purge takes a typed `PurgeConfirmation` request object carrying the tournament name and the operator's password — it cannot be invoked with a bare id, and it gains the password re-auth it lacks today (Finding C) | **Enforced by the type system + runtime** |
| G4 | Cross-reference banner comments at the top of both services: *"This is Excel Export & Purge — it DELETES live data. It is NOT the Public Snapshot publisher (see PublicSnapshotPublisher). Do not merge, wrap, or chain these."* and the mirror image | Convention |
| G5 | UI: separate panels, separate colours (purge stays `variant="danger"`; publish is neutral/primary), distinct Thai wording per §5.1, and type-the-name confirmation on purge | Convention |
| G6 | A note in `CLAUDE.md` / `README.md` recording the v1 near-miss (Finding B) as the reason the naming rule exists | Documentation |

G1 and G2 are the ones that survive turnover; G4–G6 are reminders. The ordering matters: **do not rely on
naming alone.**

---

## 6. Q5 — Durability and Regeneration

### 6.1 The invariant, confirmed

```text
PostgreSQL  =  SOURCE OF TRUTH        (authoritative, mutable, backed up, private)
R2          =  DERIVED PUBLIC CACHE   (reproducible, disposable, public, read-only to the world)
```

The publication pipeline is **strictly non-destructive to PostgreSQL**. It performs `SELECT`s inside one
read-only transaction, plus writes to its own bookkeeping tables (`snapshot_state`,
`public_snapshot_publications`, `public_snapshot_approvals`, `audit_logs`). It never touches
`tournament_cards`, `players`, `matches`, `standings`, `pairing_snapshots`, `games`, or `final_*`.

Corollary: **if every R2 object were deleted tomorrow, every snapshot could be regenerated byte-identically
from PostgreSQL.**

### 6.2 Deterministic generation (what makes "byte-identically" true)

| Requirement | Implementation |
| --- | --- |
| Stable field order | A **dedicated `ObjectMapper`** for snapshots, not the Spring-Boot-wide one. `application.yml` sets `jackson.default-property-inclusion: non_null` globally; a future change there must not silently alter published payload shape |
| Stable collection order | Explicit sorts: cards by `created_at, id`; players by `code`; snapshots by `snapshot_no`; pairings by `(gameNumber, tableNumber)`; final slots by `slot`, games by `gameIndex` |
| Stable timestamps | UTC ISO-8601 with fixed precision |
| Stable numbers | No locale formatting; integers as integers |
| Generation-time values isolated | `generatedAt` and `version` live in the envelope, never in `payload`, so `payload` bytes depend only on DB state |

Consequence: `sha256(payload)` is a content fingerprint. Two generations from unchanged data produce the
same digest, which makes verification (§7), drift detection (§6.5), and the CI equality test (§9) all
meaningful rather than approximate.

### 6.3 Regeneration flow

```text
POST /api/admin/tournaments/{id}/public-snapshot/regenerate
  │
  ├─ refuse if snapshot_state = RETRACTED        ← never resurrect withdrawn data (§4.5)
  ├─ refuse if no valid approval (§4.3)
  ├─ build payload from PostgreSQL  (identical code path as first publication)
  ├─ compare sha256 with the recorded checksum for the current version
  │     ├─ identical → re-upload the same bytes, version unchanged  (pure repair)
  │     └─ different → this is a re-publication: version n+1, full pipeline §7
  └─ verify, promote, purge, verify, commit
```

Regeneration is idempotent for repair and versioned for genuine change — the same operation covers "R2
lost an object" and "we corrected a result".

### 6.4 Recovery matrix

| Loss event | Recovery | Data loss |
| --- | --- | --- |
| Public object deleted / corrupted | `regenerate` (repair path, same version) | none |
| Entire public bucket lost | `regenerate` every `PUBLISHED` tournament | none |
| Private history bucket lost | Regenerate current version; historical versions lost (audit rows survive in Postgres) | historical snapshot bytes only |
| R2 account lost | Re-provision, re-point `snapshot.ct-we.com`, regenerate all | none |
| Bad data published | `retract` (immediate) then correct in Postgres, re-approve, re-publish | none |
| **Live rows purged by Excel Export & Purge** | ❌ **regeneration impossible** | ⚠️ **This is why G1 blocks it while published** |

### 6.5 Drift detection

A scheduled or manual `verify` fetches each published object through the public hostname and compares its
checksum with `public_snapshot_publications`. **`verify` itself writes nothing** — it is a pure read, so
that a monitor calling it cannot change state and a transient CDN failure cannot be mistaken for drift.
Resolving what it reports is `reconcile` (§7.8), which **never auto-republishes**: it either completes a
commit for bytes that were already verified and promoted, or restores the pointer's own recorded bytes
from private history, or marks the tournament `PUBLISH_FAILED` and stops. Generating a fresh payload in
response to drift is never automatic, because it would risk publishing content whose approval has lapsed
or which a human deliberately altered.

---

## 7. Q6 — Atomic Publication

### 7.1 Two buckets; the public surface is one object per tournament

```text
PRIVATE  r2://ctwe-snapshots            (S3 API only — NO custom domain, NO public access)
   t/{tournament_uuid}/
     v/{n}/payload.json          immutable, verified, full history
     v/{n}/manifest.json         version, checksums, actor, approval id, slug, name
     v/{n}/cards/{cardId}.json   per-card copies (ops/debug)

PUBLIC   r2://ctwe-snapshots-public     (custom domain snapshot.ct-we.com, GET only)
   s/{h}.json                    ← EXACTLY ONE object per published tournament
   s/{h}.staging-{n}.json        ← transient, deleted after promotion
```

Why this split matters:

- **Retraction is provably complete** — one `DeleteObject` plus one purge removes the entire public surface.
- **No superseded version is ever publicly cached.** v1 would have served `v/{n}` objects with
  `max-age=31536000, immutable`; a retraction could not have reached those browser caches for a year.
- **History survives retraction** for audit and rollback, without ever having been public.
- **Rollback is a copy**, not a regeneration: read `v/{n-1}/payload.json` from private, `PutObject` to
  `s/{h}.json`. Seconds.

### 7.2 The pipeline, with the exact object operations

```text
 0  PRECONDITION   row lock on tournaments; state ∈ {NOT_PUBLISHED, APPROVED, PUBLISH_FAILED,
                   PUBLISHED(=republish)}; valid approval (§4.3);
                   EVERY card ALREADY FINISHED|CLOSED — a precondition, never an effect (§7.5)
                   → state = PUBLISHING; n = high-water mark + 1 (§7.6)

 1  BUILD          ONE read-only REPEATABLE_READ transaction, bypassing the Caffeine read cache
                   (a stale cached card must never be frozen into a permanent artifact)
                   → canonical payload bytes, sha256

 2  VALIDATE       re-parse; card count == DB; per-card player counts == DB; every card
                   FINISHED|CLOSED; rules/tables/audit empty; no submittedBy/submittedAt;
                   no accessToken; no foreign tournament_id; size ≤ 8 MB; schema pinned

 3  PERSIST HISTORY  PUT private t/{uuid}/v/{n}/cards/*.json
                     PUT private t/{uuid}/v/{n}/payload.json
                     PUT private t/{uuid}/v/{n}/manifest.json        (last)
                     ── nothing public has changed ──

 4  STAGE + VERIFY   PUT public s/{h}.staging-{n}.json   (X-Robots-Tag: noindex, max-age=0)
                     GET https://snapshot.ct-we.com/s/{h}.staging-{n}.json
                       ↳ proves DNS + CDN + CORS + content-type + byte integrity on the REAL path
                     assert sha256 matches; assert it parses; assert envelope.version == n

 5  RECORD         INSERT public_snapshot_publications (n, checksum, bytes, actor, approval_id,
                   status='VERIFIED')

 6  PROMOTE  ⚛     PUT public s/{h}.json   ← ONE atomic PutObject of the already-verified bytes
                   ══════ this single operation is when public traffic switches ══════

 7  PURGE          Cloudflare purge-by-URL for s/{h}.json

 8  VERIFY SWITCH  GET https://snapshot.ct-we.com/s/{h}.json → assert envelope.version == n

 9  COMMIT         snapshot_state = PUBLISHED, snapshot_version = n, published_at,
                   checksum; audit 'PUBLISH_PUBLIC_SNAPSHOT'
                   ── tournament_cards is NOT written here or anywhere else (§7.5, I4) ──

10  CLEAN UP       DELETE public s/{h}.staging-{n}.json   (best effort; inert if it fails)
```

### 7.3 Why there is no window of incompleteness

| Concern | Why it cannot happen |
| --- | --- |
| User sees a partial snapshot | The public surface is **one self-contained object**. There is no multi-object read that could observe a half-updated set |
| User sees a torn object | R2 `PutObject` is atomic per object — a reader gets the whole old object or the whole new one |
| Old snapshot disappears before the new one is ready | Steps 1–5 write only to **private** storage and a **staging** key. `s/{h}.json` is untouched until step 6, by which point the new bytes have already been fetched and checksum-verified through the public hostname |
| New snapshot promoted but never verified | Step 4 verifies **before** step 6. Step 8 verifies again after |
| Promoted but the DB commit fails | The **reconciler** (§7.8): if the public object's `version == n` and the checksum matches the recorded row for `n`, complete the commit; otherwise re-promote the pointer's own version from private history |
| Two publishes race | Row lock at step 0; `n` always increments; a stale publisher's promote is rejected by the lock, and (if available) a conditional `PutObject` guards the object as well |
| Cache serves the old snapshot | Bounded by `max-age=300` at the browser and by the purge at the edge; step 8 detects it; the envelope's `version` makes staleness positively detectable rather than inferred |

### 7.4 Cache headers

| Object | `Cache-Control` |
| --- | --- |
| `s/{h}.json` (200) | `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800` |
| `s/{h}.json` (404 — live or retracted) | `public, max-age=60` + Cache Rule caching 404 at the edge (§2.4 M1/M2) |
| `s/{h}.staging-{n}.json` | `no-store` |
| private bucket | not served publicly at all |

`max-age=300` is chosen as the retraction-latency budget (§4.5), not for efficiency. The long
`s-maxage`/`stale-while-revalidate` keeps edge traffic cheap; explicit purge handles correctness.

**Two things the application cannot set for itself**, and which the zone configuration therefore owes it:

| Requirement | Why the code cannot do it | What the zone must do |
| --- | --- | --- |
| The cache-busted read-back (`?verify={uuid}`) must actually miss the edge | The backend can only choose the URL; whether a query string separates cache entries is a zone decision | **Do not** apply "ignore query string" / a query-stripping cache key to `/s/*`. Cloudflare's default cache key includes the query string, so the default is correct — this is a constraint on future Cache Rules, not a change. Steps 8 and the reconciler's observation both depend on it: without it, a stale edge can answer for bytes that were just replaced |
| `X-Robots-Tag: noindex` on the staging object | R2 through the S3 API stores arbitrary headers as **user metadata** (`x-amz-meta-robots`), which is *not* emitted as `X-Robots-Tag`. `PutObject` can set `Content-Type` and `Cache-Control` and nothing else that matters here | A **Transform Rule → Modify Response Header** on `snapshot.ct-we.com` adding `X-Robots-Tag: noindex` for URIs matching `/s/*.staging-*.json`. Until it exists, staging objects remain `no-store`, unreferenced, and deleted after promotion — briefly reachable but not linked from anywhere — so this is defence in depth, not a correctness gate |

Both are infrastructure tasks, recorded here so they are provisioned deliberately rather than
discovered later.

---

### 7.5 Card state is a precondition, never an effect (normative)

> **Publication MUST NOT mutate `tournament_cards`.**
> Every card must **already** be `FINISHED` or `CLOSED` before publication may begin.

| Situation | Behaviour |
| --- | --- |
| Every card is `FINISHED` or `CLOSED` | Publication proceeds |
| Any card is neither | **Publication is rejected** (HTTP 409, naming how many cards block it). No card is modified, `snapshot_state` does not move, the version pointer does not advance, and nothing becomes publicly visible |

Publication may never `UPDATE tournament_cards`, force a card to `CLOSED`, or change any card's status
by any other route. Preparing a tournament for publication is the operator's job, performed through
the ordinary card workflow; the publisher only ever *observes* that it has been done.

**Why this is the rule.** An earlier draft of §7.2 step 9 had publication force cards `CLOSED`, which
directly contradicted invariant **I4** ("no `DELETE`/`UPDATE` on `tournament_cards` … anywhere in the
pipeline"). I4 wins, for three reasons:

1. **Regenerability (I7).** The moment publication writes to tournament data, "the snapshot is a pure
   function of PostgreSQL" stops being true — publishing would change the very state it derives from,
   so a regenerated snapshot could differ from the one that was published.
2. **A publish that fails must be a no-op.** If step 9 mutated cards, a failure after that point would
   leave the tournament altered by an operation that did not complete.
3. **Publishing is not a workflow transition.** Closing a card is a tournament-management decision with
   its own authorization, audit trail and UI. Smuggling it into a storage operation hides it from all
   three.

Enforced by: the precondition check in `PublicSnapshotState.beginPublishing`; a CI guardrail asserting
no source file under `…application.publicsnapshot` contains a write statement against any tournament
data table; and database-backed tests that digest every card row before and after both a rejected and
a successful publish.

### 7.6 The pointer and the allocator are different numbers (normative)

`tournaments.snapshot_version` is the **pointer** — the version currently served at `s/{h}.json`. It is
written **only** at step 9, after the bytes have been read back and checksum-verified through the public
hostname, so it can never name an object that was not proven to be there.

Version numbers are allocated from the **high-water mark** across `public_snapshot_publications`, not
from the pointer. A failed attempt therefore burns its number permanently instead of letting a later
attempt reuse it. Rolling the pointer backwards on failure — which an earlier implementation did — makes
the next attempt collide with the `FAILED` row the previous one recorded.

### 7.7 Configuration policy (normative)

Snapshot storage configuration has **three** states, and exactly one of them is an error.

| State | Definition | Behaviour |
| --- | --- | --- |
| **ABSENT** | No `app.snapshot-storage.*` value is set | Publication is **disabled**. Spring Boot starts normally, every live feature is unchanged, and snapshot *generation* (the dry-run endpoint) still works because it never touches storage. **Local development and CI need no R2 credentials.** |
| **PARTIAL** | Some values are set, but a required one is missing or invalid | **Invalid — startup fails**, with a message listing every problem at once and naming the exact property keys. Publication is **never** silently disabled in this state. |
| **COMPLETE** | Every required value is set and valid | Publication is **enabled**. |

**Required:** `endpoint`, `access-key-id`, `secret-access-key`, `private-bucket`, `public-bucket`,
`public-origin`.

**Optional, but all-or-nothing:** `cloudflare-zone-id` + `cloudflare-purge-token`. Purging is a latency
optimisation — staleness is bounded by `max-age=300` regardless (§7.4) — so omitting it is a legitimate
choice, whereas half a credential pair is drift.

**Validation beyond presence:** `endpoint` must be an absolute `http(s)` URL; `public-origin` must be an
absolute **https** URL. An http public origin would be blocked as mixed content on the https viewer page,
so every published tournament would silently fall through to the live path — publication would appear to
do nothing at all.

**Why `public-origin` is required rather than optional.** The pipeline verifies every candidate *through
that hostname* before promoting it (§7.2 step 4). Without it, the property the whole design rests on —
"the pointer never names unverified bytes" — cannot be established, so R2 credentials without a public
origin are rejected rather than half-honoured.

**Why PARTIAL fails startup rather than falling back to disabled.** A half-configured deployment that
boots successfully passes its health check, looks healthy, and only reveals the problem when an operator
tries to publish — which is the single worst moment to discover it, because they are part-way through
committing a permanent public artifact. A configuration that cannot be honoured should stop the
deployment, not the publication.

**Blank is absent.** Render and Docker pass empty strings for unset variables, so an empty value counts
as "not set" rather than "set to nothing".

### 7.8 Reconciliation (normative)

The pipeline's last three steps are promote (6), re-verify (8) and commit (9). A process that stops
between 6 and 9 leaves the new bytes public while the database still names the previous version — or
none at all. Nothing notices that on its own, so the design carries an explicit operation that does.

**`verify` and `reconcile` are two operations, not one.** `verify` (§6.5) is a pure read: it fetches
the public object and reports whether it agrees with the database, and it writes nothing at all, so a
monitor may call it on any schedule without the ability to change state. `reconcile` is the operation
that resolves what `verify` reports. Splitting them is deliberate — a detector that can move a
tournament's state is a detector that a transient CDN failure can turn into an outage.

```text
POST /api/admin/tournaments/{id}/public-snapshot/reconcile      (ADMIN)

 0  REFUSE if snapshot_state = RETRACTED
      No repair may resurrect withdrawn data (§4.5). This is checked before the object is even read.

 1  OBSERVE   GET https://{public-origin}/s/{h}.json?verify={uuid}   ← cache-busted
      A transport failure or any status other than 200/404 ⇒ INCONCLUSIVE: report and write nothing.
      Guessing from a failed read would let a network blip mark a healthy tournament failed.

 2  DECIDE
   A  COMPLETE THE COMMIT — the served envelope's version has a row in
      public_snapshot_publications whose recorded checksum equals the served payload's checksum,
      and that version is not older than the pointer.
        → snapshot_state = PUBLISHED, snapshot_version = that version, checksum, published_at;
          the row becomes PROMOTED; audit 'RECONCILE_PUBLIC_SNAPSHOT'.
        → Nothing is uploaded. Those bytes were read back and checksum-verified through the public
          hostname at step 4 before they were promoted, and have just been verified again.
        → When the database already says exactly this, nothing is written at all.

   B  RESTORE THE POINTER'S VERSION — something else is being served (an older version, an
      unrecognised document, or bytes whose checksum matches no recorded row).
        → Re-promote v/{pointer}/payload.json from private history, exactly as rollback does:
          the bytes must exist, must still match the checksum recorded for that version, and must
          read back correctly through the public hostname before the commit.
        → This is the "otherwise re-promote v/{n-1}" branch of §7.3: the pointer does not move, the
          object comes back to it.

   C  REPORT ONLY — nothing is being served, or nothing recorded exists to restore.
        → snapshot_state = PUBLISH_FAILED (§6.5); the pointer and checksum are left alone because
          they record which version was verified, which is what an operator needs. Nothing is
          uploaded and nothing is deleted.

   R  FINISH A RETRACTION — a retraction intent is recorded (§4.5) and has not completed.
        → object gone: snapshot_state = RETRACTED, keeping the ORIGINAL actor's attribution. This
          is the "delete succeeded but the DB commit failed" case, and it is checked before A/B/C
          because a missing object means something entirely different once someone has asked for
          the data to come down.
        → object still there: report it and stop. Repeating the delete is retract's job — a repair
          job must never remove a public object on its own initiative.
```

Five properties are load-bearing, and each one is a test:

1. **It never builds a snapshot.** The only bytes it can write come from private history and must
   match a recorded checksum first, so it cannot publish content that was never approved or verified,
   and it cannot quietly bind newer data to an older version number.
2. **It never deletes the public object.** Withdrawal is retraction (§4.5), an attributable act.
3. **It never re-creates an absent object, and never deletes a present one.** An absent object is
   also what a retraction looks like — which is exactly why §4.5 records its intent before deleting,
   so the two cases are distinguishable rather than guessed at. `regenerate` (§6.3) is the
   deliberate, approval-gated way back from a genuinely lost object.
4. **It never touches tournament data** — the same guardrail as the rest of the package (§7.5, I4).
5. **It is idempotent.** Every branch ends with the database and the public object in agreement or
   with the divergence recorded, so a second run observes that and writes nothing.

**Reconciliation is not an approval bypass** (§4.3). It cannot publish anything new: property 1 above
means the only bytes it can move are ones a publication already staged, verified through the public
hostname, and recorded — and that publication could only have claimed its version with a live approval
in the first place. Completing an interrupted commit finishes an act that was authorized when it began;
it does not begin an unauthorized one. This is why the reconciler deliberately does not consult the
approval table: an approval that has since expired must not strand a version whose bytes are already
public and already correct.

**It is also the recovery path for a stuck `PUBLISHING`.** `PUBLISHING` is set under the row lock in
step 0 and is what excludes a concurrent attempt; a process that dies mid-pipeline therefore leaves a
tournament that refuses every later publish. Reconciliation resolves it from evidence rather than
from a clock — there is no timeout anywhere in this design, and `PUBLISHING` is never assumed to have
succeeded. When the public object proves the attempt promoted its bytes, branch A completes it; when
nothing was ever public, the state becomes `PUBLISH_FAILED`, which is precisely what the pipeline's
own failure path would have recorded had the process survived to run it.

**Version allocation across a crash.** §7.6's rule is that numbers come from the high-water mark
across `public_snapshot_publications`. An attempt that dies *before* step 5 records no row, so its
number is handed out again — which is correct: nothing public ever named it, nothing references the
private objects it may have written under `v/{n}/`, and no row exists for a later attempt to collide
with. What must never be reused is a number some bytes were *recorded* under, and that is exactly
what the high-water mark prevents.

**Concurrency.** Reconciliation takes no lock, and does not need one. Its writes are the same commit
the publisher performs, with the same values, so a reconcile that interleaves with a live publish
either writes what the publisher is about to write, or restores the pointer's version and thereby
fails that publisher's step-8 re-verify — which lands in the publisher's ordinary failure path, with
the previous object still serving. There is no interleaving that promotes unverified bytes.

The same reasoning covers **rollback**, which is likewise unlocked and deliberately has no failure
bookkeeping: it allocates no version, and its commit is its last step, so a rollback that fails at any
point leaves the pointer exactly where it was and is simply retryable. Its one observable half-state —
the object replaced with `v/{n-1}` while the pointer still says `n`, because the read-back failed
between them — is a divergence like any other, and reconciliation resolves it by restoring the
pointer's version. An operator who meant to roll back runs rollback again; the invariant that holds
throughout is the one that matters, that `s/{h}.json` only ever contains bytes some version was
verified with.

---

## 8. Final Architecture

```text
FINAL ARCHITECTURE — CT-WE Public Snapshot
==========================================

                        ┌───────────────────────────────────────┐
                        │       Browser   /tour/{slug}          │
                        └──┬──────────────┬─────────────────┬───┘
      page shell + assets  │              │ ① probe/read    │ ③ live data + SSE
      (unchanged)          ▼              ▼   (published)   ▼   (not published)
        ┌────────────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
        │ Cloudflare Worker      │  │ Cloudflare CDN   │  │ Render / Spring Boot │
        │ OpenNext — UNCHANGED   │  │ snapshot.ct-     │  │ /api/public/**  +SSE │
        │ shells + staff proxy   │  │      we.com      │  │      UNCHANGED       │
        └────────────────────────┘  │        │         │  └──────────┬───────────┘
                                    │        ▼         │             │
                                    │ R2 PUBLIC bucket │             ▼
                                    │  s/{h}.json      │   ┌───────────────────┐
                                    │  (1 object per   │   │ Neon PostgreSQL   │
                                    │   published      │   │ SOURCE OF TRUTH   │
                                    │   tournament)    │   └─────────┬─────────┘
                                    └──────────────────┘             │
                                             ▲                       │
                                             │ promote (verified)    │ ② publish pipeline
                                    ┌────────┴─────────┐             │    (read-only SELECTs)
                                    │ R2 PRIVATE bucket│◄────────────┘
                                    │ t/{uuid}/v/{n}/  │   S3 API + SigV4
                                    │ full history     │   credentials ON RENDER ONLY
                                    │ never public     │
                                    └──────────────────┘

  /tour/A  PUBLISHED  →  Worker shell + CDN            (0 Render, 0 Neon, 0 SSE)
  /tour/B  LIVE       →  Worker shell + Render + Neon  (identical to today)
  /tour/C  LIVE       →  Worker shell + Render + Neon  (identical to today)
  /tour/D  PUBLISHED  →  Worker shell + CDN            (0 Render, 0 Neon, 0 SSE)
```

---

## 9. Final Request Flows

### LIVE (not published) — identical to today plus one edge-cached probe

```text
Browser                 CF edge              Worker            Render          Neon
   │                       │                   │                 │              │
   ├─ GET /tour/{slug} ────┼──────────────────►│ SSR shell       │              │
   │◄──────────── document (cached 300 s) ─────┤                 │              │
   │                       │                                     │              │
   ├─ GET /s/{h}.json ────►│ 404 (edge HIT, never reaches R2)     │              │
   │◄─ 404, max-age=60 ────┤                                      │              │
   │                       │                                                     │
   ├─ GET /api/public/tournaments/{token}/bundle ───────────────►│──cache hit──►│
   │◄──────────────── bundle + ETag ─────────────────────────────┤              │
   ├─ GET /api/public/realtime-config ──────────────────────────►│              │
   ├─ SSE /api/public/tournaments/{token}/events ───────────────►│  (held open) │
   │◄──────────── card-summary / result / pairings / publish ────┤              │
   │                                                                             │
   └─ switch card = #card=<uuid>  → ZERO requests                                │

   Δ vs today:  +1 edge request, +0 Render, +0 Neon, +0 Worker CPU
```

### PUBLISHED — Render and Neon are never contacted

```text
Browser                 CF edge / R2 public
   │                       │
   ├─ GET /tour/{slug} ────┼──► Worker: SSR shell (cached 300 s)
   │◄───── document ───────┤
   │                       │
   ├─ GET /s/{h}.json ────►│ 200  (edge HIT; on miss, one R2 GET)
   │◄─ full tournament ────┤      envelope{version, checksum, generatedAt} + payload{…cards}
   │
   ├─ hydrate store  → no SSE, no polling, no realtime-config, no push subscription
   └─ switch card = #card=<uuid>  → ZERO requests

   Render: 0     Neon: 0     Worker: shell only     SSE: none
```

### PUBLISH

```text
Director/Admin        Spring Boot (Render)       Postgres      R2 private   R2 public   CF
    │                        │                       │             │           │        │
    ├─ APPROVE (pwd + ack) ─►│── INSERT approval ───►│             │           │        │
    │                        │                                                          │
    ├─ PUBLISH ─────────────►│ 0 lock row, check approval + fingerprint                  │
    │                        │ 1 BUILD  ──read-only REPEATABLE_READ──►│                  │
    │                        │ 2 VALIDATE (schema, counts, forbidden fields, size)       │
    │                        │ 3 PUT v/{n}/… ───────────────────────►│                  │
    │                        │ 4 PUT staging ──────────────────────────────────►│       │
    │                        │   GET staging THROUGH snapshot.ct-we.com ────────┼──────►│
    │                        │   verify sha256 + parse + version                        │
    │                        │ 5 INSERT publication row (VERIFIED)   │                  │
    │                        │ 6 ⚛ PUT s/{h}.json ─────────────────────────────►│       │
    │                        │      ══ public traffic switches here ══                  │
    │                        │ 7 purge ────────────────────────────────────────┼──────►│
    │                        │ 8 GET s/{h}.json, assert version == n ──────────┼──────►│
    │                        │ 9 COMMIT state=PUBLISHED + audit ────►│                  │
    │◄── result ─────────────┤ 10 delete staging (best effort)                           │
    │
    Any failure at 1–5  → nothing public changed; state=PUBLISH_FAILED
    Failure at 9        → reconciler completes or re-promotes v{n-1}
```

### RETRACT

```text
Director/Admin        Spring Boot            R2 public        CF          Postgres
    │                      │                     │             │             │
    ├─ RETRACT ───────────►│ authorize (admin or director of this tournament) │
    │                      │ DELETE s/{h}.json ─►│                            │
    │                      │ purge by URL ───────┼────────────►│             │
    │                      │ state = RETRACTED, retracted_by/at ────────────►│
    │                      │ audit 'RETRACT_PUBLIC_SNAPSHOT' ──────────────►│
    │◄── result ───────────┤
    │
    Effect:  new requests → 404 → client falls through to the LIVE path,
             which re-applies the server-side status gate (CLOSED ⇒ 404 ⇒ "link dead")
    Private history retained (never was public).  Re-publication requires a NEW approval.
    ⚠️ Copies already downloaded cannot be recalled.
```

---

## 10. Final Invariants (non-negotiable)

| # | Invariant | Enforced by |
| --- | --- | --- |
| **I1** | **A published tournament's viewer traffic never requires Render or Neon.** | Discovery resolves at the CDN (§2.3); the payload is self-contained; no SSE, polling, or config call is issued when published |
| **I2** | **Live tournaments behave exactly as today.** Same URL, same endpoints, same SSE, same deltas, same headers, same UI. | The live path is untouched; the only addition is one edge-cached probe that fails open (§2.1, §2.3) |
| **I3** | **PostgreSQL is the sole source of truth; R2 is a derived cache.** | The pipeline runs read-only `SELECT`s against tournament data and writes only its own bookkeeping (§6.1) |
| **I4** | **The publication process never modifies PostgreSQL tournament data** — not by deleting it, and not by updating it. | No `DELETE`/`UPDATE`/`INSERT` on `tournament_cards`, `players`, `matches`, `standings`, `pairing_snapshots`, `games`, `table_seats`, `final_*` anywhere in the pipeline. `FINISHED`/`CLOSED` is a **precondition**, never an effect (§7.5). Enforced by a CI guardrail over the `…publicsnapshot` package and by database-backed before/after row digests; G1 additionally blocks the *other* feature from deleting while published (§5.3) |
| **I15** | **Snapshot configuration is ABSENT (disabled), COMPLETE (enabled), or invalid — never partially honoured.** | §7.7. A PARTIAL configuration fails startup rather than silently disabling publication; ABSENT leaves every live feature and all local development unaffected |
| **I5** | **Public users can never write or delete a snapshot.** | The public bucket is exposed through a custom domain that serves `GET`/`HEAD` only; no signed-upload path exists; no write route is reachable from the browser (§7.1) |
| **I6** | **R2 credentials never reach the frontend, the Worker, or the browser.** | Credentials live only in Render env (`sync: false`), read only by `SnapshotObjectStore`; never `NEXT_PUBLIC_*`; the Worker gets no R2 binding (§7, §5.2) |
| **I7** | **Every published snapshot is regenerable from PostgreSQL.** | Deterministic canonical generation (§6.2) + `regenerate` (§6.3); protected by G1 (§5.3) |
| **I8** | **Publication is explicit, attributable, and never automatic.** | Default `NOT_PUBLISHED`; approval record with password re-auth, typed acknowledgment, expiry, and content fingerprint (§4.1–4.4) |
| **I9** | **Retraction is always possible and easier than publication** — while acknowledging that already-downloaded copies cannot be recalled. | Any admin or tournament director may retract with no approval; one `DeleteObject` + purge removes the entire public surface; `max-age=300` bounds browser staleness; the irreversibility is stated in the approval text (§4.4, §4.5) |
| **I10** | **Publishing, republishing, retracting, or failing for one tournament affects no other.** | One object key, one row, one prefix, one lock per tournament; no shared manifest, no shared deploy, no zone-config write (§2.2 rejects option B and F on exactly this ground) |
| **I11** | **Excel Export & Purge remains entirely separate from Public Snapshot.** | Distinct packages, classes, methods, HTTP namespaces, audit actions, UI panels, and Thai wording; plus G1 (runtime block) and G2 (CI test) (§5) |
| **I12** | **No public request ever triggers a database query for discovery.** | The key is derived in the browser from the URL (§3.4); no lookup, no manifest, no origin call on the published path |
| **I13** | **A snapshot is never visible in a partial or torn state, and the previous valid snapshot is never removed before its replacement is verified.** | Single self-contained public object; verified at a staging key through the real hostname before a single atomic `PutObject` promotes it (§7.2, §7.3) |
| **I14** | **The `access_token` is documented as a public routing identifier, not a secret**, and nothing in this design treats a derived path as an access control. | §3.2, §3.5; the caveat is required verbatim in the key-derivation Javadoc |

---

## 11. Residual Risks and Remaining Open Items

| # | Item | Status |
| --- | --- | --- |
| R1 | Snapshot payload drifts from the live projection when a field is added | Mitigated: CI equality test (§12) is the gate; schema version pinned |
| R2 | Probe adds measurable latency on the live path | Mitigated (§2.4); **must be measured before cutover** (§2.5); documented fallback is Worker routing |
| R3 | Permanent public exposure of minors' names and schools | Made explicit, not solved: two-step approval, typed acknowledgment, easy retraction, honest SLA (§4). **Needs organizer/legal sign-off before the first real publication** |
| R4 | `crypto.subtle` unavailable (non-HTTPS context) | Production is HTTPS-only; local dev leaves `NEXT_PUBLIC_SNAPSHOT_ORIGIN` unset, so the probe never runs |
| R5 | Purge failure serves a stale snapshot | Bounded by `max-age=300`; detected by step 8 and by drift detection |
| **O1** | Does a `ROLE_DIRECTOR` get publish rights, or admin-only? Design assumes director-or-admin (§4.2) | **Partly decided (Phase E).** The §4.2 rule — ADMIN or director-of-this-tournament, staff never — is implemented and tested in `SnapshotApprovalService`. The HTTP routes remain `/api/admin/**`, so no director can reach them yet. Opening the surface is one `requestMatchers` line plus director UI, and remains a **decision needed** |
| **O2** | Approval expiry (7 days) and size ceiling (8 MB) are proposals | **Built as proposed.** Expiry is `SnapshotApprovalService.VALIDITY` = 7 days, asserted against the stored interval; the 8 MB ceiling is unchanged in the validator. Both are single constants, so adjusting either stays a one-line change |
| **O3** | `GET /api/public/tournaments` enumerates every OPEN tournament's `access_token` anonymously and has **no frontend caller** (Finding A) | **Independent hardening opportunity** — remove the endpoint, or drop `accessToken` from its response. Not part of this design; flagged because it materially shapes §3 |
| **O4** | `archiveAndDelete` has no password re-auth (Finding C) | Folded into G3, but worth fixing regardless of this project |
| **O5** | Optional `publish_until` scheduled auto-retraction for youth events | Deferred |
| **O6** | Retention policy for private `v/{n}` history | Proposal: keep indefinitely (objects are small) |

---

## 12. Implementation Phases (updated)

```text
Phase 0  NAMING + GUARDRAILS FIRST  (no new feature code)
         · Rename TournamentArchiveService → TournamentExcelExportService,
           archiveAndDelete → exportToExcelAndPurgeLiveData, move to …application.excelexport
         · Add PurgeConfirmation typed request + password re-auth (G3 / Finding C / O4)
         · Add G2 CI package-independence test (asserts nothing yet, then stays true forever)
         · Update Thai UI copy per §5.1
         GATE: existing Excel export + purge behaves identically; HTTP paths unchanged

Phase 1  SNAPSHOT BUILDER + VALIDATOR   (no storage, no client impact)
         · V31 migration: snapshot_state / snapshot_version / published_at
           + public_snapshot_publications + public_snapshot_approvals
         · PublicSnapshotBuilder with its own canonical ObjectMapper (§6.2)
         · PublicSnapshotValidator (§7.2 step 2)
         · Admin dry-run endpoint: returns the payload WITHOUT uploading
         · CI GOLDEN TEST: payload ≡ GET /api/public/tournaments/{t}/bundle, modulo
           the envelope and the omitted accessToken
         GATE: byte-level equality proven; determinism proven (two runs, same digest)

Phase 2  APPROVAL WORKFLOW  (still no publishing)
         · Approval record, password re-auth, typed acknowledgment, expiry, content fingerprint
         · Admin/director UI: state badges, approve/revoke, close-tournament prompt (§4.6)
         GATE: approval cannot be bypassed; fingerprint invalidation works

Phase 3  STORAGE + PIPELINE  (no client impact)
         · Provision both buckets, snapshot.ct-we.com, CORS, Cache Rules (incl. 404 caching),
           scoped R2 token, scoped purge token
         · SnapshotObjectStore + CachePurgeClient + PublicSnapshotPublisher (§7.2)
         · Guardrail G1 wired: purge refuses while PUBLISHED
         · publish / retract / regenerate / verify + reconciler
         GATE: a snapshot is publicly fetchable and checksum-verified end to end;
               retraction removes it within the stated SLA

Phase 4  CLIENT RESOLUTION  (flag off by default)
         · NEXT_PUBLIC_SNAPSHOT_ORIGIN + key derivation + probe with all four mitigations
         · store: static-first resolution, envelope unwrap, token from URL
         · SSE/polling/push disabled when published; published badge; 404 disambiguation
         · CSP connect-src += snapshot origin
         GATE: §2.5 measurements pass — live p95 within budget, published path issues
               ZERO Render requests

Phase 5  CUTOVER
         · One canary tournament, with organizer sign-off (R3)
         · Then backfill finished tournaments one at a time, verifying each
         · Watch Render request rate, Caffeine hit ratio, SSE counts, Neon compute
         GATE: measured load drop with no viewer-visible change

Phase 6  (Deferred, separate decision)
         · publish_until auto-retraction · reduced-PII profile (only if ever required)
         · Live-row purge for published tournaments — BLOCKED by G1 and I7 unless the
           regeneration invariant is explicitly abandoned. Not recommended.
```

---

## 13. Testing Additions Specific to v2

Beyond v1's suite:

- **Key derivation parity:** the Java and TypeScript implementations of
  `base32(sha256("ctwe-public-snapshot-v1|" + token))` produce identical output for a shared fixture
  vector, including legacy 32-hex tokens and maximum-length slugs. A mismatch here silently makes every
  snapshot unreachable, so this is a CI-blocking test on both sides.
- **Determinism:** build the same tournament twice → identical `sha256`. Then flip
  `jackson.default-property-inclusion` in a test profile and assert the snapshot digest is **unchanged**
  (proves the dedicated ObjectMapper is genuinely isolated).
- **Approval binding:** publish must fail when the approval is expired, when it belongs to another
  tournament, and when any card's `public_version` changed after approval.
- **Retraction completeness:** after retract, `GET s/{h}.json` is 404, the client falls through to the
  live path, and a `CLOSED` tournament then renders the existing "link dead" state.
- **No-resurrection:** `regenerate` on a `RETRACTED` tournament is rejected.
- **G1:** Excel purge is rejected while `PUBLISHED` and accepted after retraction.
- **G2:** package-independence test fails if either package imports the other.
- **Atomicity:** kill the process between steps 6 and 9; the reconciler converges to a consistent state
  and the public object is never partial.
- **Isolation:** publish/retract tournament A under concurrent live load on B; assert B's request
  pattern, ETags, and SSE stream are unaffected.

---
---

# PART II — Backend Zero-Compute / No-Active-Tournament Mode

**Scope:** make the Spring Boot compute lifecycle *optional* when no tournament is being organized.
**Explicitly out of scope:** Part I. The published-snapshot path already has no Render/Neon dependency
and is not redesigned here. Part II only removes the *compute* when nothing is live.

---

## 14. Verified Deployment Facts

### 14.1 Repository-verified (authoritative — read from this repo)

| Fact | Source |
| --- | --- |
| Service type `web`, runtime `docker`, plan **`starter`** | [render.yaml](../render.yaml) |
| Health check path `/actuator/health/readiness` | [render.yaml](../render.yaml) |
| `maxShutdownDelaySeconds: 30`; `server.shutdown: graceful`; `timeout-per-shutdown-phase: 25s` | [render.yaml](../render.yaml), [application.yml](../backend/src/main/resources/application.yml) |
| Start command is the image `ENTRYPOINT ["java","-jar","/app/app.jar"]`; no wrapper script | [backend/Dockerfile](../backend/Dockerfile) |
| Deploy trigger is Render's Blueprint git integration; **no deploy automation exists in this repo** — [ci.yml](../.github/workflows/ci.yml) only runs lint/typecheck/build/test | `.github/workflows/` |
| Database is **Neon**, not Render Postgres | [DEPLOYMENT_FREE_TIER.md](../DEPLOYMENT_FREE_TIER.md) §2 |
| Flyway runs on every boot (`spring.flyway.enabled: true`), V1→V30 | application.yml |
| `bootstrapStaffAccount` `ApplicationRunner` validates `STAFF_USERNAME`/`STAFF_PASSWORD_HASH` at boot and **throws `IllegalStateException` if malformed** — i.e. env drift becomes a failed start | [SecurityConfiguration:48](../backend/src/main/java/com/ctwe/tournament/infrastructure/security/SecurityConfiguration.java#L48) |
| Two `@Scheduled` jobs exist: SSE heartbeat (5 s tick) and a 24 h web-push cleanup | [CardEventPublisher:267](../backend/src/main/java/com/ctwe/tournament/application/CardEventPublisher.java#L267), [WebPushService:419](../backend/src/main/java/com/ctwe/tournament/application/WebPushService.java#L419) |
| **Neither scheduled job requires the backend to stay alive between tournaments.** The heartbeat only prunes live SSE sockets (none exist when idle); push cleanup is a housekeeping sweep that is safe to skip and runs on next boot | same |
| **SSE requires the backend alive only while a tournament is live.** Published snapshots issue no SSE (Part I, I1) | §2.3, `use-public-sync.ts` |
| **The proxy already fails safe:** `proxyToRender` catches connection failure and returns HTTP 503 `{"message":"Backend service is unavailable"}` with `Cache-Control: no-store` | [render-backend-proxy.ts:87](../src/infrastructure/http/render-backend-proxy.ts#L87) |
| **The store already degrades gracefully:** `load()` catches and sets `error: "ไม่สามารถเชื่อมต่อ API ได้"`, `loading: false` — no crash, no infinite spinner | [store.ts:641](../src/application/tournament/store.ts#L641) |
| Anonymous visitors with no `CTWE_STAFF` cookie hint **never call `/api/auth/me`**, so an OFF backend costs them nothing on the viewer path | [store.ts:609](../src/application/tournament/store.ts#L609) |
| ⚠️ Hikari `connection-timeout: 5000` with `DB_POOL_MIN_IDLE: 0` | application.yml, render.yaml |

### 14.2 Provider-verified (external documentation — re-confirm on your account before relying on it)

| Question | Verified answer | Source |
| --- | --- | --- |
| Can a Render web service be suspended? | Yes — from the dashboard (including in bulk) and via the REST API | [Render changelog](https://render.com/changelog/suspend-and-resume-services-in-bulk-from-the-render-dashboard) |
| Does suspending stop compute billing? | Yes — suspending a service stops billing for that resource | [Render changelog](https://render.com/changelog/suspend-and-resume-services-in-bulk-from-the-render-dashboard) |
| Suspend API | `POST /services/{serviceId}/suspend`, Bearer token in `Authorization` | [Render API — suspend](https://api-docs.render.com/reference/suspend-service-1) |
| Resume API | A resume endpoint exists: *"Resume the service with the provided ID (if it's currently suspended)"* | [Render API index](https://api-docs.render.com/llms.txt), [resume](https://api-docs.render.com/reference/resume-service-1) |
| Does the paid **Starter** plan scale to zero on its own? | **No.** Automatic spin-down is a *Free* instance behaviour, not a Starter one | [Render free docs](https://render.com/docs/free) |
| Free instance behaviour | Spins down after **15 minutes** without traffic; spins back up on the next request, taking **about one minute**; 750 free instance-hours/month; spun-down services don't consume hours | [Render free docs](https://render.com/docs/free) |
| Free Render Postgres | Expires 30 days after creation, then a 14-day grace period | [Render free docs](https://render.com/docs/free) |

**Conclusion on mechanism.** Render offers no scale-to-zero for the current Starter plan, so
"zero compute when idle" must be achieved by **explicitly suspending and resuming the service**
(dashboard or API). This is a deliberate operator action, not an automatic behaviour — which suits a
tournament system whose activity is scheduled, not organic.

> ⚠️ **Verify before implementing:** confirm on your own Render workspace that (a) suspend/resume are
> available for your plan and region, (b) the billing behaviour matches the changelog for your
> account, (c) the exact API base URL and the resume path in the current API reference, and (d) the
> scope of a Render API key (if keys are workspace-wide, treat one as a high-value secret — §26).

### 14.3 Rejected alternative: downgrade Starter → Free instead of suspending

Free instances scale to zero automatically, which sounds ideal. Rejected because:

- **~1 minute cold start on the first request.** During an event that is a mid-tournament stall; the
  spin-down timer is 15 minutes of no traffic, which a quiet moment between rounds can reach.
- **The capacity work assumes Starter or better.** [load-testing/README.md](../load-testing/README.md)
  and [EVENT_CAPACITY_RUNBOOK.md](EVENT_CAPACITY_RUNBOOK.md) size the instance from measured CPU/RSS;
  Free is not in that envelope.
- **750 instance-hours/month** is a second ceiling to manage.

Free tier is not a substitute for a live event. **Suspend/resume of the existing Starter service is
the right lever**, with plan changes (Starter ↔ Standard for a big event) as an orthogonal decision.

---

## 15. What Zero-Compute Mode Is — and Is Not

```text
IS:      no paid Spring Boot compute while no tournament is being organized
IS NOT:  $0 total infrastructure  (see §24 — this claim would be false)
IS NOT:  a change to how published snapshots are served (Part I already handles that)
IS NOT:  a security control (Spring Boot's own authorization remains the boundary — §26)
```

The enabling precondition is Part I: once finished tournaments are published to R2, **the backend has
no readers left between events**. Without Part I, switching the backend off would take historical
results offline. With it, the backend becomes what it should be — an *organizing tool* that runs
during events, not a permanent public-content server.

---

## 16. Backend Lifecycle State Machine

```text
        ┌──────────────────────────────────────────────────────────────────┐
        │                                                                  │
        ▼                                                                  │
┌───────────────────┐   operator dispatches START                          │
│ NO_ACTIVE_        │──────────────────────────────┐                       │
│ TOURNAMENT (OFF)  │                              ▼                       │
│ Render: SUSPENDED │                    ┌──────────────────┐              │
└───────────────────┘                    │ BACKEND_STARTING │              │
        ▲                                │ resume + readiness gate §22     │
        │                                └────────┬─────────┘              │
        │ suspend confirmed                       │ all gates pass         │
┌───────┴───────────┐                             ▼                        │
│ BACKEND_STOPPING  │                    ┌──────────────────┐              │
│ POST /suspend     │                    │  BACKEND_READY   │              │
└───────▲───────────┘                    │ up, 0 tournaments│              │
        │ external verification passed   └────────┬─────────┘              │
┌───────┴───────────┐                             │ admin creates/opens    │
│    DRAINING       │                             ▼          a tournament  │
│ 0 active, all     │◄──────────────────┐ ┌──────────────────┐             │
│ snapshots verified│  last tournament  └─│ TOURNAMENT_ACTIVE│─────────────┘
└───────────────────┘  published          │ ≥1 active        │  more created
                                          └──────────────────┘
        gate: active_tournament_count = 0  AND  every published snapshot
              verified from OUTSIDE the backend (§19.3)
```

### 16.1 Request matrix

```text
NO_ACTIVE_TOURNAMENT (OFF)          BACKEND_STARTING
--------------------                ----------------
Public snapshots:      YES          Public snapshots:      YES
Live tournament API:   NO           Live tournament API:   NO  (gate not yet open)
Login:                 NO           Login:                 NO  (UI gated; see §21 caveat)
Admin/Director API:    NO           Admin/Director API:    NO  (UI gated)
Staff API:             NO           Staff API:             NO
SSE:                   NO           SSE:                   NO
Spring Boot:           OFF          Spring Boot:           BOOTING
Neon:                  idle         Neon:                  waking

BACKEND_READY                       TOURNAMENT_ACTIVE
-------------                       -----------------
Public snapshots:      YES          Public snapshots:      YES
Live tournament API:   YES (empty)  Live tournament API:   YES
Login:                 YES          Login:                 YES
Admin/Director API:    YES          Admin/Director API:    YES
Staff API:             YES          Staff API:             YES
SSE:                   YES (idle)   SSE:                   YES
Spring Boot:           ON           Spring Boot:           ON

DRAINING                            BACKEND_STOPPING
--------                            ----------------
Public snapshots:      YES          Public snapshots:      YES
Live tournament API:   YES (read)   Live tournament API:   NO
Login:                 YES (admin)  Login:                 NO
Admin/Director API:    YES          Admin/Director API:    NO
Staff API:             read-only    Staff API:             NO
SSE:                   YES          SSE:                   closing (graceful, ≤25 s)
Spring Boot:           ON           Spring Boot:           SHUTTING DOWN
```

`DRAINING` is deliberately permissive: it is a *review* window in which the operator can still log in
and confirm every snapshot before the irreversible suspend. It is not a lockdown.

---

## 17. Control Plane

### 17.1 Requirements

1. Must not depend on Spring Boot (Spring Boot may be OFF).
2. Must not query PostgreSQL per request.
3. Must not query the Render API per request (rate limits, latency).
4. Must be authorizable when the application's own login is unavailable.
5. Smallest reliable mechanism.

### 17.2 Options evaluated

| Option | New service | Works while backend OFF | Auth when backend OFF | Audit | Verdict |
| --- | --- | --- | --- | --- | --- |
| **R2 `system/state.json` + GitHub Actions `workflow_dispatch` + Render API** | **none** (reuses Part I's bucket) | ✅ | ✅ GitHub repo permissions | ✅ Actions run log + audit | ✅ **Recommended** |
| Cloudflare KV + Worker gate | KV binding + Worker code | ✅ | needs a new shared secret | weak | ⚠️ Adds Worker CPU on the shared path; duplicates what R2 already provides |
| Cloudflare D1 | D1 database | ✅ | new secret | weak | ❌ A database to track one enum |
| Render API polled by the frontend | none | ✅ | ❌ would need an API key in the browser | none | ❌ Non-starter |
| Manual Render dashboard only | none | ✅ | ✅ Render account | Render's own log | ⚠️ Keep as the always-available **fallback**, but it performs no health verification and no snapshot gate |
| Spring Boot self-shutdown | none | ❌ **cannot start itself** | — | — | ❌ Fails requirement 1 |

### 17.3 Recommended control plane

```text
DESIRED STATE + ORCHESTRATION   →  GitHub Actions (workflow_dispatch, manual trigger)
                                   · holds RENDER_API_KEY + R2 credentials as repo secrets
                                   · concurrency group = built-in mutual exclusion (§23-G)
                                   · run log = free audit trail
                                   · authorization = repo write access

EFFECTOR                        →  Render REST API  POST /services/{id}/{suspend|resume}

PUBLISHED STATE (for humans+UI) →  R2 public bucket, key  system/state.json
                                   { state, since, message, activeTournamentsAtLastCheck }
                                   Cache-Control: public, max-age=30   (purged on write)
                                   SINGLE WRITER: the workflow. No write races.

ACTUAL STATE (ground truth)     →  Render API service status  +  /actuator/health/readiness
                                   Reconciled by the workflow, never polled per request.

FALLBACK                        →  Render dashboard suspend/resume (always available)
```

**No Worker code change is required.** The Worker keeps serving page shells and proxying staff
traffic; `proxyToRender` already returns a clean 503 when the backend is unreachable (§14.1). The
state file only improves *messaging*, never *enforcement*.

### 17.4 Namespace separation from Part I

`system/state.json` lives under the `system/` prefix; published snapshots live under `s/`. Retracting a
snapshot (`DELETE s/{h}.json`) is unaffected, so Invariant I9's "one `DeleteObject` removes the entire
public surface *for that tournament*" still holds exactly.

### 17.5 The state file is never a security control

> `system/state.json` says what the operator *intends*. It cannot prevent anything. If it says `OFF`
> while Spring Boot is actually running, every endpoint is still live and still protected by Spring
> Security exactly as today. Hiding the login form is UX, not authorization.

Same principle as the key-derivation caveat in §3.5. This sentence belongs in the file's own schema doc.

---

## 18. Start Workflow

```text
START  (GitHub Actions › "Start Tournament System" › Run workflow)

  operator                Actions              Render API        Spring Boot      Neon        R2
     │                       │                      │                 │            │          │
     ├─ dispatch ───────────►│                                                                 │
     │                       ├─ write state=STARTING ──────────────────────────────────────►│
     │                       ├─ (optional) wake Neon with a trivial query ─────────────►│     │
     │                       ├─ POST /services/{id}/resume ──►│                              │
     │                       │                                 ├─ pull image, boot JVM       │
     │                       │                                 ├─ Flyway validate/migrate ──►│
     │                       │                                 ├─ bootstrapStaffAccount      │
     │                       │                                                                │
     │                       ├─ POLL readiness gate §22 (timeout 10 min, backoff)             │
     │                       │    1 GET /actuator/health/readiness            == UP           │
     │                       │    2 GET /api/public/cards/versions            == 200 + JSON   │
     │                       │    3 POST /login with junk creds               == 401 (not 5xx)│
     │                       │    4 GET  /api/admin/tournaments (no session)  == 401          │
     │                       │    5 GET  {WORKER}/api/auth/me via the Worker  == 200/401,     │
     │                       │                                                  NOT 503       │
     │                       │                                                                │
     │                       ├─ all pass ─► write state=READY ─────────────────────────────►│
     │                       ├─ any fail  ─► POST /suspend, write state=OFF + failure reason │
     │◄─ run summary ────────┤                                                                │
     │
     └─ open /staff-login → log in → create tournament → LIVE
```

### 18.1 Can this be automated? Yes — and it should be, except the trigger

| Step | Automated? | Why |
| --- | --- | --- |
| Resume the service | ✅ Render API | Deterministic |
| Wake Neon | ✅ trivial query before resume | Removes the Hikari 5 s timeout hazard (§22.2) |
| Health + DB + auth verification | ✅ steps 1–5 above | Machine-checkable; far more reliable than a human eyeballing a dashboard |
| Flip state to READY | ✅ | Single writer |
| **Deciding to start at all** | ❌ **manual `workflow_dispatch`** | Starting costs money and re-exposes login/admin. That should be a deliberate, attributable human act, not a timer |
| Login, create tournament | ❌ human | Requires staff credentials, which must not live in CI |

**Do not add a scheduled auto-start.** A cron that resumes the backend "just in case" re-creates the
cost the design exists to remove and re-exposes the admin surface unattended. The one defensible
scheduled variant is a *reminder* (an issue or notification the day before a planned event), not an
automatic resume.

### 18.2 Verification step 5 is not redundant

Steps 1–4 hit Render directly. Step 5 goes through the **Cloudflare Worker proxy**, which is the path
staff browsers actually use. It catches a class of failure the direct checks cannot: `BACKEND_URL`
drift on the Worker, DNS, or a Worker deploy that lost its runtime variable. The system is not READY
until the path real users take is proven.

---

## 19. Stop Workflow

```text
STOP  (GitHub Actions › "Stop Tournament System" › Run workflow)

  operator              Actions           Spring Boot        R2 / CDN         Render API
     │                     │                   │                  │               │
     ├─ dispatch ─────────►│                                                       │
     │                     ├─ GET /api/admin/system/shutdown-readiness ─►│         │
     │                     │◄─ { activeTournamentCount,                            │
     │                     │     unpublishedFinished[],                            │
     │                     │     publishedSnapshots:[{tournamentId,h,version,sha}]} │
     │                     │                                                       │
     │                     ├─ ABORT if activeTournamentCount > 0                    │
     │                     ├─ ABORT if unpublishedFinished is non-empty             │
     │                     │                                                        │
     │                     ├─ EXTERNAL VERIFICATION (§19.3) — for EVERY snapshot:    │
     │                     │    GET https://snapshot.ct-we.com/s/{h}.json ──►│      │
     │                     │    assert 200, envelope.version, sha256 match          │
     │                     ├─ ABORT on any mismatch                                 │
     │                     │                                                        │
     │                     ├─ write state=DRAINING ──────────────────►│             │
     │                     ├─ (optional) operator confirmation window               │
     │                     ├─ write state=STOPPING                                  │
     │                     ├─ POST /services/{id}/suspend ─────────────────────────►│
     │                     │      graceful shutdown: ≤25 s phase, ≤30 s Render delay │
     │                     ├─ POLL Render service status == suspended                │
     │                     ├─ CONFIRM  GET /actuator/health/readiness is unreachable │
     │                     ├─ write state=OFF ───────────────────────►│              │
     │◄─ run summary ──────┤                                                         │
```

### 19.1 `active_tournament_count` — precise definition

```sql
-- illustrative; belt-and-braces so a mis-marked tournament can never authorize a shutdown
SELECT count(*) FROM tournaments t
WHERE t.lifecycle <> 'SETTLED'
   OR EXISTS (SELECT 1 FROM tournament_cards c
              WHERE c.tournament_id = t.id
                AND c.status NOT IN ('FINISHED','CLOSED'));
```

`lifecycle = 'SETTLED'` means either `snapshot_state = 'PUBLISHED'`, or the tournament was explicitly
**shelved** by an admin ("this will never be published"). Shelving is required so a tournament that is
finished but deliberately unpublished cannot block shutdown forever.

**As built (V34), normative.** There is no `lifecycle` column; settled is derived, exactly as above:
`snapshot_state = 'PUBLISHED' OR shelved_at IS NOT NULL`. Four consequences worth stating, because
each one keeps the gate shut in a case where it would be tempting to open it:

- **`RETRACTED` is not settled.** Withdrawn results are not public, so the tournament's only readable
  copy is inside the backend that is about to be switched off. An operator must decide explicitly —
  by shelving it — that this is acceptable. `PUBLISH_FAILED` is not settled for the same reason.
- **Cards in play outrank any settled marking.** The second clause is evaluated for every tournament,
  including published and shelved ones, so a mis-marked tournament still counts as active while any
  card is unfinished. Shelving records an intention about publication; a card in play is a fact about
  the present, and the fact wins.
- **Shelving is reversible and attributed** (`shelved_by`, and a `SHELVE_TOURNAMENT` audit entry). An
  irreversible flag set from one console click would be a worse trade than the problem it solves.
  Re-shelving keeps the first decision and writes no second audit row.
- **A published tournament cannot be shelved.** It is already settled by publication, and accepting
  the flag as well would blur what shelving means.

The second clause is intentional redundancy: even a tournament wrongly marked settled counts as active
if any of its cards is still in play.

### 19.2 Multiple tournaments

```text
Tournament A  FINISHED → snapshot PUBLISHED → settled
Tournament B  RUNNING                       → active
        ↓
active_tournament_count = 1  ⇒  KEEP SPRING BOOT ON
        ↓
Tournament B finishes → snapshot published & verified → settled
        ↓
active_tournament_count = 0  ⇒  shutdown permitted
```

Publishing A's snapshot is entirely independent of B (Invariant I10) and never affects B's live path.

### 19.3 The shutdown gate must be verified from *outside* the backend

The workflow does **not** trust `shutdown-readiness` alone. It independently fetches every published
snapshot from `snapshot.ct-we.com` and checks status, version, and checksum. A backend with a broken
R2 client, stale credentials, or a bug in its own verification cannot authorize its own shutdown,
because the authority for "the snapshot is really public" is the public URL — not the backend's
opinion of it.

> **Hard rule: the backend is never suspended before every published snapshot has been fetched and
> checksum-verified over the public internet by the workflow itself.**

**As built.** `GET /api/admin/system/shutdown-readiness` supplies the evidence — including each
snapshot's `h`, so the workflow can build `https://{public-origin}/s/{h}.json` without ever seeing an
access token — and nothing more. The application holds no Render credentials and has no effector: it
cannot suspend itself, cannot write `system/state.json`, and its `readyToStop` flag is advisory. The
workflow that performs this external verification and the suspend is **not built** (see the
implementation plan's Phase G row), so the hard rule above cannot yet be violated by anything in this
repository.

---

## 20. Cloudflare Routing Behaviour While the Backend Is OFF

| Route | Path today | Behaviour when OFF | Change needed |
| --- | --- | --- | --- |
| `/tour/{slug}`, `/t/{hex}` — **published** | Worker shell + snapshot probe | ✅ **Fully works.** Shell from Worker/edge cache, data from R2. Render never contacted | none |
| `/tour/{slug}`, `/t/{hex}` — **not published** | Worker shell + probe 404 → live bundle | Probe 404 → live fetch to Render fails → viewer sees a message | ✏️ distinguish "system off" from "link dead" using `system/state.json` |
| `/api/public/**` | **direct to Render**, bypassing the Worker | Connection/DNS-level failure at the Render host. Client already catches it ([store.ts:641](../src/application/tournament/store.ts#L641)) | none functionally |
| `/api/public/tournaments/{t}/events` (SSE) | direct to Render | `EventSource` fails; existing backoff retries harmlessly | none |
| `/login`, `/logout` | Worker proxy | **503** from `proxyToRender` | ✏️ login page renders "ระบบปิดอยู่" instead of a form |
| `/api/admin/**` | Worker proxy | **503** | none functionally |
| `/api/director/**`, `/api/cards/**` (staff) | Worker proxy | **503** | none functionally |
| `/api/auth/me` | Worker proxy | **503**; only called when the `CTWE_STAFF` hint cookie exists | ✏️ treat 503 as "system off", not "session expired", so a returning admin is not shown a misleading logout |
| `/`, `/cards`, `/admin` | Worker shell + API calls | Shell renders, data calls fail, error banner shows | ✏️ show the system-off panel |
| static assets, `/manifest.webmanifest` | Worker Static Assets | ✅ unaffected | none |

> **Correction to the brief:** there is no `/api/staff/**` namespace in this codebase. Staff traffic
> uses `/api/cards/**` and `/api/director/**`; see
> [SecurityConfiguration:103-116](../backend/src/main/java/com/ctwe/tournament/infrastructure/security/SecurityConfiguration.java#L103).

**Key result: nothing breaks that should not break.** Every ✏️ is presentation only. The functional
behaviour is already correct because the proxy fails safe and the store degrades gracefully.

---

## 21. Login Behaviour

```text
state.json = OFF / STARTING / STOPPING
   /staff-login renders:

   ┌────────────────────────────────────────────────┐
   │  ระบบจัดการแข่งขันปิดอยู่                        │
   │  System is off — no tournament is being run.    │
   │                                                 │
   │  ผลการแข่งขันที่เผยแพร่แล้วยังเปิดดูได้ตามปกติ      │
   │  Published results remain available.            │
   │                                                 │
   │  ผู้จัด: เริ่มระบบก่อนเข้าสู่ระบบ  →  [ วิธีเริ่มระบบ ] │
   └────────────────────────────────────────────────┘

state.json = READY / DRAINING  →  normal login form
```

Two honesty caveats:

1. **This is UX, not access control.** If the backend is up, `/login` works whatever the file says.
   Authorization remains Spring Security's job (§17.5).
2. **Fail toward the form.** If `system/state.json` is unreachable or stale, render the *normal login
   form*. A missing state file must never lock an operator out of a running system.

---

## 22. Backend Startup Safety

### 22.1 The readiness gate

Render's health check governs deploy/restart success. It does **not** know about Cloudflare routing,
the auth chain, or migration state. The workflow's gate (§18, steps 1–5) adds those, and the state
file is not flipped to `READY` until all pass. Ordering matters:

```text
process up  →  DB reachable  →  migrations settled  →  public API answers
            →  auth chain answers 401 (not 5xx)  →  Worker path proven  →  READY
```

A partially initialized backend is therefore never *advertised*. It may still be reachable — which is
why every check that matters is enforced server-side by Spring Security regardless.

### 22.2 Two concrete startup hazards found in this repo

**(a) Neon wake vs. a 5-second connection timeout.** `application.yml` sets Hikari
`connection-timeout: 5000` and `render.yaml` sets `DB_POOL_MIN_IDLE: 0`. Neon free scales compute to
zero. Today this races rarely; a routine suspend/resume cycle makes it a *first-boot certainty*, and
Flyway runs before the app is usable.

> Mitigation, in order of preference: (1) have the start workflow issue a trivial query to wake Neon
> **before** resuming Render; (2) add bounded retry around the startup DB probe; (3) consider a longer
> connection timeout on the startup path only. **Do not raise the runtime timeout globally** — the
> 5 s value protects request threads during an event.

**(b) Env drift becomes a failed start.** `bootstrapStaffAccount` throws if `STAFF_USERNAME` or
`STAFF_PASSWORD_HASH` is malformed. A suspended service that sits for months while someone rotates a
secret will fail to boot at the worst possible moment. Mitigation: the start workflow surfaces the
container log on gate failure, and a pre-event dry run (§28 Phase Z4) exercises a full stop/start
cycle before the real event.

---

## 23. Failure Recovery

| # | Failure | Detection | Behaviour | Recovery |
| --- | --- | --- | --- | --- |
| A | **Backend fails to start** | Readiness gate times out (10 min) | Workflow re-suspends and writes `state=OFF` with the failure reason; **cost does not silently accrue on a broken instance** | Read the run log + Render logs; fix; re-dispatch |
| B | **Starts but DB unavailable** | Gate step 1/2 fails (Flyway or a query) | Same as A | Wake/repair Neon; re-dispatch. §22.2(a) prevents the common case |
| C | **Crashes during a tournament** | Render health check; staff see 503; viewers' SSE drops | Render restarts the service. Existing client behaviour applies: `EventSource` backoff, polling fallback, `ensureSessionAlive` refusing to treat an offline check as logout | None new — this is today's behaviour and is already handled |
| D | **Cloudflare/state file says ON, backend is OFF** | Staff get 503 while the UI offers a login form | Harmless: 503 is already clean and `no-store` | Workflow reconciles state from the Render API; add a "reconcile" dispatch that only rewrites the file |
| E | **State file says OFF, backend is ON** | Login hidden, endpoints live | **Not a security hole** (§17.5) — merely confusing, and cost accrues unnoticed | Same reconcile job; a scheduled daily reconcile is the one cron that *is* worth having, because it catches silent spend |
| F | **Organizer logs in while OFF** | `/staff-login` reads state file | Sees the system-off panel and the "how to start" link, not a failing form | Self-service via §25 |
| G | **Two operators start/stop simultaneously** | — | GitHub Actions `concurrency: { group: ctwe-backend-lifecycle, cancel-in-progress: false }` **serializes them**; the second run re-reads actual state and becomes a no-op | Built in; no lock service needed |
| H | **Tournament finishes while another is live** | `active_tournament_count` ≥ 1 | Stop workflow **aborts before touching Render**. A's snapshot is still published normally | Nothing to recover; this is the designed path (§19.2) |
| I | **Publish succeeds but shutdown fails** | Render suspend call errors or status never becomes suspended | **Benign.** Snapshots are public and correct; only the cost continues | Re-dispatch stop; fall back to the Render dashboard |
| J | **Backend shuts down before publish completes** | — | **Structurally prevented.** Suspend happens only after external verification of every snapshot (§19.3), and stop aborts on any unpublished finished tournament | If it somehow occurred: resume, republish, re-verify. Postgres still holds everything (I3/I7) |

Case J is the one that must never happen, and it is prevented by ordering plus an out-of-band check —
not by hoping the sequence runs to completion.

---

## 24. Cost Model — Precise

| Component | While a tournament is active | While no tournament is active | Goes to zero? |
| --- | --- | --- | --- |
| **Spring Boot compute (Render Starter)** | billed | **suspended → billing stops** ([source](https://render.com/changelog/suspend-and-resume-services-in-bulk-from-the-render-dashboard)) | ✅ **Yes — this is the goal** |
| **PostgreSQL (Neon)** | compute + storage | compute scales to zero; **storage persists and is still counted** | ❌ storage remains |
| **R2 storage** | small | small, and *grows* with each published snapshot | ❌ remains (small) |
| **R2 operations / egress** | minimal | mostly edge-served reads | ❌ remains (small) |
| **Cloudflare Workers** | page shells, free tier | page shells, free tier | ❌ still running (free tier today) |
| **Domain registration** | annual | annual | ❌ never zero |
| **GitHub Actions** | 2 short manual runs per event | none | ~free |

### 24.1 The precise claim

```text
✅ TRUE:   No paid Spring Boot compute while no tournament is active.
❌ FALSE:  "$0 total infrastructure."
```

Storage (Neon + R2) and the domain are unavoidable ongoing costs, and the Cloudflare Worker keeps
serving page shells — which is exactly what makes published snapshots reachable while the backend is
off. Zero-compute mode removes the *largest and most avoidable* line item: an always-on JVM serving an
audience that, between events, is reading immutable JSON.

### 24.2 Second-order effects

- **Neon compute-hours drop toward zero between events**, because nothing connects. On Neon's free
  tier (100 CU-hours/project/month per [DEPLOYMENT_FREE_TIER.md](../DEPLOYMENT_FREE_TIER.md)) this is
  the difference between burning the monthly allowance on idle keep-alives and reserving it for
  the event.
- **Plan sizing becomes event-scoped.** Because compute is only paid while running, upgrading to
  Standard *for the event days* is far cheaper than running Standard year-round — which the capacity
  runbook already recommends but which is hard to justify when the meter never stops.
- ⚠️ **Suspension is not free of risk to cost**: a forgotten resume (case E) silently bills. The daily
  reconcile job in §23-E is the cheap insurance.

---

## 25. Operational UX

A **static** `/system` page in the existing Next.js app, reading `system/state.json`. No backend
dependency, so it works precisely when the backend does not.

```text
┌──────────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
│  ● Backend: OFF                              │   │  ● Backend: READY                            │
│  ไม่มีการแข่งขันที่กำลังดำเนินอยู่               │   │  เข้าสู่ระบบได้แล้ว                            │
│                                              │   │                                              │
│  ผลการแข่งขันที่เผยแพร่แล้ว: เปิดดูได้ปกติ (12)   │   │  Started 09:14 · by @organizer               │
│                                              │   │                                              │
│  [ Start Tournament System ]  → GitHub run   │   │  [ Open Admin ]   [ Stop Tournament System ] │
└──────────────────────────────────────────────┘   └──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
│  ● Backend: STARTING                         │   │  ● Backend: READY · 0 active tournaments     │
│  กำลังเริ่มระบบ… (ตรวจสอบ 3/5)                 │   │  เผยแพร่ครบทุกรายการแล้ว                       │
│  ~2 นาที · ห้ามปิดหน้านี้ก็ได้ ระบบทำงานต่อเอง    │   │  All tournaments published and verified.      │
│                                              │   │                                              │
│  [ ดูสถานะการเริ่มระบบ ] → GitHub run log      │   │  [ Stop Tournament System ]                  │
└──────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
```

### 25.1 Why the buttons are links, not API calls

Triggering start/stop from the browser would require a credential in the browser capable of suspending
production compute. That is forbidden by the same rule as I6. So **the buttons deep-link to the
GitHub Actions `workflow_dispatch` form**, where GitHub authenticates and authorizes the operator and
records who did what.

If one-click convenience later proves necessary, the documented upgrade is a Worker control endpoint
holding the Render token server-side, authenticated by an operator secret — accepting the extra
secret, extra Worker code, and weaker audit trail. Not recommended for v1.

### 25.2 Inside the admin console (backend up)

The admin page gains a **"Shutdown readiness"** panel: active tournament count, any finished-but-
unpublished tournaments listed by name with a link to publish, and a green/red indicator of whether
`active_tournament_count = 0`. The operator learns *why* they cannot shut down without leaving the app.

---

## 26. Security Implications

| Aspect | Effect |
| --- | --- |
| **Attack surface while OFF** | ✅ **Materially reduced.** No login endpoint, no admin/director API, no SSE, no DB connections from the internet. The only public surface is static JSON on a read-only CDN path |
| **New credential: Render API key** | ⚠️ Highest-value new secret. Can suspend/resume — and, depending on scope, possibly more. **Verify whether Render keys are workspace-scoped**; store as a GitHub repo secret; never in the app, the Worker, or the browser; rotate on operator turnover |
| **New authorization boundary** | Whoever can dispatch the workflow can **turn the system on** — and thus re-expose the login page. They still cannot **log in** without staff credentials. Repo write access must therefore be treated as an operational privilege, and reviewed alongside staff accounts |
| **R2 credentials in CI** | The workflow writes `system/state.json`, so it needs write access to the public bucket. Prefer a **separate, narrowly scoped token** from the backend's, limited to the `system/` prefix if the account supports prefix scoping — otherwise document the shared blast radius |
| **State file is public** | It reveals only "the tournament system is on/off". Not sensitive. Contains **no** tournament data, names, or tokens |
| **State file is not a control** | §17.5. Must be stated in code comments and in the file's schema |
| **Downgrade path** | The Render dashboard remains a manual override, so a lost API key never strands the system |
| **Audit** | Start/stop are recorded in the Actions run log (who, when, inputs, result). Tournament-level actions remain in `audit_logs` as today. These are two separate logs — §28 Z5 adds a cross-reference note |

---

## 27. Additional Invariants (Part II)

| # | Invariant | Enforced by |
| --- | --- | --- |
| **Z1** | **Published snapshots remain fully available in every backend state, including OFF.** | Part I: snapshot reads resolve at the CDN and never contact Render/Neon (I1) |
| **Z2** | **The backend is never suspended while `active_tournament_count > 0`.** | Stop workflow aborts before calling Render (§19) |
| **Z3** | **The backend is never suspended before every published snapshot is verified over the public internet by the workflow itself.** | §19.3 external verification; the backend cannot authorize its own shutdown |
| **Z4** | **The control plane never depends on Spring Boot.** | GitHub Actions + Render API + R2; no call touches the application (§17) |
| **Z5** | **No public request queries PostgreSQL or the Render API to discover backend state.** | State is a cached static object read only by shell/landing/login UI; snapshot reads never consult it (§17.3) |
| **Z6** | **`system/state.json` is never a security control.** | §17.5, §21; Spring Security enforces authorization in every state |
| **Z7** | **Zero-compute mode never deletes PostgreSQL data.** | Suspend stops a process; it touches no data. Part I's I3/I4 are unaffected |
| **Z8** | **A missing or stale state file degrades toward availability**, never toward lockout. | §21 fails toward the login form; the Render dashboard is always an override |
| **Z9** | **Starting the system is always a deliberate, attributable human action.** | `workflow_dispatch` only; no scheduled auto-start (§18.1) |
| **Z10** | **Concurrent start/stop attempts cannot interleave.** | Actions `concurrency` group; each run re-reads actual state (§23-G) |

---

## 28. Implementation Phases (Part II)

Part II depends on Part I Phase 5 (published snapshots in production). Shutting the backend off before
finished tournaments are published would take historical results offline.

```text
Z0  PREREQUISITE
    · Part I Phases 0–5 complete; at least one tournament published and verified
    GATE: a published tournament renders with Render deliberately unreachable
          (block the origin at the network level and load /tour/{slug})

Z1  OBSERVE, DON'T CONTROL
    · /system page + system/state.json schema, written manually
    · Reconcile-only GitHub Action: reads Render API, rewrites the file, changes nothing
    GATE: the file tracks reality for a week with no false readings

Z2  MESSAGING
    · Login page, viewer "link dead" vs "system off", /api/auth/me 503 handling,
      root-page system-off panel
    · All fail-toward-available (Z8)
    GATE: with the backend manually suspended, every route behaves per §20

Z3  START WORKFLOW
    · workflow_dispatch: wake Neon → resume → 5-step readiness gate → state=READY
    · Auto re-suspend + reason on gate failure
    GATE: 5 consecutive cold starts pass; a deliberately broken env fails safely
          and leaves the service suspended

Z4  STOP WORKFLOW
    · /api/admin/system/shutdown-readiness endpoint + `lifecycle`/shelve support
    · External snapshot verification (§19.3), DRAINING window, suspend, confirm, state=OFF
    · Admin console "Shutdown readiness" panel
    GATE: stop ABORTS correctly for (a) an active tournament, (b) a finished-but-
          unpublished tournament, (c) a snapshot URL returning 404

Z5  OPERATIONALIZE
    · Daily reconcile (catches silent spend, case E)
    · Runbook: pre-event start, post-event stop, manual dashboard fallback
    · Full dry run 48 h before the first real event: stop → start → verify
    GATE: an operator who did not build this can run both workflows from the runbook alone
```

---

## 29. Diagrams

### 29.1 OFF — `NO_ACTIVE_TOURNAMENT`

```text
   Browser
      │
      ├─ GET /tour/{slug} ──────────► Cloudflare Worker ──► shell (edge-cached)
      │
      ├─ GET /s/{h}.json ───────────► Cloudflare CDN ──► R2 ──► ✅ FULL TOURNAMENT
      │
      ├─ GET /system ───────────────► Worker shell + system/state.json ──► "Backend: OFF"
      │
      └─ POST /login ───────────────► Worker proxy ──► ✗ ──► 503 (clean, no-store)
                                                       │
                                                       └─► UI shows "ระบบปิดอยู่"

   ┌───────────────────┐   ┌──────────────────┐   ┌─────────────────────┐
   │ Render Spring Boot│   │ Neon PostgreSQL  │   │ R2 + Cloudflare     │
   │   SUSPENDED       │   │   idle           │   │   SERVING           │
   │   no billing      │   │   storage only   │   │   snapshots + state │
   └───────────────────┘   └──────────────────┘   └─────────────────────┘
```

### 29.2 START — `BACKEND_STARTING → BACKEND_READY`

```text
  operator ──dispatch──► GitHub Actions ──┬─► R2: state = STARTING
                                          │
                                          ├─► Neon: wake (trivial query)
                                          │
                                          ├─► Render API: POST /services/{id}/resume
                                          │        │
                                          │        └─► JVM boot → Flyway → bootstrap account
                                          │
                                          ├─► GATE (all must pass, ≤10 min):
                                          │     ① /actuator/health/readiness   = UP
                                          │     ② /api/public/cards/versions   = 200
                                          │     ③ POST /login (junk)           = 401
                                          │     ④ /api/admin/** (no session)   = 401
                                          │     ⑤ /api/auth/me VIA THE WORKER  ≠ 503
                                          │
                                          ├─ pass ─► R2: state = READY  ──► login enabled
                                          └─ fail ─► POST /suspend + state = OFF + reason
```

### 29.3 LIVE — `TOURNAMENT_ACTIVE` (identical to today)

```text
   Viewer ──► Worker shell ──┐
                             ├──► probe /s/{h}.json → 404 (edge-cached)
                             └──► Render /api/public/** + SSE ──► Neon
                                        (Caffeine read cache)

   Staff  ──► Worker proxy (same-origin cookies + CSRF) ──► Render /api/** ──► Neon

   Published tournaments from earlier events keep serving from R2 throughout,
   consuming no Render capacity, no Caffeine slots, no SSE budget, no DB connections.
```

### 29.4 STOP — `DRAINING → BACKEND_STOPPING → OFF`

```text
  operator ──dispatch──► GitHub Actions
        │
        ├─► GET /api/admin/system/shutdown-readiness
        │     ├─ activeTournamentCount > 0 ........................ ABORT
        │     └─ unpublishedFinished non-empty .................... ABORT
        │
        ├─► EXTERNAL VERIFY every snapshot at snapshot.ct-we.com
        │     └─ any 404 / version mismatch / checksum mismatch ... ABORT
        │
        ├─► R2: state = DRAINING   (operator confirmation window)
        ├─► R2: state = STOPPING
        ├─► Render API: POST /services/{id}/suspend
        │        └─ graceful: ≤25 s shutdown phase, ≤30 s Render delay
        ├─► POLL Render status == suspended
        ├─► CONFIRM readiness endpoint unreachable
        └─► R2: state = OFF
                    │
                    └─► published snapshots keep serving — unchanged, uninterrupted
```

### 29.5 Complete lifecycle

```text
                    ┌──────────────────────────────────────────────────────┐
                    │  R2 + Cloudflare: PUBLISHED SNAPSHOTS ALWAYS SERVING  │
                    │  (every state below — this row never changes)         │
                    └──────────────────────────────────────────────────────┘

  OFF ──START──► STARTING ──gate──► READY ──create──► TOURNAMENT_ACTIVE
   ▲               │  fail            │                      │
   │               └──────────────────┼──────────────────────┤ more tournaments
   │                 auto re-suspend  │                      │ (stay ACTIVE)
   │                                  │                      ▼
   │                                  │              tournament FINISHED
   │                                  │                      │
   │                                  │                      ▼
   │                                  │         approve → publish → verify   (Part I §7)
   │                                  │                      │
   │                                  │                      ▼
   │                                  │         active_tournament_count = 0 ?
   │                                  │              │no                │yes
   │                                  │              │                  ▼
   │                                  └──────────────┘             DRAINING
   │                                    keep running                    │
   │                                                                    ▼
   │                                                        external snapshot verify
   │                                                                    │
   └────────────────── STOPPING ◄───────────────────────────────────────┘
                       suspend + confirm

   Postgres: SOURCE OF TRUTH throughout — never deleted, never purged by publication.
   Excel Export & Purge: a separate, admin-only feature, blocked while a snapshot is
   published (guardrail G1) — see Part I §5.3.
```
