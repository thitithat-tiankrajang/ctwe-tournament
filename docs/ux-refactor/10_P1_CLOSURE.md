# P1 — FINAL GATE. Executed and measured.

**Gates run 2026-08-22** against the committed P1 branch, per `08_P1_PLAN.md` §9.
This document is new evidence. It does **not** modify the frozen set (`01`–`06` + `fixtures/`),
whose checksums were re-verified `OK` before and after this run.

```
P1 FINAL GATE: PASS
P1 STATUS:     CLOSED — ready for P2 approval
P2 STATUS:     NOT STARTED (owner approval required; not taken automatically)
```

Every number below is measured, not estimated. Where something could not be executed it is
recorded as **UNVERIFIED**, never as a pass.

---

## 1. Commit range under test

| | |
|---|---|
| Branch | `ux-refactor/p0-p1` |
| Range | `40ee7f4..1bd0604` (8 commits) |
| HEAD | `1bd0604412b27f44c891facb453c45c959d762c4` |
| Baseline | `6ce756c` (`main`) |
| Working tree | **clean** before and after the entire gate run |
| Pushed | **no** — the range is local; production is unaffected |

```
40ee7f4  docs(ux-refactor): freeze P0 baseline and evidence          P1-0
9941bac  chore(p0): remove four dead modules and four unused deps    P1-0
2549317  test(p0): fix the harness so npm test is a real gate        P1-0
c9a0013  feat(backend): wrong re-auth password -> 403 + BAD_PASSWORD P1-A
86efb5a  test(backend): pin the re-auth error contract               P1-A
3b660b8  feat(backend): scoped back-office card-summaries read       P1-B
34bc5e8  feat(backend): expose GET /api/card-summaries               P1-B
1bd0604  test(backend): pin the card-summaries matrix + values       P1-B
```

**Scope containment re-verified:** across `2549317..HEAD`, 11 files — 4 backend main, 7 backend
test. **Zero changes under `src/`**, zero to `package.json`, `render.yaml`, `wrangler.jsonc`.
`SecurityConfiguration.java` untouched. No migration added (Flyway validated **34** migrations,
still ending at `V34`).

## 2. Test results — exact

### Backend — `mvn -o test`, `.env` sourced so the DB-gated tests actually execute

```
Tests run: 325, Failures: 0, Errors: 0, Skipped: 0     BUILD SUCCESS (3m44s)
```

| Class | Result |
|---|---|
| `ReauthenticationServiceTest` | 4/4 |
| `ReauthErrorContractTest` | 3/3 |
| **P1-A total** | **7/7** |
| `CardSummaryControllerTest` | 6/6 |
| `CardSummaryEndpointDatabaseTest` | 8/8 (`skipped=0`) |
| `SnapshotApprovalDatabaseTest` | 32/32 |

### Frontend

| Gate | Command | Result |
|---|---|---|
| Tests | `npm test` (Node **22.23.2** via `nvm use`) | **114 pass, 0 fail, 0 skipped** |
| Lint | `npm run lint` | **exit 0** |
| Typecheck | `npm run typecheck` | **exit 0** |
| Build | `npm run build` | **exit 0** — compiled in 10.7s, **22 routes** (matches the P0 bundle table) |

> `next build` rewrites the tracked `next-env.d.ts` (the known latent issue in `04_BLOCKERS.md`).
> It was snapshotted before the build and **restored byte-identical** afterwards; the working tree
> ended clean.

## 3. §9.4 performance measurement — the P1 success metric

**Method.** Backend built from HEAD and run on an isolated port with a tagged JDBC
`ApplicationName=p1gate`, so every statement is attributable and cannot be confused with the other
backend already running on this machine. Postgres `log_min_duration_statement = 0` and
`log_line_prefix = '%m [%p] app=%a '`; each request bracketed by marker statements. **The 5-second
`runtime_settings` poller (B8/R1) was excluded by transaction**, not by estimate — one poller
transaction (3 statements) fell inside one window and was removed. Both settings were **restored to
the P0 baseline** afterwards (`-1`, `'%m [%p] '`), verified by `SHOW`.

### ADMIN — 7 cards (the R9 analogue)

| | `GET /api/cards` (old) | `GET /api/card-summaries` (new) | Change |
|---|---|---|---|
| Statements (poller excluded) | **55** | **3** | **18.3× fewer** |
| of which SQL SELECTs | **53** | **1** | **53 → 1** |
| Transaction framing | 2 (`BEGIN READ ONLY`/`COMMIT`) | 2 | — |
| Payload | **154,504 bytes** (150.9 KB) | **2,392 bytes** | **64.6× smaller** |

Measured decomposition of the old path: `1` list + `7 × 7` per-card selects + `3` `final_pairings`
+ `2` txn = **55**. This reproduces R9's `1 + 7N` law exactly (R9: 6 cards → `1 + 6×7 + 3 + 12 = 58`).
The txn count differs from R9 (2 here vs 12 there) because the fan-out ran inside one outer
read-only transaction in this capture; **the N+1 select law — the thing the metric is about — is
identical.**

### DIRECTOR — 2 cards, tenant-scoped

| | `GET /api/cards` (old) | `GET /api/card-summaries` (new) |
|---|---|---|
| Statements | **19** | **4** |
| of which SQL SELECTs | 17 | **1** + 1 tenant-scope lookup |
| Payload | **92,871 bytes** | **649 bytes** |

The new endpoint's per-request cost is exactly **one `SELECT`**, plus the same
`SELECT tournament_id FROM tournament_members WHERE username = ?` that `CardController.list()`
already issues for scoping, plus `BEGIN READ ONLY`/`COMMIT`.

### Against the plan's targets

| Target (`08_P1_PLAN.md` §9.4) | Measured | Verdict |
|---|---|---|
| Statements for a card list → **1** | **1 SELECT** (3 statements incl. txn framing; 4 for a director incl. tenant scope) | **MET** |
| Payload → **~1–2 KB** | 2,392 B for **7** cards (≈342 B/card) → a 3-card director ≈ **1.0 KB** | **MET** |
| Baseline 58 statements / 120.9 KB (R9, 6 cards) | 55 statements / 150.9 KB (7 cards) — same law, one card more | consistent |

> **Honest note.** The R9 figures were captured with 6 cards; the dataset now holds 7, and the
> fixture card has accumulated matches. The comparison above therefore re-measures **both** paths on
> today's data rather than comparing against a stale absolute.

## 4. Invariant B — SSE regression. **PASS**

Ran the three required scenarios on the isolated `P0 SSE Fixture` card against a live staff SSE
stream, and diffed against `fixtures/sse-baseline.json`. Timestamps and `updatedAt` normalised out;
nothing else.

Observed event order (card `v14 → v20`, one event per mutation):

```
0:connected@v14   1:result@v15   2:result@v16
3:state@v17       4:state@v18    5:state@v19   6:state@v20
```

| Check | Result |
|---|---|
| `payloadKeys[connected]` == `[cardId, updatedAt, version]` | PASS |
| `payloadKeys[state]` == `[card, cardId, updatedAt, version]` | PASS |
| `payloadKeys[result]` == `[cardId, changedPairings, updatedAt, version]` | PASS |
| versions strictly monotonic | PASS — `[14,15,16,17,18,19,20]` |
| +1 per mutation, no gaps | PASS |
| one event per mutation (6 mutations) | PASS |
| **result = DELTA** (`changedPairings`, no full card) | PASS — 2 result events |
| **state = FULL CARD** (`card`, no `changedPairings`) | PASS — 4 state events |
| card top-level keys == frozen fixture | PASS — all **20** keys |
| `changedPairings` element shape == frozen sample | PASS — all 13 fields |
| result save → 1 event, 1 changed pairing | PASS |
| `calculatedDiff = min(\|s1-s2\|, maxDiff)` | PASS — `min(20,350)=20`, `min(43,350)=43` |

Stage transitions observed: `RESULT_COLLECTION → RESULT_REVIEW → TABLE_PAIRING (currentGame 2→3)
→ PAIRING_PREVIEW → RESULT_COLLECTION` — the same vocabulary and asymmetry the fixture pins.

**The load-bearing asymmetry is intact: result save = DELTA, stage change = FULL CARD.**
The SSE implementation was not modified.

> **Two honest deviations from the fixture, neither semantic.**
> 1. **Ordering.** The baseline captured `preview/confirm` before `results/review/publish`; this run
>    entered the cycle mid-`RESULT_COLLECTION`, so the same events appear in the other order within
>    the game cycle. Event *types, shapes, counts and version semantics* — what Invariant B pins —
>    are identical.
> 2. **Version numbers** are `v14+` rather than the baseline's `v2–v10`, because the card advanced
>    during P0 R13 and this run. Monotonicity and `+1`-per-mutation are what the fixture asserts,
>    and both hold.
> 3. **"Snapshot publish"** here is `results/review` + `results/publish` (the fixture's
>    `TRACE_3_resultsPublish`). A **Public Snapshot publish to R2 is a different thing** and remains
>    environment-blocked (Invariant C, waived in `07_P0_CLOSURE.md` §2).

## 5. Invariant A — DB / store / second browser agreement. **PASS**

One result save (`g3t1`, 512 : 333), cross-checked across four independent views:

| | Postgres | mutation response | SSE payload | fresh `GET /api/cards/{id}` |
|---|---|---|---|---|
| winner | `7` | `B007` | `B007` | — |
| scoreOne / scoreTwo | `512` / `333` | `512` / `333` | `512` / `333` | — |
| resultType | `W` | `WIN` | `WIN` | — |
| calculatedDiff | `179` | `179` | `179` | — |
| card version | `21` | `21` | `21` | `21` |

`calculatedDiff = min(|512−333|, 350) = 179` — correct.

**Second-browser leg:** a separate **STAFF** session in a real browser rendered the same values
(standings after game 3: `B007  6 pts  +534  3/0/0`, where `534 = 155 + 200 + 179` — the three
results actually in the database).

Also confirmed at runtime: **`submitResult` does not recalculate standings**
(`03_INVARIANTS.md` §3.4) — `B007`'s displayed `diff` excluded the new 179 until the game was
published.

## 6. Invariant D — Old FE + New BE. **PASS** (the P1 gate)

**Method.** The **unmodified** frontend, production build (`next build` + `next start`), pointed at
the P1 backend. Attribution proven: the browser's authentication SQL appears in the Postgres log
tagged `app=p1gate`, i.e. it really is the HEAD build being exercised. The user's own backend and
dev server were left running and untouched throughout.

| Check | Result |
|---|---|
| DIRECTOR login | **PASS** — console lists only the assigned tournament (2 cards) |
| STAFF login | **PASS** — lists only the granted tournament |
| Card list loads via `GET /api/cards` | **PASS** — both roles, both cards |
| Card pages load (tables, games, standings) | **PASS** |
| **Wrong-password re-auth on a pairing swap** | **PASS** — Thai dialog **"ยืนยันตัวตนไม่สำเร็จ / รหัสผ่านไม่ถูกต้อง"**. No English "Unauthorized" |
| 403 does not log the user out | **PASS** — session still `authenticated: true` afterwards |
| Live SSE against the new backend | **PASS** — confirming game-4 pairings in another session flipped the staff browser to result entry **with no reload** |
| Browser console | **one** error: the `403` from the deliberate wrong password. **No JS exceptions, no React errors, no unhandled rejections** |
| Frontend changes required | **none** |

### The P1-A contract, end to end through the production request path

`POST /api/cards/{id}/tables/swap` with a wrong password, through the unmodified Next proxy:

```
HTTP 403
{"code":"BAD_PASSWORD","status":403,"error":"รหัสผ่านไม่ถูกต้อง","timestamp":"..."}
```

and `GET /api/auth/me` immediately afterwards still returns `authenticated: true`.

**This is what unblocks P2:** the readable Thai message and the machine-readable `BAD_PASSWORD`
discriminator now arrive from the backend, so removing the frontend pre-flight will not degrade the
message. B2's ordering constraint is satisfied.

Incidental corroboration of §4.1: the staff card list rendered **"ลงทะเบียน · 401 คน"** for the card
in `PLAYER_REGISTRATION`. The public projection reports `0` there — which is precisely why the
public summary could not be reused for the back-office list.

## 7. Public API regression — `GET /api/public/cards`. **PASS, byte-identical**

Two independent forms, both on identical data, before any writes:

| Form | Result |
|---|---|
| **Same-process (the cache-poisoning guard)** — capture, then call `/api/card-summaries` as ADMIN, DIRECTOR and STAFF (3× each), then re-capture | **byte-identical**, 2,390 bytes |
| **Cross-commit** — pre-P1-B backend built from `86efb5a` in a throwaway worktree vs HEAD | **byte-identical**, 2,390 bytes |

```
sha256  f3e1567715f6b77de6d62188a2b3fa8e719cc197a2cf6e2c5dda58437b270388
        identical for PRE-P1B, BEFORE and AFTER
```

The worktree build was confirmed to genuinely predate P1-B: an **authenticated** call to
`/api/card-summaries` returned **404** there and **200** on HEAD. The worktree was removed.

**`§4.2` rule 1 holds: the anonymous catalog cache is not poisoned by the new endpoint.**

Also captured: anonymous `GET /api/cards` **byte-identical** before and after (65,203 bytes) —
**B7 / SECURITY-01 is untouched**, as designed.

## 8. Environment discipline

| | |
|---|---|
| Probe accounts | 3 throwaway accounts (`p1gate-admin/director/staff-<sfx>`) with a per-run generated password, following the pattern of `09_B4_...` §1 and the committed P1-B test. **All deleted; 0 rows remain.** No real credential was used. |
| DB reconciliation | `staff_accounts 4 · tournaments 3 · tournament_cards 7 · players 518 · tournament_members 2 · staff_tournament_access 1` — **identical to session start on all six counts** |
| Pre-existing data | untouched. All writes were confined to the isolated `P0 BASELINE (ux-refactor) DO NOT USE` tournament (decision A) |
| Postgres settings | `log_min_duration_statement` and `log_line_prefix` **restored** to the P0 baseline (`-1`, `'%m [%p] '`), verified by `SHOW` |
| Other processes | the backend on `:8080` and dev server on `:3000` already running on this machine were **not touched**; all gate work used `:8081` / `:3100` |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **all 7 OK**, before and after |
| Working tree | **clean** |

**Intentional data change, for the record:** the isolated `P0 SSE Fixture` card advanced from
`v14 / RESULT_COLLECTION / game 2` to **`v28 / RESULT_COLLECTION / game 4`** (results for games 3–4
and their pairing/publish cycle). This is the isolated dataset, and the advance is what produced the
Invariant A and B evidence.

## 9. Remaining gaps — nothing deferred silently

| # | Gap | Status |
|---|---|---|
| 1 | **CSRF row of the §9.2 P1-A matrix** — the plan asks for `403 / "Forbidden" / no code`. The committed test asserts it *structurally* (by reflection, that `ApiExceptionHandler` declares no `AccessDeniedException` handler) rather than by executing a real CSRF rejection | **PARTIALLY VERIFIED.** The property is guarded against regression; the end-to-end CSRF response body was not captured. Low risk — a wrong password was observed carrying `code`, and Spring's default 403 carries none |
| 2 | **Invariant C — snapshot checksum** | **UNVERIFIED — environment-blocked.** No R2 credentials locally; waived in `07_P0_CLOSURE.md` §2. P1 does not touch the snapshot path |
| 3 | **Cold-cache query counts** | **UNVERIFIED — environment-blocked**, waived in `07_P0_CLOSURE.md` §2. All §9.4 numbers above are warm-path, poller-excluded |
| 4 | **D17 contradiction** — `NEXT_PUBLIC_SNAPSHOT_ORIGIN` set in production vs unset in the Worker build | **OPEN — owner only.** Does not block P1 or P2 |
| 5 | **B7 / SECURITY-01** | **OPEN — owner decision.** Proven untouched by P1 (§7) |
| 6 | **B6 residual** — CI still does not run `npm test` | **OPEN — owner call.** Safe to add: the suite is green |
| 7 | **P1-D** — batch player import (B9) | **DEFERRED** by owner. Unblocks nothing |
| 8 | **Invariant E** — multi-user editing | Not re-run. `08_P1_PLAN.md` §9.3 requires this only if P1-D is included; it is not, and P1 adds no write path. PASS from R13 stands |
| 9 | **D3 admin narrowing** | Deliberately deferred to P2/P3; ADMIN stays unrestricted in P1-B |

## 10. P1 FINAL GATE

| Gate | Required | Result |
|---|---|---|
| Backend tests | must | **PASS** — 325/325 |
| Frontend tests | must | **PASS** — 114/114 |
| Frontend lint / typecheck / build | must | **PASS** — exit 0, 0, 0 |
| **§9.4 measurement** | must | **PASS** — 53 SELECTs → **1**; 154,504 B → **2,392 B** |
| **Invariant B — SSE** | must | **PASS** — 12/12 checks |
| **Invariant D — Old FE + New BE** | must | **PASS** — incl. the Thai re-auth message |
| Invariant A | should | **PASS** — 4 views agree |
| Public API regression | should | **PASS** — byte-identical, two forms |
| Invariant C | n/a | **UNVERIFIED — waived, environment-bound** |

```
P1 FINAL GATE: PASS
P1 IS CLOSED. Ready for P2 approval.
```

**P2 is not started.** Its prerequisites are now all satisfied:

- **P1-A is committed, tested and verified end-to-end** — the ordering constraint B2 mandates
  (`P1-A → P2`) is met, so P2 may remove the frontend pre-flight `verifyPassword`.
- Carry into P2: discriminate on the body **`code`**, never on status (CSRF is also 403);
  keep all **three** B4 defences; handle the eviction response documented in
  `09_B4_SESSION_REGISTRY_MEASUREMENT.md` §4 (**`200` + non-JSON body → `JSON.parse` throws**);
  decide on `HttpSessionEventPublisher`.
- **Rollback rule stands:** never revert P1-A once P2 has removed the pre-flight. Revert P2 first.

## 11. Raw evidence

The harness is a **measurement, not part of the approved P1 file set**, so — as with
`09_B4_SESSION_REGISTRY_MEASUREMENT.md` §6 — it is **not committed**. Artefacts from this run:

```
<scratchpad>/measurement-9.4.txt        parsed statement counts, per window, poller excluded
<scratchpad>/pg.log                     raw Postgres statement log for the §9.4 windows
<scratchpad>/invariant-A.txt            the four-view comparison
<scratchpad>/invariant-B.txt            the 12 Invariant B checks
<scratchpad>/sse-raw.txt                raw SSE stream for the three scenarios
<scratchpad>/public-cards-{PRE-P1B,BEFORE,AFTER}.json    byte-identity captures
<scratchpad>/{lint,typecheck,build}.txt frontend gate output
```

**To reproduce §9.4:** build the backend, run it on a spare port with
`DATABASE_URL=...?ApplicationName=p1gate`, set `log_min_duration_statement = 0` and
`log_line_prefix = '%m [%p] app=%a '`, bracket each request with a marker statement, then discard
every transaction containing `FROM runtime_settings`. **Restore both Postgres settings afterwards**
(`ALTER SYSTEM RESET ...; SELECT pg_reload_conf();`) — this run left them at the P0 baseline
`-1` / `'%m [%p] '`.
