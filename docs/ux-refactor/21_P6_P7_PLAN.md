# P6 + P7 — PLAN. Foundation stage. Nothing implemented.

```
HEAD:      dd4397d316b493a2ec7d3db4e9a88a0289093ed8
BRANCH:    ux-refactor/p0-p1
TREE:      clean (verified before and after running gates)
FROZEN:    shasum -c EVIDENCE.sha256 -> 7/7 OK
GATES RUN THIS SESSION: npm test 178 pass / 0 fail / 0 skipped · lint 0 · typecheck 0
GATES NOT RUN:          production build · backend mvn test  (quoted from 19_/20_, not re-executed)
SOURCE CHANGED:         none
```

This is a **plan**, not a closure. P6 and P7 are both **NOT STARTED**. Every number below was
measured in this session against this HEAD unless explicitly marked as quoted.

Scripts used are in the session scratchpad and are reproducible from the definitions given in §1.2;
they read source only and write nothing.

---

## 0. What changed in the evidence, before any planning

Three prior claims moved. Two are corrections, one is a substantial widening. **Read this section
before §2 — it is the reason P6's scope is not the scope `20_P6_HANDOFF.md` proposed.**

### 0.1 CONFIRMED — the 5 dead CSS rules are genuinely dead

`.physical-table`, `.physical-match__label`, `.physical-player*` and `.pair-result-board` appear
**only** in `globals.css`. A repo-wide sweep across `.tsx`, `.ts`, `.js`, `.jsx`, `.html`, `.java`
and `.md`, excluding `node_modules`/`.next`/`.open-next`, returns exactly two hits and neither is a
usage: a prose comment in `SchoolAwarePairing.java:14` ("physical-table ordering") and
`20_P6_HANDOFF.md` itself quoting the finding.

Checked against the risk that would invalidate this: the codebase **does** build class names by
interpolation (51 sites), but only ever as `base--${modifier}` (`button--${variant}`,
`badge--${tone}`, `toast--${item.tone}`, `cell-diff--${…}`, `entry-keyin--${…}`). No site
interpolates a class *prefix*, so no `physical-*` name can be produced at runtime.

**The handoff's classification stands.** Deleting these 5 is zero-risk.

### 0.2 CORRECTION — the tracked font metric is structurally blind to `clamp()`

`00_MASTER_PLAN.md` §6 tracks *"Font sizes below 11px: 31 → 0"*, and `19_`/`20_` count it as **35**.
That number reproduces exactly — but only under one specific definition.

I parsed all **223** `font-size` declarations carrying a px literal, five ways:

| Method | Definition | Count |
|---|---|---|
| **1** | **plain, non-`clamp()` declarations below 11px** | **35** ← *this is the tracked metric* |
| 2 | `clamp()` declarations that are **below 11px at every viewport** (max < 11) | **10** |
| 3 | `clamp()` declarations whose **floor** is below 11px but whose max is ≥ 11px | **15** |
| — | **always below 11px, any syntax  (1 + 2)** | **45** |
| — | **can render below 11px, any syntax  (1 + 2 + 3)** | **60** |

Method 1's 35 line numbers match `20_P6_HANDOFF.md` §3 **exactly**, so the handoff's classification
table is accurate and its line numbers have not drifted. The problem is not the classification. The
problem is the **denominator**: the metric only counts the syntax the codebase uses for its *least*
severe cases, and does not count the syntax it uses for its *most* severe ones.

**The 10 that are invisible to the metric and are always under 11px:**

| Line | Selector | Range | Media |
|---|---|---|---|
| 947 | `.entry-grid thead th` | 7 → 10.5px | — |
| 981 | `.gibson-mark` | 6 → 9px | — |
| 999 | `.cell-vs` | 7 → 10px | — |
| 1003 | `.cell-person-school` | 6.5 → 9.5px | — |
| 1013 | `.cell-athlete__school` | 7 → 10px | — |
| **1273** | **`.entry-grid thead th`** | **5.5 → 7px** | **`@media (max-width: 560px)`** |
| **1274** | **`.entry-grid td.egrid-td`** | **6 → 8px** | **`@media (max-width: 560px)`** |
| **1276** | **`.entry-grid .cell-score`** | **6.5 → 8px** | **`@media (max-width: 560px)`** |
| **1277** | **`.entry-grid .egrid-score`** | **6.5 → 8px** | **`@media (max-width: 560px)`** |
| **1278** | **`.entry-grid .cell-vs`** | **5.5 → 7px** | **`@media (max-width: 560px)`** |

The media attribution was verified by reading `globals.css:1229-1281` directly, not inferred.

The bolded five are the **result-entry grid on a phone**: the venue key-in screen, during live
scoring, at **5.5–8px**, including `.egrid-score` — the input a staff member types a score into.
`20_P6_HANDOFF.md` §3 correctly identified the mobile group as "highest stakes" and then, following
the metric, scoped the four *plain* 9–10px rules while these five sat outside the count at roughly
**half that size**.

**Consequence for the plan.** Chasing the tracked metric to 0 would delete 5 dead rules and enlarge
some badges while leaving an 8px score input on the phone used at the competition. The metric must
be **redefined before it is chased**. §2.2 does that.

### 0.3 CORRECTION — the "sidebar renders two full menus" claim is not what `design.md:135` says it is

`20_P6_HANDOFF.md` §4 carries this from `design.md:135` as *"Rail + expanded rendered simultaneously,
toggled by CSS; DOM duplication and layered `aria-hidden`"*, and recommends CUT. **CUT is still the
right call, but the stated reason is wrong on both halves.**

- **Rail vs expanded is not a double render.** `app-shell.tsx:291` renders **one**
  `<aside className={\`sidebar${collapsed ? " sidebar--collapsed" : ""}\`}>`. The rail is a modifier
  class on the same element, not a second tree.
- **The real duplication is desktop sidebar vs mobile nav**, and it is *not* an accessibility defect.
  `globals.css:198` sets `.mobile-brand, .mobile-nav { display: none; }` at desktop, and
  `globals.css:1140` sets `.sidebar { display: none; }` inside `@media (max-width: 768px)`.
  `display: none` removes a subtree from the accessibility tree, so **exactly one navigation landmark
  is exposed at any viewport**. There is no layered-`aria-hidden` problem to fix.

What remains is a DOM-weight/render-cost question with **no baseline**, on the highest-risk file in
the repo. **CUT — for that reason, not the a11y one.**

### 0.4 CONFIRMED, with the missing detail that makes the fix safe — B8 runtime settings

Re-verified in source:

- `application.yml:105` — `ttl-seconds: ${RUNTIME_SETTINGS_CACHE_TTL_SECONDS:5}`
- `CardEventPublisher.java:51` — `HEARTBEAT_TICK_MS = 5_000L`, used at `:305` as `@Scheduled(fixedDelay = …)`
- `CardEventPublisher.java:311` — `if (now - lastHeartbeatAt < settings.get().heartbeatIntervalMs()) return;`

`settings.get()` is evaluated **before** any subscriber check, on every 5s tick, forever. With TTL 5s
against a 5s tick the cache is expired on nearly every tick. B8's measured **3 statements / 5s ≈
17,280 transactions/day** reproduces from the code path.

Two facts B8 did not record, both of which matter:

1. **`RuntimeSettingsService.update()` is `@CacheEvict(allEntries = true)`.** An admin change through
   the Realtime panel evicts the cache immediately; it does **not** wait for the TTL. The class
   javadoc states this outright. **Raising the TTL therefore costs nothing in admin-change latency.**
   The TTL only bounds staleness for changes made *outside* the process — a second replica, or a
   direct DB edit.
2. **`render.yaml` defines one `type: web` service, `plan: starter`, with no replica count**, and
   does **not** set `RUNTIME_SETTINGS_CACHE_TTL_SECONDS` — so production runs the `5` default on a
   single instance. With one instance, case (1)'s exception set is empty in practice.

This upgrades B8's fix from "cheapest" to "demonstrably free", and lets §2.7 state the cost honestly.

`flushResyncDebt()` (`:377-396`) also calls `settings.get()`, but inside a loop over `resyncDebt`
entries, so it contributes nothing at idle.

### 0.5 CONFIRMED and sharpened — D6 `FreshSecretInput`

`src/ui/components/fresh-secret-input.tsx` renders `<input type="text" value={value}>` and masks it
**visually only**, via `-webkit-text-security: disc` (`globals.css:45`), with an
`@supports not (-webkit-text-security: disc)` fallback (`:72-80`) that makes the text transparent and
shows an `aria-hidden` bullet span. `type="text"` is deliberate — it is what keeps browser password
managers from offering to save the secret, which is the whole reason the component exists, and D6
says the masking stays.

**Two separate defects, not one:**

| # | Defect | Standard | Evidence |
|---|---|---|---|
| **D6-a** | The real password is the input's **value** on a `type="text"` field, so it is exposed verbatim in the accessibility tree. A screen reader announces the characters. CSS masking is invisible to AT. This is the leak D6 names | — (the owner-acknowledged defect) | `fresh-secret-input.tsx:24-38` + `globals.css:45` |
| **D6-b** | The reveal toggle carries `tabIndex={-1}`, so **no keyboard user can reach it**. It is mouse-only | **WCAG 2.1.1 Keyboard (A)** | `fresh-secret-input.tsx:44` |

D6-b is new — not recorded in `20_`. It is a smaller, independent, lower-risk fix than D6-a.

8 call sites across 7 files: `staff-login`, `admin`, `director`, `cards/[id]/tables`,
`cards/[id]/games`, `player-termination`, `prompt-dialog`, `result-entry-grid`. All 8 pass either an
`id` with an external `<label>` or an `aria-label`, so accessible naming is **not** a defect here.

---

## 1. Baseline — measured this session

### 1.1 Gates at HEAD

| Gate | Result | Executed? |
|---|---|---|
| `npm test` | **178 pass / 0 fail / 0 skipped** | **yes, this session** |
| `npm run lint` | **0** | **yes, this session** |
| `npm run typecheck` | **0** | **yes, this session** |
| `shasum -c EVIDENCE.sha256` | **7/7 OK** | **yes, this session** |
| Working tree | **clean** | **yes, before and after** |
| `npm run build` | 0 | **no** — quoted from `19_P5_PARTIAL_CLOSURE.md` |
| Backend `mvn test` | 337 run / 0 fail / 0 skipped | **no** — quoted from `19_P5_PARTIAL_CLOSURE.md` |

Both un-run gates must be executed as part of any P6 chunk gate, not carried forward on quotation.

### 1.2 Stylesheet shape

The frontend has **one stylesheet**: `src/app/globals.css`, **1519 lines**. No CSS modules, no
Tailwind, no CSS-in-JS. 53 `.tsx` and 55 `.ts` files. Every measurement below is of that one file
with the `:root` block stripped, so token *definitions* are never counted as hard-coded *usages*.

| Category | Distinct values | Occurrences | Note |
|---|---|---|---|
| Custom properties defined | **25** | 457 `var()` reads | colours + 2 layout widths only |
| Hard-coded hex colours | **136** | 207 | outside `:root` |
| `rgba()`/`rgb()` literals | **25** | 30 | |
| `font-size` declarations | — | **223** with a px literal | see §0.2 |
| Spacing px in `gap`/`padding`/`margin` | **40** | **655** | |
| `border-radius` | 9 | 18 | |
| `box-shadow` | **21** | **27** | nearly every shadow is unique |
| `z-index` | **14** | 18 | 2, 3, 40, 80, 81, 90, 99, 100, 120, 121, 130, 300, 400, 1100 |
| `font-weight` | 8 | 88 | incl. 3 `!important` variants |
| `line-height` | 10 | 24 | |
| Transition durations | 14 | 47 | `.18s` dominant (19) |
| `font-family` | 5 declarations | 7 | **3 different monospace stacks** |
| `@media` breakpoints | **7** | 16 blocks | 520, 560, 720, 760, 768, 769, 1080 |

Base type: `body { font-size: 15px; line-height: 1.5; font-family: Roboto, "Noto Sans Thai", Arial, sans-serif }`.

**`--cyan: #008ca3` is defined and never used.** Dead token.

### 1.3 Component inventory

`src/ui/components` holds 34 source files. Three are very large and hold competition-critical UI:
`result-entry-grid.tsx` **57 KB**, `card-overview.tsx` **44 KB**, `data-grid.tsx` **31 KB**.

**Already healthy — do not "fix":**

| Primitive | Adoption |
|---|---|
| `Button` (`button.tsx`) | **110 JSX uses across 29 files**, 5 variants + 2 sizes. **0** raw `<button className="button …">` anywhere. |
| `Badge` (`badge.tsx`) | 5 tones, always explicit — the file comments that inferring tone from label text broke silently before |

The 29 remaining raw `<button>` elements are legitimately special (folder toggles, icon buttons,
listbox options, sortable table headers, mobile nav items), not `Button` bypasses.

Two small gaps: `Button` emits `button--md` for the default size and **no `.button--md` rule exists**
(a no-op class), and `Button` has no `loading` or icon-only affordance, which is what the 29 raw
buttons partly compensate for.

### 1.4 Duplication — measured

| Pattern | Implementations | Where |
|---|---|---|
| **Modal dialog** | **5 in TSX** | `confirm-dialog.tsx`, `prompt-dialog.tsx`, `card-overview.tsx` (×2: final-history, player-history), `overview-record-filter.tsx` |
| **Dialog CSS families** | **6** | `.confirm-dialog`, `.final-history-dialog`, `.history-dialog`, `.history-table-dialog`, `.termination-dialog`, `.dialog-backdrop` |
| **Popup / menu / listbox** | **5** | `.select-menu`, `.institution-combobox`, `.overview-record-filter__popup`, `.director-game-menu`, `.overview-game-menu` |
| **Escape-to-dismiss** | **7 independent handlers, 3 different targets** | `window` (`confirm-dialog:56`), `document` (`overview-record-filter:193`), inline element handlers (`prompt-dialog:77`, `select-menu:79`, `institution-combobox:82`, `data-grid:218`, `data-grid:390`) |
| **Focus management** | **ad hoc, 6 files** | no shared focus trap, no focus restore on close anywhere |

`prompt-dialog.tsx` already reuses `.confirm-dialog`'s CSS while duplicating its behaviour — evidence
the consolidation is natural rather than imposed.

### 1.5 Accessibility — measured, including what is *not* wrong

Contrast was computed for every token pair and for the specific declarations most likely to fail
(WCAG 2.x relative luminance).

**Contrast is mostly fine. Do not plan a contrast overhaul.**

| Result | Detail |
|---|---|
| `--ink` on `--surface`/`--canvas` | 12.52 / 11.57 — **AAA** |
| `--muted` on `--surface`/`--canvas` | 4.94 / 4.57 — **passes AA** |
| All 5 badge tones | 5.64 – 7.18 — **pass** |
| Mobile nav text and workflow tint on `--sidebar` | 8.31 / 6.30 — **pass** |
| `.data-table th`, `.table-subline`, `.cell-athlete__school` | 4.94 – 5.83 — **pass** |
| `--yellow` as text | used as text in exactly **one** place (`globals.css:1164`, mobile workflow link) and there it is on the dark sidebar at **6.30 — passes**. It is otherwise a border/background/box-shadow colour only |

**The genuine contrast findings, and they are few:**

| # | Finding | Ratio | Standard |
|---|---|---|---|
| **A11Y-1** | `.button--success` — white on `--green #2f8a4b` | **4.32** | fails **WCAG 1.4.3 (AA)** for normal text; needs 4.5 |
| **A11Y-2** | `--border-strong #b9c0ca` on white, used as the boundary of **29** form controls | **1.83** | fails **WCAG 1.4.11 (AA)** non-text contrast; needs 3.0 |
| **A11Y-3** | `--muted` on the soft tints (`--blue-soft`/`--green-soft`/`--red-soft`) | 4.31 – 4.40 | marginally fails 1.4.3 |
| — | `.button:disabled` #8a929d on #e2e5e9 | 2.49 | **not a failure** — disabled controls are exempt |

**The genuine non-contrast findings:**

| # | Finding | Standard | Evidence |
|---|---|---|---|
| **A11Y-4** | **38 `<th>` elements, 0 with `scope`.** 9 `<table>`, 0 `<caption>` | **WCAG 1.3.1 (A)** | repo-wide grep |
| **A11Y-5** | `.egrid-filterpop__search input { outline: none }` with **no `:focus-within` fallback on its wrapper** — the focus indicator is simply gone | **WCAG 2.4.7 (AA)** | `globals.css:1341-1343` |
| **A11Y-6** | Text below 11px — see §0.2. **45 declarations always render under 11px**, worst case **5.5px** | readability (no numeric WCAG threshold, which is why it needs an owner-set budget) | §0.2 |
| **A11Y-7** | D6-a / D6-b | — / **WCAG 2.1.1 (A)** | §0.5 |
| **A11Y-8** | No shared focus trap or focus restore across 5 dialogs; Escape bound 7 different ways | **WCAG 2.4.3 (A)** | §1.4 |

Checked and **clean** — do not spend P6 budget here: `.search-field input`'s `outline: 0` **does**
have a `:focus-within` fallback (`globals.css:460`); `.button:focus-visible, a:focus-visible` covers
buttons and links; tap targets pass WCAG 2.5.8 (`.button` min-height 40px, `.button--sm` 34px,
smallest interactive 28px ≥ 24px); `prefers-reduced-motion` blocks exist at `:883` and `:987`.

---

## 2. P6 — Engineering quality + accessibility

**Framing.** P6's job is to leave behind *rules that hold*, not a list of fixed examples. Every chunk
below therefore pairs a fix with the thing that stops it regressing.

### 2.1 Scope

| | |
|---|---|
| **In** | The sub-11px typography floor under a **redefined** metric; the 5 dead rules; D6-a and D6-b; table semantics; one lost focus indicator; the runtime-settings read; a written overlay-accessibility contract that P7 must implement against; a CSS regression guard |
| **Out** | Any visual token work (that is P7); any consolidation of dialogs or menus (P7); `/admin` request count; D3 admin narrowing; B7/SECURITY-01; bulk player import; the sidebar/mobile-nav DOM duplication |

### 2.2 P6-A — Redefine the metric, then delete what is dead  ·  MUST

`00_MASTER_PLAN.md` §6's row *"Font sizes below 11px: 31 → 0"* is unreachable and, as §0.2 shows,
measures the wrong thing. Replace it with a definition that counts every syntax and admits that some
small text is deliberate.

**Proposed metric (owner sign-off required — see §4):**

> **Minimum rendered text size.** No declaration may render below **11px at any viewport**, except an
> explicit allow-list of non-prose micro-labels (uppercase badges, chips, eyebrows), each listed by
> selector with a reason, and none below **10px**.

Under that definition the baseline is **45 declarations always under 11px** (35 plain + 10 clamp) and
**60 that can render under 11px**, against a tracked metric that reports 35.

Work in this chunk:

1. Delete the 5 dead rules — `globals.css` lines **486, 489, 492, 496, 1056** (`.physical-table > header span`,
   `.physical-match__label`, `.physical-player__position`, `.physical-player small`, `.pair-result-board td`)
   **and the rest of their now-orphaned families** — the whole dead block is `globals.css`
   **483-499** (`physical-*`, 17 lines) and **1054-1056** (`pair-result-board`, 3 lines).
   Verified dead in §0.1.
2. Add `docs/ux-refactor/` note restating the metric; update the living `00_MASTER_PLAN.md` §6 row.
   **Do not edit `02_ARCHITECTURE_DECISIONS.md`** — frozen.

| | |
|---|---|
| **Files** | `src/app/globals.css`, `docs/ux-refactor/00_MASTER_PLAN.md` |
| **Baseline** | 45 always-under-11px; 5 dead rules present |
| **Target** | 40 always-under-11px; 0 dead rules; metric restated |
| **Verification** | re-run the §0.2 scan; `npm run build` succeeds; visually diff the pages that used to match those selectors — **there are none**, which is the point |
| **Rollback** | single commit, CSS-only revert |

### 2.3 P6-B — The typography floor  ·  MUST (C1, C4) / SHOULD (C2, C3)

Four sub-chunks, deliberately separate commits because their risk is not the same.

| Sub | Scope | Lines | Risk | Call |
|---|---|---|---|---|
| **B1** | **Mobile-only plain rules** — `.mobile-nav .nav-link__text` 10px, `.overview-game-published` 10px, `.entry-keyin__label` 9px, `.entry-keyin__feedback` 10px | 1162, 1172, 1460, 1464 | layout density on a phone | **MUST**, after a real-viewport check |
| **B2** | **Content text read for meaning** — `.data-table th`, `.table-subline` ×2, `.game-flow__item small`, `.institution-combobox__option-text small`, `.archive-game-flow .game-flow__item small`, `.overview-record-filter__options small` | 296, 300, 397, 525, 796, 1066, 1118 | low | **SHOULD** |
| **B3** | **Form labels** — `.compact-field label`, `.entry-filter label`, `.director-game-picker__label`, `.overview-game-select label` | 410, 632, 888, 892 | low | **SHOULD** |
| **B4** | **The 10 `clamp()` rules that are always under 11px** — §0.2 table. Includes the five `@media (max-width: 560px)` result-grid rules at **5.5–8px** | 947, 981, 999, 1003, 1013, 1273, 1274, 1276, 1277, 1278 | **highest in P6** — this is the live scoring grid | **MUST** |

**B4 is the reason P6 exists.** It is also the riskiest CSS in the phase: the result grid is a dense
table whose column count is fixed by the data, so raising type there trades legibility against
horizontal scrolling. It must be driven by measurement at a real viewport, not by a target number.

> **Responsive verification is a trap, per `20_` §6 and `18_` §9.** A CDP viewport override does
> **not** fire `matchMedia` `"change"`, and a headless pane reports `innerWidth: 0` until explicitly
> resized. Set real dimensions, reload, and confirm the breakpoint took effect before reading
> anything. Verify at **375px, 390px and 560px** — the two common phone widths and the breakpoint
> boundary itself.

| | |
|---|---|
| **Files** | `src/app/globals.css` only |
| **Baseline** | 40 always-under-11px after P6-A; smallest rendered text **5.5px** |
| **Target** | ≤ the agreed allow-list; smallest rendered text **≥ 10px**, and **≥ 11px** outside the allow-list |
| **Invariants** | the result grid must still fit its columns without horizontal scroll at 375px; `.egrid-score` must remain tappable and typable |
| **Tests** | the §2.6 CSS guard pins the floor |
| **Runtime** | screenshot the result-entry grid at 375/390/560px before and after; enter a score at 375px and confirm the save path still works |
| **Rollback** | one commit per sub-chunk; CSS-only |

**Explicitly NOT in B1–B4:** the ~15 badge / chip / eyebrow / hint / archive rules
(`globals.css` 156, 170, 302, 500, 518, 543, 589, 598, 726, 748, 770, 802, 1061, 1064, 1069).
`20_` §3 called these intentional metadata styling and deferred them to P7. **Agreed** — they are
uppercase micro-labels whose size is bound up with the type scale P7 defines, and enlarging them
changes density across many screens for no measured benefit. They belong to the P7 allow-list
decision, not to a P6 sweep.

### 2.4 P6-C — D6 `FreshSecretInput`  ·  MUST

Two independent commits.

**C1 — D6-b, the keyboard trap.** Remove `tabIndex={-1}` from the reveal toggle
(`fresh-secret-input.tsx:44`). The button already has `aria-label`, `title`, `type="button"` and an
`onMouseDown` preventDefault that keeps focus in the input on click. Small, isolated, WCAG 2.1.1.
*Check while doing it:* whether reaching the toggle by Tab now sits between the field and the submit
button in all 8 call sites, and whether that ordering is acceptable in the login form.

**C2 — D6-a, the screen-reader leak.** This one needs a decision, not a default. The constraint is a
genuine three-way: keep the visual mask (D6, shared venue machines), keep password managers away
(the component's reason to exist), stop AT reading the characters.

| Option | Fixes the leak | Keeps managers away | Cost / risk |
|---|---|---|---|
| **1. `type="password"`** | **yes** — AT announces "dot", the protected state is the platform's own | **weakens it** — Chrome largely ignores `autocomplete="off"` on password fields; the `data-*` ignore attributes still cover 1Password/Bitwarden/LastPass/Proton but not the built-in Chrome/Safari manager | small diff, but risks reintroducing exactly the save prompt the component was built to suppress. **Must be tested in Chrome and Safari before adoption** |
| **2. Keep `type="text"`, add `aria-*`** | **no** — there is no ARIA attribute that masks a value. `aria-hidden` on a focusable input is invalid and would make the field unusable | yes | **rejected — does not work.** Recorded so it is not re-proposed |
| **3. Reveal-gated `type` swap** — `type="password"` while masked, `type="text"` while revealed | **yes** while masked | partial — the manager heuristic fires on the password state | keeps D6's mask semantics exactly; the swap is one expression. Focus/caret position must be checked across the swap |

**Recommendation: Option 3**, falling back to Option 1 if the swap misbehaves — it fixes the leak in
the state that matters (masked) and confines manager exposure to the state the user explicitly opted
into. **Owner decision — see §4.** Do not implement C2 before it is settled.

| | |
|---|---|
| **Files** | `src/ui/components/fresh-secret-input.tsx`; possibly `globals.css:43-80` if `-webkit-text-security` becomes redundant |
| **Blast radius** | 8 call sites / 7 files, including `staff-login` — **the login path for every staff account, days before a competition** |
| **Verification** | AT check that the value is not announced; keyboard-only reveal; **manual Chrome + Safari check that no save-password prompt appears** at `staff-login` and at the re-auth prompt in `cards/[id]/tables`; all 8 call sites still submit |
| **Tests** | no React test setup exists in this repo (`18_` §9). Behaviour is runtime-verified; pure logic here is minimal |
| **Rollback** | two commits, one per defect; both frontend-only, both trivially revertible |

### 2.5 P6-D — Table semantics and the lost focus indicator  ·  SHOULD

Two small, mechanical, high-confidence fixes.

- **D1 — A11Y-4.** Add `scope="col"` / `scope="row"` to the **38** `<th>` elements, and an accessible
  name (`aria-label`, or `<caption>` where a visible one is appropriate) to the **9** `<table>`
  elements. Files: `data-grid.tsx`, `standings-grids.tsx`, `player-history-table.tsx`,
  `result-entry-grid.tsx`, `final-round-board.tsx`, `card-overview.tsx`.
  **Caution:** `result-entry-grid.tsx` and `data-grid.tsx` are the two most competition-critical
  files. `scope` is a non-rendering attribute and cannot change layout — but the edits must be
  attribute-only, with no restructuring, and reviewed as such.
- **D2 — A11Y-5.** Give `.egrid-filterpop__search` a `:focus-within` rule mirroring
  `.search-field:focus-within` (`globals.css:460`), the pattern already used elsewhere in this file.

| | |
|---|---|
| **Baseline** | 38 `<th>` / 0 `scope`; 9 `<table>` / 0 accessible names; 1 control with no focus indicator |
| **Target** | 38/38, 9/9, 0 |
| **Verification** | accessibility-tree read of one grid; Tab to the filter search box and see a ring |
| **Rollback** | one commit each |

### 2.6 P6-E — The regression guard  ·  MUST

Without this, P6 is a list of fixes that decay. With it, P6 is a rule.

Add a node test — **in a directory already enumerated by the `npm test` glob**, or extend the glob in
the same commit — that parses `globals.css` and **fails** when:

1. any `font-size` renders below the agreed floor at any viewport, `clamp()` included, unless its
   selector is on the allow-list (this is the §0.2 scan, promoted to a test);
2. an `outline: none` / `outline: 0` on a focusable selector has no `:focus-visible` or
   `:focus-within` counterpart;
3. *(optional, P7 hand-off)* a new hard-coded hex appears outside `:root` once P7 lands the token
   layer — **assert-only-does-not-grow**, seeded at whatever P7 finishes with.

> **`npm test` enumerates test DIRECTORIES in `package.json`.** A test in a new directory silently
> never runs. This bit P5 (`19_` §3). Extend the glob in the same commit as the test, and prove it
> runs by watching the count rise from **178**.
>
> **CI does not run `npm test` at all** (`.github/workflows/ci.yml` runs lint, typecheck, build,
> `mvn test`). This guard protects local runs only unless CI changes — an owner call (§4), and one
> `04_BLOCKERS.md` B6 already recommends now that the suite is green.

### 2.7 P6-F — The runtime-settings read  ·  SHOULD

Per §0.4 the measurement holds and the fix is cheaper than recorded. Two candidate fixes:

| | Fix | Effect at idle | Effect during an event | Risk |
|---|---|---|---|---|
| **F-a** | Raise `RUNTIME_SETTINGS_CACHE_TTL_SECONDS` — change the `application.yml:105` default from `5` to `60` (or set it in `render.yaml`) | 17,280 → **1,440** tx/day | same reduction; settings are near-static | **none measurable.** `@CacheEvict` makes admin changes immediate regardless; one instance means no cross-replica staleness |
| **F-b** | Guard `heartbeat()` — return early when all three emitter maps are empty, placed **after** `flushResyncDebt()` and **before** `:311` | 17,280 → **0** | unchanged (subscribers exist) | one line in `CardEventPublisher.java`, an SSE file P4 already modified under approval. Not frozen, but SSE-adjacent |

**Recommendation: F-a alone.** It is config, it needs no reasoning about SSE lifecycle, and it
captures the benefit in both states. F-b is strictly better at idle but buys 1,440 tx/day for a code
change in the SSE publisher three weeks before a competition — a bad trade. **Take F-a; record F-b as
available.**

> **Honest limit: neither fix reaches production without a backend deploy**, and per
> `render-deploys-from-main`, production only moves on a merge to `main`. This session's constraints
> forbid deployment. P6 can *land the change*; realising it is an owner decision about deploy timing.
> The item is also **idle-cost only in impact terms** — it does not affect competition-day behaviour,
> which is why it is SHOULD and not MUST.

| | |
|---|---|
| **Files** | `backend/src/main/resources/application.yml` (1 line) |
| **Verification** | with the local stack idle and no SSE subscribers, count `runtime_settings` SELECTs over 60s: expect ~12 before, ~1 after. **This must be measured, not assumed** |
| **Tests** | backend `mvn test` as regression — the value is a default, not logic |
| **Rollback** | one-line revert |

### 2.8 P6-G — The overlay accessibility contract  ·  MUST (document only)

**No code.** P6 writes down the contract; **P7 implements it.** This is the hinge between the phases
and the reason they are ordered this way.

The contract every overlay must satisfy, derived from §1.4 and §1.5:

1. one Escape binding, one event target, one place;
2. focus moves into the overlay on open and **returns to the invoking element on close** — nothing
   does this today;
3. focus is trapped while `aria-modal="true"` — or `aria-modal` is dropped where the overlay is not
   really modal;
4. `role`, `aria-modal` and labelling are chosen by what the thing *is*: a filter popover
   (`overview-record-filter.tsx:374-378`) currently declares `role="dialog" aria-modal="true"` — that
   should be re-examined, not copied into a primitive;
5. the trigger owns `aria-expanded` / `aria-controls`;
6. dismissal by backdrop click and by Escape behave identically.

Deliverable: a section in the P6 closure document, and the acceptance criteria for P7-C and P7-D.

### 2.9 P6 — MUST / SHOULD / DEFER

| Call | Items |
|---|---|
| **MUST** | P6-A (metric + dead CSS) · P6-B1 + **P6-B4** (mobile + the clamp floor) · P6-C1 (keyboard trap) · **P6-C2 once the owner picks an option** · P6-E (regression guard) · P6-G (contract, doc only) |
| **SHOULD** | P6-B2, P6-B3 (content + labels) · P6-D1, P6-D2 (table semantics, focus ring) · P6-F (TTL) |
| **DEFER** | A11Y-1 `.button--success` 4.32 and A11Y-3 muted-on-tints — both are **token colour changes**, which is P7's subject; fixing them in P6 means editing colours twice · A11Y-2 `--border-strong` 1.83 — same reason, and it restyles every form control · bulk player import (B9) — measured, registration-time only, owner call · badge/eyebrow/hint/archive sizes — P7 type scale |
| **NOT P6** | `/admin` ≤ 8 requests (needs a backend batch endpoint or D3) · B7/SECURITY-01 · D17 · P1-D · `HttpSessionEventPublisher` · sidebar/mobile-nav DOM duplication (§0.3) |

---

## 3. P7 — UI / design system standard

**Framing.** P7 is not a redesign and must not become one. The audit says so: `Button` and `Badge`
are already well-adopted primitives, colour contrast is largely fine, and the base type is sane. What
is missing is **everything below the colour layer** — there is no scale for space, type, radius,
elevation, or stacking — and **five overlays that each invented their own behaviour**.

The success test is the one in the brief: a developer who needs a confirmation dialog finds one
instead of building a sixth.

### 3.1 Audit summary — what actually exists

| Layer | State | Evidence |
|---|---|---|
| **Colour** | **Good.** 25 tokens, 457 `var()` reads, semantic triads (`--x` / `--x-dark` / `--x-soft`). Contrast mostly passes | §1.2, §1.5 |
| **Colour leakage** | **Bad.** 136 distinct hard-coded hex (207 uses) + 25 distinct `rgba()` (30 uses) live outside the token layer — mostly hover/active/border shades that *should* be derived | §1.2 |
| **Spacing** | **No system.** 40 distinct px values over 655 uses. A 4px-ish grid exists (8, 10, 12, 4, 6 dominate) but with off-grid neighbours at 7, 9, 11, 13, 15, 17 | §1.2 |
| **Type** | **No scale.** 223 `font-size` declarations, ad hoc `clamp()` throughout, 45 always under 11px | §0.2 |
| **Weight** | 8 values incl. 3 `!important` — 700/800/900 used almost interchangeably | §1.2 |
| **Radius** | Nearly systematic already: 999 / 8 / 6 / 5 / 4 / 2px. Cheapest layer to tokenise | §1.2 |
| **Elevation** | **No system.** 21 distinct shadows for 27 uses — essentially one bespoke shadow per component | §1.2 |
| **Stacking** | **No system, and a real hazard.** 14 distinct `z-index` values, 2 → 1100, with adjacent pairs (80/81, 120/121) that encode an ordering nobody can see | §1.2 |
| **Motion** | 14 durations for 47 transitions; `.18s` is the de facto standard | §1.2 |
| **Breakpoints** | **7**, several near-duplicates: 720 / 760 / 768 / 769, and 520 / 560 | §1.2 |
| **Overlays** | **5 dialogs, 6 dialog CSS families, 5 popups, 7 Escape handlers, 0 focus restores** | §1.4 |
| **Buttons / badges** | **Already standardised.** Leave alone except the two gaps in §1.3 | §1.3 |

### 3.2 Proposed token categories

Additive to the existing 25. **No token renames** — 457 existing reads must keep working.

| Category | Proposal | Derived from |
|---|---|---|
| `--space-*` | 4px base: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32 | the 655 measured uses; covers the dominant values without inventing any |
| `--text-*` | ~7 steps anchored on the existing `body` 15px, plus an explicit `--text-min` floor | §2.2's agreed floor |
| `--weight-*` | regular / medium / bold / heavy — collapsing 700/800/900 to a defensible three | the 88 uses |
| `--radius-*` | xs 2 · sm 4 · md 6 · lg 8 · pill 999 | already almost exactly what exists |
| `--shadow-*` | 4 steps: raised / overlay / dialog / inset-marker | the 21 bespoke shadows collapse into these |
| `--z-*` | named layers: base / sticky / dropdown / overlay / dialog / toast | replaces 14 magic numbers |
| `--dur-*` | fast .12 · base .18 · slow .24 | `.18s` already dominates |
| `--bp-*` | 3 breakpoints (~560 / 768 / 1080), collapsing 720/760/768 and 520/560 | **behaviour-changing — see §3.6** |
| — | **delete `--cyan`** | unused (§1.2) |

### 3.3 Canonical component candidates

| Rank | Primitive | Replaces | Why it is first |
|---|---|---|---|
| **1** | **`Dialog`** | 5 TSX implementations, 6 CSS families | Highest duplication **and** the §2.8 contract has nowhere to live without it. `prompt-dialog` already borrows `confirm-dialog`'s CSS |
| **2** | **`Popover` / `Menu`** | `select-menu`, `institution-combobox`, `overview-record-filter`, `director-game-menu`, `overview-game-menu` | 5 implementations of positioning + outside-click + Escape + roving focus |
| **3** | **`Field`** | scattered `.form-field` / `.compact-field` / `.form-label` markup | Where label association, error text, and `aria-describedby` become guaranteed rather than per-site |
| **4** | **`Table` conventions** | `.data-table`, `.entry-grid`, `.dense-player-table` | Probably **conventions + a header helper, not one component** — these three have genuinely different jobs. Carries the §2.5 `scope` fix forward |
| **5** | `Button` **extension** | the `--md` no-op; no loading or icon-only variant | Small; closes the gap that pushes people to raw `<button>` |

**Not a candidate:** anything that would restructure `result-entry-grid.tsx` (57 KB) or
`card-overview.tsx` (44 KB). They *consume* the primitives; they are not rewritten by P7.

### 3.4 Migration strategy

Strictly ordered; each step independently revertible.

1. **P7-A — add the token layer. Zero visual change.** Tokens defined and unused. Provable: the built
   CSS should differ only by the added `:root` declarations.
2. **P7-B — migrate values to tokens, mechanically.** Only where the literal **exactly** equals a
   token value. No rounding, no "close enough" — a 7px that becomes 8px is a visual change smuggled
   into a mechanical commit, and must be a separate, justified diff.
3. **P7-C — `Dialog`,** implementing the §2.8 contract. Migrate `confirm-dialog` and `prompt-dialog`
   first (they already share CSS), then the two `card-overview` dialogs, then re-examine
   `overview-record-filter`'s `role`/`aria-modal` (§2.8 item 4) rather than porting it as-is.
4. **P7-D — `Popover`/`Menu`.** `select-menu` first (smallest, already a listbox), then
   `institution-combobox`, then the two game menus. `overview-record-filter` last — it is 21 KB and
   has a bottom-sheet transition with `onTransitionEnd` close sequencing.
5. **P7-E — `Field`,** then the deferred A11Y-1/2/3 contrast fixes, which are token edits by then.
6. **P7-F — the type scale,** including the badge/eyebrow/hint/archive rules deferred from P6-B, and
   the allow-list those need.
7. **P7-G — the guide.** One page: which primitive for which job, and the §2.8 contract as
   acceptance criteria. Without this P7 has no mechanism to change what the next developer does.

### 3.5 Verification

| | |
|---|---|
| **Per step** | `npm test` · lint · typecheck · **production build** · frozen checksum · tree clean |
| **P7-A/B** | **built-CSS diff**, not eyeballing. A token migration that changes a single computed value has failed |
| **P7-C/D** | per overlay, at runtime: open, Escape, backdrop click, **focus returns to the trigger**, focus is trapped while open, `aria-expanded` tracks. This is the §2.8 contract used as a test |
| **Responsive** | 375 / 390 / 560 / 768 / 1280px, with the `matchMedia` caveat from §2.3 |
| **A11Y** | accessibility-tree read per migrated overlay; keyboard-only pass over login, result entry, and one dialog |
| **Invariants** | after any change touching `app-shell.tsx`: re-measure **shell renders per SSE result event = 0**. After anything near a console: **refocus = 1 request** |

### 3.6 Regression risks

| Risk | Why | Mitigation |
|---|---|---|
| **Breakpoint consolidation changes layout** | 720 / 760 / 768 are *not* interchangeable — they were probably each chosen against a real device | **Do not consolidate breakpoints in the mechanical pass.** Treat each as its own justified change, or **DEFER** the whole `--bp-*` category |
| **`app-shell.tsx`** | P3-E restructured it for zero shell renders per SSE event; P5-D21's `foldersAfterOpening` deliberately returns the same `Set` to preserve that | Measure before/after. Do not touch its render path for styling |
| **`result-entry-grid.tsx` (57 KB)** | live scoring; holds the draft/save/version logic the P4 warning depends on | P7 changes its **classes and primitives only**, never its state or save path |
| **Shadow/z-index consolidation** | collapsing 21 shadows and 14 z-indexes will reorder something | Migrate z-index **last**, one overlay family at a time, checking stacking against toasts and dialogs together |
| **Dialog consolidation changes focus behaviour** | today nothing restores focus; the primitive will | That is the intended fix, but it **changes behaviour** for every existing dialog. Verify each rather than assuming improvement |
| **No React test setup** | `18_` §9 — dialog rendering cannot be unit-tested here | Runtime verification per overlay; adding a React testing stack is **out of scope** and should not be smuggled in |

### 3.7 P7 — MUST / SHOULD / DEFER

| Call | Items |
|---|---|
| **MUST** | P7-A tokens · P7-B mechanical migration · **P7-C `Dialog`** (the §2.8 contract has no home without it) · P7-G the guide |
| **SHOULD** | P7-D `Popover`/`Menu` · P7-E `Field` + the deferred contrast fixes · P7-F type scale + allow-list · `Button` `--md`/loading/icon-only |
| **DEFER** | `--bp-*` breakpoint consolidation (§3.6) · `Table` unification beyond conventions + the `scope` helper · dark mode (already **AFTER COMPETITION**) · anything touching `result-entry-grid.tsx`'s or `card-overview.tsx`'s structure |

---

## 4. Owner decisions required before implementation

| # | Decision | Blocks | Default if unanswered |
|---|---|---|---|
| **O1** | **Accept the restated font metric** (§2.2): floor 11px at every viewport, `clamp()` counted, with a named allow-list down to 10px for uppercase micro-labels | P6-A, P6-B, P6-E | **blocking** — P6 has no target without it |
| **O2** | **`FreshSecretInput` D6-a: option 1, 2 or 3** (§2.4). Recommendation: **3** | P6-C2 | **blocking** — touches the staff login path |
| **O3** | **Does P6-B4 raise the mobile result grid even if a column has to scroll?** Legibility vs. fitting the grid on one screen at 375px | P6-B4 | assume **legibility wins**, verify at runtime, present both screenshots |
| **O4** | **Add `npm test` to CI?** `04_BLOCKERS.md` B6 recommends it now the suite is green; without it the P6-E guard protects local runs only | P6-E's value | proceed without; note the limit |
| **O5** | **Deploy timing for P6-F.** The backend change is inert until a merge to `main` | realising P6-F | land the commit, do not deploy |
| **O6** | **Is P7 approved to start at all?** `00_MASTER_PLAN.md` §4 lists P7 under **CUT IF LATE**, and the competition is ~3 weeks from 2026-08-22 | all of P7 | **blocking** — see §6 |

---

## 5. Do NOT touch

Beyond the standing frozen set in `03_INVARIANTS.md` §1, these are specific to P6/P7:

| Item | Why |
|---|---|
| `docs/ux-refactor/02_ARCHITECTURE_DECISIONS.md`, `01_`, `03_`, `04_`, `05_`, `06_`, `fixtures/sse-baseline.json` | **Frozen evidence.** Editing any of them fails `EVIDENCE.sha256`. P5 already made this mistake and had to revert (`19_` §1). D-series status goes in closure docs and the living master plan |
| `store.ts` — `replaceCard`, `applyResultPatch`, `applyPairingsPatch`, `applySnapshotPublish`, `mutateCard` | Frozen SSE patch layer. `applyResultPatch` carries P4's contiguity guard; the version-gap resync depends on it |
| `use-card-sync.ts`, `use-public-sync.ts`, `snapshot-api.ts` | Frozen. `use-card-sync.ts` already holds **one** owner-approved P4 exception — not a general licence |
| `TournamentCardService.java` pairing/ranking/diff/Gibson/final-round; `publicsnapshot/**` | Tournament business logic and the publish pipeline |
| Module-level store state — `publicScopeToken` (8 sites), `publishedTokens`, `bundleInflight` | Invisible in any diagram; a restructure drops them silently |
| `QueryClient` default `refetchOnWindowFocus: false` | P3-D2. It is what holds refocus at 1 request |
| `app-shell.tsx` **render path** | P3-E's zero-shell-renders result and P5-D21's reference-equality `Set`. Styling changes only, measured |
| The 29 raw `<button>` elements | Not `Button` bypasses — folder toggles, listbox options, sortable headers. Converting them would be a regression |
| `Button` / `Badge` variant APIs | Already standardised and adopted (110 / 5). Extend; do not redesign |
| Breakpoint values, in the mechanical pass | §3.6 |
| `If-Match` in `mutateCard`; `WebPushService`; `notification-sw.js`; `/tournaments` and `/cards/[id]/standings` redirects; the `staff-login` redirect guard | `03_INVARIANTS.md` §2 — look dead, are not |

---

## 6. Sequencing, and one thing the owner should weigh

The brief's order is right and this plan follows it:

```
P6 implementation → P6 gates → P6 closure → P7 implementation → P7 gates → P7 closure
```

P6 before P7 specifically because **§2.8's overlay contract is P7-C's acceptance criteria**, and
because the deferred contrast items (A11Y-1/2/3) are token edits that would otherwise be made twice.

**The thing to weigh (O6).** `00_MASTER_PLAN.md` §4 lists P7 under **CUT IF LATE**. Today is
2026-08-22 and the competition is **~3 weeks out**, with **no staging environment**, **no CI coverage
for `npm test`**, and ten staff to brief. P7 as scoped here rewrites the overlay layer of an
application that is about to run a live event.

That is not an argument against P7 — the brief is right that the foundation is worth building, and
§3 is a real plan for it. It is an argument about **when**. Two defensible readings:

- **Now:** P7-A/B (tokens + mechanical migration) are genuinely near-zero-risk and provable by
  built-CSS diff. They could land before the competition and make everything after it cheaper.
- **After:** P7-C/D (dialogs and menus) change runtime focus behaviour across the whole app, and the
  repo has no React test setup to catch a regression. The natural window is after the event.

**Recommendation: split P7 on exactly that line** — take **P7-A, P7-B and P7-G** now as the
foundation the brief asks for, and schedule **P7-C through P7-F** for immediately after the
competition, with this document as their plan. This is offered as a recommendation, not a decision;
if the owner wants all of P7 before the event, §3 covers it in full and the sequencing above stands.

---

## 7. Status

```
P6: NOT STARTED — planned above, blocked on O1 and O2
P7: NOT STARTED — planned above, blocked on O6
SOURCE CHANGED THIS SESSION: none
DOCS ADDED THIS SESSION:     this file only
```
