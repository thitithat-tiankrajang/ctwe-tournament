# P5 — PARTIAL, deliberately. One chunk done, the rest declined.

```
P5 STATUS: PARTIAL BY DECISION — D21 shipped; D16 and "URL state" NOT taken
HEAD:      8d3e008
BASELINE:  a29738f (P4 closed)
TREE:      clean · frozen evidence 7/7 OK · DB unchanged · no frozen file touched
GATES:     npm test 178/178 · lint 0 · typecheck 0 · build 0 · backend 337 run / 0 fail / 0 skipped
```

This is **not** a phase closure in the sense P1–P4 were. P5 was scoped as *"Information architecture
+ URL state"* and is listed **CUT IF LATE** in the `00_MASTER_PLAN.md` §4 scope freeze. The preflight
found that most of it should not be built; the owner agreed and approved exactly one chunk.

---

## 1. What was found at preflight, and why most of P5 was declined

**P5 never had a plan document.** Unlike every other phase there is no `*_P5_PLAN.md`, no problem
statement and no baseline. Its entire recorded scope was a phase-table label plus two D-decisions.

| Item | Finding | Decision |
|---|---|---|
| **D21** — collapse unused folders | Two thirds already shipped (`.card-folder--current`, the "ปัจจุบัน" badge, collapsible folders). The gap was real and small: folders auto-expanded and never auto-collapsed | **TAKEN** |
| **D16** — audit log to an overflow menu | It is one of **five** card links and is director-only, so staff never see it. Pure relocation, no measured problem, maximum retraining cost | **DECLINED** |
| **"URL state"** | No problem statement anywhere in the docs. The URL already carries tournament scope (P3-C), card id, sub-page, and the viewer's card (`#card={uuid}`). Only game/view/filter are component state, with no recorded complaint | **DECLINED — undefined** |

> **Where D16/D21 status is recorded, and why not in the decision register.**
> `02_ARCHITECTURE_DECISIONS.md` is a **frozen evidence file** (`EVIDENCE.sha256`). I edited it to mark
> D21 done and D16 declined, the checksum failed, and the edit was reverted — the file is byte-identical
> to its frozen state and the manifest verifies 7/7. The D-series outcomes therefore live **here** and in
> the living `00_MASTER_PLAN.md`. Anyone reading the register should treat this document as the current
> status of D16 and D21.

Deciding context, from `00_MASTER_PLAN.md` §2: **no staging environment**, **CI does not run
`npm test`**, and a competition **~3 weeks out** with ten staff sessions to brief. D2 records that the
owner accepts retraining risk for IA changes — but accepting a risk is a reason to spend it well, not
a reason to spend it on a relocation with no measured benefit.

**P5 moves none of the tracked success metrics.** The only unmet one is *font sizes below 11px*
(counted this session: **35** in `globals.css` — 20×10px, 10×9px, 3×10.5px, 1×9.5px, 1×8.5px), which
belongs to P6/P7. The other open item, *admin login payload → 0 cards*, is **D3 admin narrowing**, an
owner decision explicitly excluded from this refactor.

## 2. What shipped — D21, measured

Commit `8d3e008`. Production build, three cards, client-side navigation A → B → C:

| | Folders expanded | Page links in the sidebar |
|---|---|---|
| **Before** | **3 of 3** | **15** |
| **After** | **1 of 3** — always the current card | **5** |

Before the change, only one of the three expanded folders was the current card; the other two were
stale expansions from earlier visits. That is precisely the dilution D21 named.

**It does not fight the user.** The rule is keyed on card *change* only, so expanding another folder
to peek at it stays expanded until you navigate somewhere else. Verified at runtime, not assumed:
opening D15's folder while on card C leaves both open and it survives subsequent re-renders.

## 3. Files changed

```
src/ui/layout/card-folders.ts        NEW — foldersAfterOpening(), the whole rule
src/ui/layout/card-folders.test.ts   NEW — 7 tests
src/ui/layout/app-shell.tsx          the effect now applies the rule (one line + import)
package.json                         test glob extended with src/ui/layout/*.test.ts
```

**Nothing frozen is in this diff**: `use-card-sync.ts`, `use-public-sync.ts`, `store.ts`,
`snapshot-api.ts` and the entire backend are untouched.

The rule lives in its own module so it can be tested without pulling the shell — Next navigation, the
store and the SSE hooks — into a node test process. The `package.json` change is load-bearing rather
than incidental: the test script enumerates directories and `src/ui/layout` was not among them, so the
new file would otherwise never have run. CI does not run `npm test` at all, so this affects local runs
only.

> **Reference equality is deliberate.** `foldersAfterOpening` returns the *same* Set when nothing
> would change. `app-shell.tsx` is the file P3-E had to restructure to reach **zero shell renders per
> SSE result event**; returning a fresh Set for a no-op would give that back one render at a time. The
> old code had the same property and keeping it was intentional — a test pins it.

## 4. Gates

| Gate | Result |
|---|---|
| `npm test` | **178 pass, 0 fail, 0 skipped** (P4 closed at 171; +7 D21) |
| lint / typecheck / build | **0 / 0 / 0** |
| Backend `mvn test` | **337 run, 0 failures, 0 SKIPPED** — untouched by P5, run as regression |
| Frozen evidence | **7/7 OK** |
| Working tree | **clean** |
| Database | `accounts 4 · tournaments 3 · cards 7 · players 518`; **0 accounts created today** |

## 5. Risk and rollback

Frontend-only, one commit, `git revert 8d3e008` restores the previous behaviour exactly. No
migration, no data repair, no API change. The behavioural blast radius is the sidebar's expanded set
and nothing else.

**Retraining cost: none.** Nothing moved. A folder the operator was not working in simply closes.

## 6. What remains

| | |
|---|---|
| **P5 remainder** | D16 and "URL state" — **declined, not deferred with a plan**. If either is wanted later it needs a problem statement first, not an improvisation |
| **P6** | Performance + accessibility remainder. Holds the only unmet success metric: **35** sub-11px font declarations. Correctness half is SHOULD DO, performance half is CUT IF LATE |
| **P7** | Visual tokens — CUT IF LATE |
| **Owner decisions, all still open** | B7/SECURITY-01, D17, P1-D, D3 admin narrowing, `HttpSessionEventPublisher` |
| **Known unmet target** | `/admin` ≤ 8 requests — needs a backend batch endpoint or D3 |
| **AFTER COMPETITION** | bulk result endpoint, terminology rename, Web Push backend removal, modal→drawer, dark mode, virtualisation |

**P6 is not started.**
