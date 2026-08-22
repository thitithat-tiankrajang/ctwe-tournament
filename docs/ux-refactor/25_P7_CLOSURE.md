# P7 — CLOSED. Final gate **PASS**.

```
P7 STATUS: CLOSED — a design system exists, is documented, and is enforced by tests
HEAD:      09b2021 (last implementation commit — every gate below ran at this tree)
BASELINE:  ba3e82b (P6 closure)
TREE:      clean · frozen evidence 7/7 OK · DB unchanged · no processes left running
GATES:     npm test 197/197 · lint 0 · typecheck 0 · build 0 · backend 338 run / 0 fail / 0 SKIPPED
```

Plan: `21_P6_P7_PLAN.md` §3. Standard produced: `24_P7_DESIGN_SYSTEM.md`.

---

## 1. What P7 turned out to be

P7 was scoped as *"visual tokens"* and the plan proposed eight token categories. **Four of them were
built, three were declined on evidence, and one was deferred as planned** — and the declines are as
much the result as the additions.

The plan's own success test was: *a developer who needs a confirmation dialog finds one instead of
building a sixth.* That is now true, and it is enforced by a test rather than by good intentions —
`overlay-contract.test.ts` fails if a second modal implementation appears.

The two declines worth stating plainly:

- **No spacing scale.** 542 spacing values across 39 distinct numbers, with 7, 9, 11, 13 and 15px in
  real use. Tokenising them either rounds every component's padding — a redesign this refactor is
  explicitly not — or produces 39 tokens, which is renaming, not systematising.
- **No radius scale.** `globals.css` sets `* { border-radius: 0 !important }`. Square corners are the
  product's visual identity, so a radius scale would have been dead on arrival. P7 deleted the 17
  `border-radius` declarations that had already been dead for exactly that reason.

## 2. Commits

| # | Commit | Delivers |
|---|---|---|
| 1 | `6e272f2` | **Colour** — semantic tone ramps derived from how each colour is actually used |
| 2 | `04b52b8` | **Scales** — stacking, elevation and motion named; the dead radius declarations deleted |
| 3 | `4167396` | **Contrast** — AA on the success button and on every control boundary |
| 4 | `f2649f0` | **The overlay contract** — one modal behaviour: trap, restore, lock, unique ids |
| 5 | `ec811ab` | **Focus restore** — the grid's column filter returns focus to its header |
| 6 | `8eb484a` | **`aria-modal` honesty** — the record filter stops claiming a boundary it does not enforce |
| 7 | `09b2021` | **`Button loading`** — the loading state lives in the primitive, not in every caller |

Diff across P7: 12 files, +624 / −202. `globals.css` 1,328 → 1,416 lines. **No backend file, no data
or transport path, and no `app-shell.tsx` change.**

## 3. Deliverables against the plan's MUST / SHOULD / DEFER (§3.7)

### MUST — all four delivered

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | **P7-A token layer** | **PASS** | 31 → **84** token declarations. New categories: type (6), stacking (8), elevation (5), motion (3), plus the semantic tone ramps and `--border-control` |
| 2 | **P7-B mechanical migration** | **PASS** | `var()` reads 428 → **604**. Colour leakage outside the token layer **117 distinct / 179 uses → 58 / 66**. Raw `z-index` literals **12 → 0** |
| 3 | **P7-C the §2.8 overlay contract** | **PASS** *(shape changed, §4)* | `useModalDialog` + `focus-trap`, consumed by `ConfirmDialog`, `PromptDialog` and both `card-overview` dialogs. Enforced by `overlay-contract.test.ts` |
| 4 | **P7-G the guide** | **PASS** | `24_P7_DESIGN_SYSTEM.md` — which token, which component, the overlay taxonomy, the responsive rules and the accessibility floor |

### SHOULD — two delivered, one partial, one declined with reason

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 5 | **P7-D `Popover`/`Menu`** | **DECLINED as a generic hook** | The three non-modal overlays were audited and their differences are real (guide §3): the grid's filter popup has viewport-move handling that keeps it open under the software keyboard; the combobox dismisses on blur. A hook covering all three needs more options than the code it replaces. **The two defects it was meant to catch were fixed directly** — `ec811ab` and `8eb484a` |
| 6 | **P7-E `Field`** | **NOT DONE** | The deferred contrast fixes that were bundled with it **did** ship (`4167396`): `--green-solid` 4.84:1 for a success fill carrying white text, and 14 control boundaries moved `--border-strong` (1.83:1) → `--border-control` (3.32:1), which is what WCAG 1.4.11 requires |
| 7 | **P7-F type scale** | **PASS** | `--text-xs` … `--text-lg` plus `--text-input-touch`. The 11px floor itself was P6's (`22_P6_TYPOGRAPHY_STANDARD.md`) |
| 8 | **`Button` `--md` / loading / icon-only** | **PARTIAL** | `--md` no-op fixed (it emitted a class matching nothing) and `loading` shipped with `aria-busy` + auto-disable, closing a real double-submit gap. **Icon-only variant not done** |

### DEFER — as planned, plus three declined on evidence

Deferred as the plan directed: `--bp-*` breakpoint consolidation, `Table` unification beyond
conventions, dark mode, and anything restructuring `result-entry-grid.tsx` or `card-overview.tsx`.

Declined during P7 with the reasoning recorded in the guide (§1, §6): the **spacing** scale, the
**radius** scale, and the **weight** scale.

## 4. The one deliberate shape change

The plan asked for a **`Dialog` component**. P7 shipped a **`useModalDialog` hook** instead.

The reason is that the five dialogs do not share markup — they share *behaviour*. A component would
have had to absorb four different bodies through props or slots; a hook hands each dialog the ref,
the id, the backdrop handler and the lifecycle, and leaves its markup alone. The contract the plan
actually cared about is identical either way, and the guard test asserts the contract, not the shape:
**there is exactly one modal implementation, not a second overlay system.**

`ConfirmDialog` remains the thing a developer reaches for; it takes `children`, so a small form in a
modal does not justify a sixth dialog.

## 5. Regression guards added

`npm test` 187 → **197** (+10), and the `package.json` glob was extended to
`src/ui/overlay/*.test.ts` — per-directory globs mean a new directory's tests are invisible until it
is listed.

| File | Tests | What fails if the guard is removed |
|---|---|---|
| `focus-trap.test.ts` | 6 | wrap in both directions, re-entry after focus is lost, the empty trap reporting no destination rather than index 0, menu arrow wrapping, and a focusable selector that excludes what cannot actually be tabbed to |
| `overlay-contract.test.ts` | 4 | anything claiming `aria-modal` unconditionally must use the modal behaviour; a sometimes-modal dialog must say so conditionally, never as a literal; every dialog labels itself with a generated id; **exactly one modal implementation exists** |

## 6. A gate trap worth knowing about

`mvn test` **without `DATABASE_PASSWORD` in the environment silently skips 125 tests across 9
classes and still reports `BUILD SUCCESS`.** The `*DatabaseTest` classes are gated on
`@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")` so that CI skips them.

A first pass of this closure gate hit exactly that and reported `338 run / 125 skipped` — the same
`BUILD SUCCESS`, and the same 338, as a full run. **The skip count is the only thing that
distinguishes them.** The gate was re-run with the variable exported and the DB reachable:

```
Tests run: 338, Failures: 0, Errors: 0, Skipped: 0   ·   BUILD SUCCESS
```

Any future closure that records "backend 338 run / 0 fail" without also recording **0 skipped** has
not proven what it thinks it has.

## 7. Final gate

| Gate | Result |
|---|---|
| `npm test` | **197 pass, 0 fail, 0 skipped** (P6 closed at 187; +10 overlay guards) |
| `npm run lint` | **0** |
| `npm run typecheck` | **0** |
| `npm run build` | **0** — compiled successfully, 13/13 static pages generated |
| Backend `mvn test` | **338 run, 0 failures, 0 errors, 0 SKIPPED**, `BUILD SUCCESS` (unchanged from P6 — P7 touched no backend file) |
| Frozen evidence | **7/7 OK** — `EVIDENCE.sha256` verified before and after the gate |
| Working tree | **clean** |
| Environment | postgres `ctwe-postgres-1` healthy and unchanged; the user's `:3000` (200) and `:8080` (`{"status":"UP"}`) untouched; no stray test processes |

**Invariants not re-measured, and why.** The plan (§3.5) requires re-measuring *shell renders per SSE
result = 0* after any change touching `app-shell.tsx`, and *refocus = 1 request* after anything near
a console. P7's diff is `globals.css`, six UI components and a new overlay module — it touches
neither `app-shell.tsx` nor any data, query or transport path, so neither trigger fired. This is
stated rather than silently omitted.

## 8. Residuals — carried, not fixed

| Item | Why it is left |
|---|---|
| **`Field` primitive** | P7-E's SHOULD. Label association and `aria-describedby` remain per-site rather than guaranteed |
| **Icon-only `Button` variant** | The remaining half of the `Button` SHOULD |
| **58 hard-coded colours outside the token layer** | Genuinely single-purpose — gibson gold, podium gradients, individual component tints. A token for one use is renaming |
| **`--z-grid-popover: 1100`** | A real anomaly, above both the dialog and the toaster, preserved deliberately so `.egrid-filterpop` can escape its scroll container. Labelled in `:root`. Revisit only when the console overlays can be exercised with a login |
| **7 breakpoints** | Three carry the weight (≤560, ≤768/≥769, ≤1080); four one-offs (520, 720, 760, 1080) were each chosen against a real device. Collapsing them is a layout change with no measured benefit |
| **`.entry-keyin__save` hides its label with `font-size: 0`** | A text-hiding technique, so the type floor does not apply — but `.sr-only` would say it better |
| **Runtime overlay verification** | Performed during implementation, against the live app. This closure re-ran the automated gates only; it did not repeat the runtime pass at an unchanged HEAD |

## 9. Status

**P7 is CLOSED.** P0–P4 closed, P5 partial by decision, P6 and P7 closed. Nothing is pushed —
production only moves on a merge to `main` (`render.yaml` pins no branch), so every phase from P0 to
P7 is still local to `ux-refactor/p0-p1`.
