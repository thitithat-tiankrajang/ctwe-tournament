# Typography standard (P6-A)

Normative for all new UI. Enforced by `src/app/globals.test.ts`.

---

## 1. The scale

Declared in `globals.css` `:root`. **Never write a bare px font-size** — use a token, or a
`clamp()` whose floor is a token.

| Token | Size | Use for | Do NOT use for |
|---|---|---|---|
| `--text-xs` | **11px** | badges, chips, status flags, eyebrows, counts, column headers at narrow widths | prose, anything a user reads a sentence of |
| `--text-sm` | 12px | field labels, metadata, secondary/supporting text, dense table cells at narrow widths | primary content |
| `--text-md` | 13px | dense tabular data, small buttons, scores | |
| `--text-base` | 15px | body and primary content (matches `body`) | |
| `--text-lg` | 17px | section headings | |
| `--text-input-touch` | 16px | **every text input at ≤768px** — see §3 | anything that is not an input |

Base: `body { font-size: 15px; line-height: 1.5 }`, Roboto + Noto Sans Thai.

## 2. The floor: 11px, at every viewport

**No text may render below 11px at any viewport width.** This includes the *first argument* of a
`clamp()`, which is where the violations actually lived — the old metric counted only bare px
values and so reported 35 while missing the worst cases entirely (`21_P6_P7_PLAN.md` §0.2).

**Why 11 and not 9.** The interface is Thai. Thai stacks upper vowels and tone marks above the base
glyph and sara-u marks below it; at 9px those marks collapse into each other and words that differ
only by tone become visually identical. A Latin-derived minimum is not transferable. 11px is also
what the owner's own design audit settled on for content text (`design.md` UI-F2, "ขั้นต่ำ 11–12px").

## 3. Inputs are 16px on touch-width viewports

Below 16px, iOS Safari zooms the page when a field receives focus, which throws the operator out of
position mid-entry. On the result-entry screen that happens on every single field.

This was already the codebase's own rule — `.overview-record-filter__searchbox input` carried it,
with a comment saying exactly this. P6-A applies it to every text field instead of one, in a single
`@media (max-width: 768px)` block.

## 4. Responsive type scales by WIDTH, never by pointer

The grid's desktop sizes used to sit behind `@media (min-width: 769px) and (hover: hover)`. A
1024px touch tablet reports `hover: none`, fell through the gate, and got the narrow-screen sizes at
desktop width. **Reading size is a function of viewport width. Pointer type governs hit targets, not
type size** — the one rule still gated on `hover` is the score input's height, which is legitimately
a pointer concern.

Prefer **one fluid `clamp()` per role** over stepped breakpoint overrides:

```css
/* floor is a token; the middle term carries the fluid growth; the cap ends it */
font-size: clamp(var(--text-sm), .35vw + 8.5px, 13.5px);
```

This removed both the `≥769px` and the `≤560px` type-override blocks. Type is now continuous — there
is no breakpoint at which it jumps.

## 5. Density: scroll the table, do not shrink the type

At 375px the result/ranking grid used to fit six columns by shrinking headers to **5.81px** and
player names to **7.15px** (measured, not estimated). That is not a density trade-off; it is data
that cannot be read.

The rule: **type holds the floor and the table overflows into its scroller.** `.entry-grid-scroll`
already had `overflow-x: auto`; it was simply never reached, because `table-layout: fixed` made the
table exactly as wide as its container. Below the desktop breakpoint the grid now uses
`table-layout: auto; width: max-content`, so columns take their content width and the overflow is
real.

**The boundary is ≤768px, not ≤560px** — found by measuring, not by reasoning. Scoped to ≤560 first,
the fix left **59 clipped cells at 768px**: wide enough that `table-layout: fixed` still tried to
distribute the container width, narrow enough that legible type no longer fitted. Truncating a
player's name is the same data loss as shrinking it to 7px.

Desktop (≥769px) is untouched — it keeps `table-layout: fixed` and its resizable columns.

Measured outcome, public viewer, `/tour/bkk`:

| | 375px before | 375px after | 390px after | 1280px before | 1280px after |
|---|---|---|---|---|---|
| Column header | **5.81px** | 11px | 11px | 11.94px | 12.48px |
| Data cell | 7.15px | 12px | 12px | 12.96px | **12.98px** |
| Player name | 7.15px | 12px | 12px | 11.68px | 12.34px |
| School line | 7px | 11px | 11px | **9.64px** | 11.2px |
| Cells clipped by ellipsis | — | **0** | 0 | 0 | 0 |
| Grid scrolls horizontally | no | yes (436 in 364) | yes (473 in 364) | no | no |
| Page overflows horizontally | no | **no** | no | no | no |

Swept across the range after the boundary fix — smallest rendered text and clipped cells:

| Viewport | 375 | 390 | 768 | 1024 | 1280 |
|---|---|---|---|---|---|
| Smallest rendered text | 11px | 11px | 11px | 11px | 11px |
| Cells clipped | 0 | 0 | **0** (59 before the boundary fix) | 0 | 0 |
| Page overflows horizontally | no | no | no | no | no |

1024px is the interesting column: a touch tablet there reports `hover: none`, so under the old
pointer gate it fell through to phone sizing at desktop width. It now renders 11.6–12px like any
other 1024px viewport.

Desktop lands within ~1px of where it was: the change lifts the floor, it does not resize the app.
The one real desktop movement is the school line, which was **9.64px** and is now above the floor.

## 6. What is allowed to stay small

`--text-xs` (11px) is a floor, not a target. It is correct for uppercase micro-labels — badges,
status chips, the "ปัจจุบัน" folder flag, eyebrows, filter counts — where the text is a token to be
recognised, not read. It is wrong for anything a user reads as language.

There is no allow-list below 11px. Nothing needs one.

## 7. Checklist for a new rule

1. Is there a token for this role? Use it.
2. Need it fluid? `clamp(var(--text-*), <fluid>, <cap>)` — the floor **must** be a token.
3. Is it an input? It must reach 16px at ≤768px.
4. Tempted to shrink type so a table fits? Scroll the table instead.
5. Reaching for `@media` to change a size? Prefer widening the `clamp()`.
