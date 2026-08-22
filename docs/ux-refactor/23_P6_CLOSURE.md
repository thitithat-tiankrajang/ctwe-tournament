# P6 — CLOSED. Final gate **PASS**.

```
P6 STATUS: CLOSED — engineering-quality and accessibility standards established and enforced
HEAD:      8482995
BASELINE:  ac197b8 (P6/P7 plan)
TREE:      clean · frozen evidence 7/7 OK · DB unchanged · no processes left running
GATES:     npm test 187/187 · lint 0 · typecheck 0 · build 0 · backend 338 run / 0 fail / 0 SKIPPED
```

Plan: `21_P6_P7_PLAN.md`. Standard produced: `22_P6_TYPOGRAPHY_STANDARD.md`.

---

## 1. What P6 turned out to be

P6 was scoped as *"performance + accessibility remainder"* and tracked by a single metric: 35 font
declarations below 11px. **Both the metric and its scope were wrong**, and finding that out is the
phase's main result.

- **A third of the metric was dead code.** After deleting rules nothing can match, the tracked 35
  fell to 23 without a single accessibility fix. They were never defects.
- **The metric could not see the actual defects.** It counted bare px values only. The worst text in
  the product was inside `clamp()` — measured in a browser at 375px, the public viewer's ranking
  grid rendered column headers at **5.81px** and player names at **7.15px**.

So P6 became: delete what is dead, replace the metric with a standard, enforce the standard in tests,
and fix the two accessibility defects and the one performance defect that had real evidence.

## 2. Commits

| # | Commit | Delivers |
|---|---|---|
| 1 | `5839598` | **Dead CSS** — 176 rules removed, proven unreachable |
| 2 | `412e5f9` | **Typography standard** — 11px floor everywhere, enforced |
| 3 | `04744b6` | **D6 part 1** — the reveal control is keyboard-reachable |
| 4 | `89aecfc` | **D6 part 2** — `type="password"` stops the screen-reader leak |
| 5 | `16ff573` | **B8** — an idle deployment no longer polls `runtime_settings` |
| 6 | `9ea9e60` | **Table semantics** — 38 `scope`, 9 accessible names |
| 7 | `8482995` | **Boundary fix** — content-width grid across the whole tablet range |

## 3. Deliverables and evidence

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | **Dead CSS removed** | **PASS** | 176 rules / 82 classes / 181 lines. `globals.css` 1519 → 1322 lines, 106,923 → 91,144 bytes (−14.8%). Runtime: 0 of the removed classes present on the viewer's list (449 elements) or card (529 elements) views |
| 2 | **11px floor** | **PASS** | 0 declarations can render below 11px, `clamp()` floors included. Smallest rendered text is 11px at 375/390/768/1024/1280 |
| 3 | **Type scales by width, not pointer** | **PASS** | the `(hover: hover)` gate is off every type rule; 1024px renders 11.6–12px whatever the pointer |
| 4 | **Inputs ≥16px on touch** | **PASS** | login page at 390px: both fields 16px, so iOS Safari cannot zoom-jump on focus |
| 5 | **No clipped data** | **PASS** | 0 cells ellipsed at every swept width (31 at 375px and 59 at 768px during development) |
| 6 | **D6 keyboard** | **PASS** | the toggle is the next tab stop after the field; `aria-pressed` flips false → true |
| 7 | **D6 screen-reader leak** | **PASS** *(with a residual, §6)* | masked → `type="password"`; revealed → `type="text"`; value survives the toggle |
| 8 | **Table semantics** | **PASS** | 38/38 `<th scope>`, 9/9 tables named. Live a11y tree: pairing grid reports "ตารางประกบคู่", 7/7 headers scoped |
| 9 | **Focus indicators** | **PASS** | the two the guard found are fixed: the grid filter search box had none, select-menu's active option had its ring suppressed while hover painted the same tint |
| 10 | **Idle DB work** | **PASS** | measured 0 (§5) |
| 11 | **Regression guards** | **PASS** | 9 new tests across `globals.test.ts` and `table-semantics.test.ts`, plus 1 backend test |

## 4. Typography, measured

Public viewer, `/tour/bkk`, before → after:

| | 375px | 390px | 768px | 1024px | 1280px |
|---|---|---|---|---|---|
| Column header | **5.81 → 11** | 11 | 11 | 11.58 | 11.94 → 12.48 |
| Data cell | **7.15 → 12** | 12 | 12 | 12.08 | 12.96 → **12.98** |
| Player name | **7.15 → 12** | 12 | 12 | 12 | 11.68 → 12.34 |
| School line | **7 → 11** | 11 | 11 | 11 | **9.64 → 11.2** |
| Cells clipped | 0 | 0 | 0 | 0 | 0 |
| Page overflows horizontally | no | no | no | no | no |

**Desktop deliberately did not move** — 12.96px → 12.98px on data cells. The floor was the problem,
not desktop. The one real desktop gain is the school line, which was below the floor at 9.64px.

At 375–768px the grid sizes to its content and overflows into the scroller `.entry-grid-scroll`
already had; the data stays complete and legible and reaching the last column costs a swipe. That
trade is stated in the standard, §5, because it is a trade and not a free win.

## 5. Idle database work, measured

| | |
|---|---|
| Method | `pg_stat_database.xact_commit` delta over a fixed window, no client attached |
| First attempt | 40 tx / 60s — **discarded**: a browser tab was still holding a stream open, exactly the contamination `04_BLOCKERS.md` B8 warns about |
| Old code, idle | **77 transactions / 120 s ≈ 55,440/day** (B8 estimated 17,280) |
| New code, idle | **0** |

The "after" number is a differential, which also settles attribution: with the old-code instance
idling at 77/120s, a second fully-started instance running the new code added **zero** over the same
window. Those 77 were the poller.

Two changes, each addressing a different half. The heartbeat returns early when all three emitter
maps are empty — with nothing subscribed there is no socket to prune and no client to beat, and the
tick was reading the database only to evaluate the next line's guard. And the cache TTL goes 5s →
60s, which is free because `update()` is `@CacheEvict(allEntries = true)` and is the only code path
that writes the table, on a single-instance deployment.

The backend test was **falsified before it was trusted**: with the guard removed it fails, with the
guard present it passes, and its second assertion pins that a *subscribed* heartbeat still reads
settings — this is about idleness, not about beating less often.

## 6. Honest limits and one residual risk

**D6's fix carries a residual, and the owner should decide whether to keep it.** `type="password"`
is the only robust way to stop assistive tech reading the password — CSS masking hides characters
from the screen and from nothing else. But `type="password"` is also what browser password managers
key on, and avoiding them is why `FreshSecretInput` was written. Every suppression signal is in
place — the per-manager ignore attributes for 1Password, Bitwarden, LastPass and Proton, plus
`autocomplete="new-password"` — and **none of them binds Chrome's or Safari's own "save password?"
prompt.**

On the shared venue machines of D6/D9 a saved credential would let the next person sign in as the
previous one, which is the identity-attribution risk D9 already reasons about. **If those browsers
do not have password saving disabled by policy, revert this**: it is one expression on the `type`
line in `fresh-secret-input.tsx`. Recorded as an owner decision, not a closed question.

Other limits, stated rather than glossed:

- **No authenticated runtime pass.** Entering credentials is out of bounds for me, so the console
  pages were verified by static proof plus the production build, not by a logged-in browser session.
  The public viewer — which is the mobile-first surface and where the worst typography was — *was*
  verified live at five viewports.
- **No React test setup** (`18_` §9). The table-semantics and typography guards read source and CSS,
  not rendered output. They catch omission, which is the failure mode that actually occurs.
- **`npm test` still is not run by CI.** The nine new guards protect local runs only. Adding it is an
  owner call and `04_BLOCKERS.md` B6 already recommends it.
- **The backend change is inert until a deploy.** Production only moves on a merge to `main`.
- **`.entry-keyin__save` uses `font-size: 0`** to hide its label on narrow screens. That is a
  text-hiding technique rather than a reading size, so the floor does not apply, but `.sr-only`
  would be the cleaner expression. Left alone; noted for P7.

## 7. What was deliberately NOT done

| Item | Why |
|---|---|
| **Bulk player import** (B9, 800 INSERTs) | measured but registration-time only, and it cannot affect live scoring. No evidence justified pulling it into P6 |
| **Sidebar "double menu"** | not a real defect. `design.md`'s status header records UX-F5/UX-R2 as already done, `sidebar__nav-layer` is gone from the source, and desktop/mobile navs are `display: none`-toggled so only one landmark is ever exposed. Not resurrected |
| **`/admin` ≤ 8 requests** | needs a backend batch endpoint or D3 admin narrowing — an owner decision, not a frontend task |
| **Contrast changes** | measured and mostly fine. Only `.button--success` (4.32:1) and the form-control border (1.83:1) genuinely fail, and both are token edits that belong with P7's colour work rather than being made twice |
| **Full font-size tokenisation** | P6 tokenised the small range, where the floor is enforceable. The display scale is P7's |

## 8. Gates

| Gate | Result |
|---|---|
| `npm test` | **187 pass, 0 fail, 0 skipped** (P5 closed at 178; +9 guards) |
| `npm run lint` / `typecheck` / `build` | **0 / 0 / 0** |
| Backend `mvn test` | **338 run, 0 failures, 0 SKIPPED** (was 337; +1 idle-heartbeat guard) |
| Frozen evidence | `shasum -c EVIDENCE.sha256` → **7/7 OK** |
| Working tree | **clean** |
| Database | `staff_accounts 4 · tournaments 3 · cards 7 · players 518 · matches 149 · audit_logs 351` — **identical to the P4/P5 baseline**; 0 accounts created today |
| Processes | the probe backend on `:8092` stopped; no stray `tournament-api` processes. The user's `:3000` and `:8080` verified healthy (200) and untouched |
| Build artifacts | `next-env.d.ts` restored after every build (the known churn in `04_BLOCKERS.md`) |

## 9. Invariants re-checked

Nothing in P6 touches a frozen file. `store.ts`, `use-card-sync.ts`, `use-public-sync.ts`,
`snapshot-api.ts`, `TournamentCardService.java` and `publicsnapshot/**` are **absent from the entire
P6 diff**.

`CardEventPublisher.java` is SSE-critical but not frozen, and P4 already modified it under approval.
The change is one early return on a condition that is false whenever anyone is subscribed, so every
SSE path behaves exactly as before whenever it can be observed — pinned by the second assertion in
the new test and by the unchanged 338-test backend suite, including `SseDeliveryProofDatabaseTest`
and `SseDropReachabilityTest`.

`result-entry-grid.tsx` and `data-grid.tsx` received `scope` and `aria-label` attributes only.
Neither renders, so that diff cannot move a pixel or change behaviour.

## 10. Verdict

**P6 FINAL GATE: PASS.** Standards established and enforced by tests rather than by inspection: a
typography floor that counts `clamp()`, an input rule that survives iOS, table semantics, focus
indicators, a dead-rule oracle, and an idle-cost guard. Working tree clean, frozen evidence intact,
database unchanged, no unrelated source in the diff.

One owner decision is open and named in §6: whether `type="password"` is acceptable on the venue
machines.

P7 (design system standard) begins next, per `21_P6_P7_PLAN.md` §3.
