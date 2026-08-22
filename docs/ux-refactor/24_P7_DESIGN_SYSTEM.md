# Design system (P7)

Normative for all new UI. Enforced by `src/app/globals.test.ts`,
`src/ui/overlay/overlay-contract.test.ts` and `src/ui/components/table-semantics.test.ts`.

Typography has its own page: `22_P6_TYPOGRAPHY_STANDARD.md`.

> **Where things live.** One stylesheet, `src/app/globals.css` — no CSS modules, no Tailwind, no
> CSS-in-JS. Every token is declared in its `:root`. Overlay behaviour is in `src/ui/overlay/`.
> Primitives are in `src/ui/components/`.

---

## 1. Which token do I use?

### Colour is organised by tone, not by hue

`--blue`, `--red`, `--green`, `--yellow` **are** the semantic tones — info, danger, success,
warning. That naming is historical, and it is not worth renaming 500 usages for purity, so read it
as a mapping:

| Tone | Means | Ramp |
|---|---|---|
| `--blue-*` | **info**, selection, the primary action | soft · border · on-soft · base · dark · active |
| `--red-*` | **danger**, destructive, error | same |
| `--green-*` | **success**, complete, saved | same + `--green-solid` |
| `--yellow-*` | **warning**, needs attention, Gibson | soft · border · on-soft · base · dark |
| `--neutral-*` | no tone; a plain chip | soft · border · on-soft |

Every tone is the **same six roles**, used the same way by every component that carries a tone:

```
--x-soft      the tinted surface the component sits on
--x-border    its boundary on that surface
--x-on-soft   text on that surface
--x           the solid fill, the accent, the left bar
--x-dark      hover on a solid fill
--x-active    pressed on a solid fill
```

A badge, a notice, a panel and a toast of the same tone read from the same ramp. Before P7 a badge
and a notice of the *same tone* carried different literals — eight values expressing four
decisions. **If you add a toned component, take the ramp; do not pick a new shade.**

`--green-solid` is the exception worth knowing: a solid fill carrying white text needs 4.5:1, and
`--green` is 4.32:1. Use `--green-solid` for a filled success button, `--green` for everything else.

### Surfaces, text and borders

| Token | Use for |
|---|---|
| `--surface` | the page's cards, panels, inputs — anything white |
| `--canvas` | the page behind them |
| `--surface-hover` / `--surface-sunken` / `--surface-active` | row and control hover · table headers and disabled fields · pressed |
| `--text-inverse` | text on a dark or saturated surface |
| `--ink-strong` / `--ink` / `--ink-soft` / `--muted` / `--text-disabled` | five text steps, darkest to lightest |
| `--border` | structural hairlines between things |
| `--border-strong` | heavier structural edges: table header underlines, panel edges |
| **`--border-control`** | **the boundary of anything interactive.** 3.32:1, which WCAG 1.4.11 requires and `--border-strong` (1.83:1) does not meet |
| `--sidebar*` | the inverse surface family |
| `--row-*` | table row state tints — bye, locked, dirty, gibson, editing |

The `--border-strong` / `--border-control` split is the one to get right. A table gridline has no
contrast requirement; an input's border is what says "this is an input" and does.

### The other scales

| Category | Tokens | Note |
|---|---|---|
| Stacking | `--z-sticky` `--z-dropdown` `--z-popover` `--z-chrome` `--z-sheet` `--z-dialog` `--z-toast` | need to beat your own tier? `calc(var(--z-popover) + 1)` |
| Elevation | `--shadow-raised` `--shadow-overlay` `--shadow-hard` `--shadow-hard-lg` `--shadow-chrome-up` | the offset (`hard`) shadows are the house style for menus and dialogs |
| Motion | `--dur-fast` `--dur-base` `--dur-slow` | `--dur-base` unless you have a reason |
| Type | `--text-xs` … `--text-lg`, `--text-input-touch` | see `22_P6_TYPOGRAPHY_STANDARD.md` |

**There is no radius scale, and corners are square on purpose.** `globals.css` line ~128 sets
`* { border-radius: 0 !important }`. It is the product's visual identity — square corners with
offset shadows — and it also normalises the radius browsers give buttons and search inputs. Any
`border-radius` you write is silently ignored. P7 deleted 17 declarations that had been dead for
exactly that reason.

**There is no spacing scale, and that is a decision, not an omission.** 542 spacing values across 39
distinct numbers, with 7, 9, 11, 13 and 15px all in real use. Tokenising them would either round
every component's padding — a redesign this refactor is explicitly not — or produce 39 tokens, which
is renaming rather than systematising. New code should prefer the dominant values (4, 8, 10, 12, 16)
and existing spacing is grandfathered.

---

## 2. Which component do I use?

| I need… | Use | Not |
|---|---|---|
| a button | `Button` — `variant` primary/secondary/danger/success/ghost, `size` sm/md, `loading` + `loadingLabel` | a raw `<button className="button">`. There are none left |
| an action that runs async | `Button loading={busy}` — it disables itself and sets `aria-busy` | a hand-rolled spinner beside a `disabled` you might forget |
| a status chip | `Badge` — `tone` neutral/info/warning/success/danger | inferring tone from the label text; that broke silently once already |
| a yes/no, or a small form in a modal | `ConfirmDialog` (it takes `children`) | a new dialog |
| a value from the operator before acting | `PromptDialog` — `type="password"` routes to `FreshSecretInput` | a bespoke input dialog |
| the same, from non-React code | `appDialog.confirm/alert/prompt` → the app-wide queue in `GlobalDialogHost` | mounting your own |
| a secret field | `FreshSecretInput` | `<input type="password">` directly |
| a single-choice menu | `SelectMenu` — listbox roles, arrow keys, roving tabindex, Escape restores focus | a new dropdown |
| a table | `DataGrid` — pass `ariaLabel`; `<th>` need `scope` | a hand-written `<table>` unless the shape genuinely differs |
| a page/section frame | `PageHeader`, `Panel`, `EmptyState` | div + h2 |

### Building a new modal dialog

Use `ConfirmDialog` if you possibly can. If the shape genuinely differs, the behaviour is not yours
to reinvent:

```tsx
const dialog = useModalDialog({ open, onDismiss: onClose, dismissible: !busy });

<div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
  <section ref={dialog.ref} tabIndex={-1} role="dialog" aria-modal="true"
           aria-labelledby={dialog.titleId} onMouseDown={(e) => e.stopPropagation()}>
    <h2 id={dialog.titleId}>…</h2>
```

That gives you Escape, focus into the dialog, a focus trap, focus returned to the trigger, a
nesting-aware scroll lock, and unique label ids. `dismissible: false` while a mutation is in flight,
so neither Escape nor the backdrop can cancel a running action.

---

## 3. The overlay taxonomy

Overlays are **not** one thing, and the differences are the point.

| Type | Modal? | Escape | Focus | Page behind | Examples |
|---|---|---|---|---|---|
| **Dialog** | yes | closes | moves in, **trapped**, restored on close | **locked** and inert | `ConfirmDialog`, `PromptDialog`, the history dialogs |
| **Menu / listbox** | no | closes, **restores focus to the trigger** | moves in, **not trapped** | live and scrollable | `SelectMenu`, the grid's column filter |
| **Combobox** | no | closes the list | stays in the input | live | `InstitutionCombobox` — dismissed on blur, which is right for an input with a list |
| **Bottom sheet** | **only below 768px** | closes | moves in | locked only as a sheet | `OverviewRecordFilter` |
| **Toast** | no | — | never takes focus | live | `Toaster` — `role="status"` |

**A menu must not trap focus or lock the page.** The operator is filtering a table they still need
to see. Sharing one implementation between a dialog and a listbox is how a listbox ends up locking
the page — so `useModalDialog` is for dialogs, and menus keep their own dismissal.

There is deliberately **no generic `useMenu`**. The three non-modal overlays were audited and their
differences are real: the grid's filter popup has viewport-move handling that keeps it open while
the software keyboard is up; the combobox dismisses on blur. A hook covering all three would need
more options than the code it replaced.

### Two things to know

- **`aria-modal` is a promise.** Say it only where focus really is trapped and the page really is
  inert. `OverviewRecordFilter` sets it conditionally for exactly this reason: as a desktop popover
  it is not modal, and claiming otherwise tells a screen reader to confine the user to a boundary
  nothing enforces.
- **`.egrid-filterpop` sits at `--z-grid-popover` (1100), above the dialog and the toaster.** That
  is an anomaly, preserved on purpose and labelled in `:root`. It escapes its scroll container that
  way. Revisit it when the console overlays can be exercised with a login; do not tidy it blind.

---

## 4. Responsive

Three breakpoints carry the weight: **≤560** (phone), **≤768 / ≥769** (the mobile↔desktop line, where
the sidebar swaps for the mobile nav), **≤1080** (a narrow desktop). Four one-off widths remain —
520, 720, 760, 1080 — and were left alone: each was chosen against a real device, and collapsing
them is a layout change with no measured benefit.

Rules that hold across the range:

- **Type scales by viewport width, never by pointer type.** A 1024px touch tablet reports
  `hover: none`; gating a font size on `hover` gave it phone sizing at desktop width.
- **Text inputs reach 16px at ≤768px** or iOS Safari zooms the page on focus.
- **Tables scroll rather than shrink.** Below 769px the grid sizes to its content and overflows into
  `.entry-grid-scroll`; above it, `table-layout: fixed` and resizable columns.
- **Nothing below 11px, ever**, `clamp()` floors included.

Verify at **375, 390, 768, 1024, 1280**. A CDP viewport override does **not** fire `matchMedia`
`"change"`, so reload after resizing before trusting a reading.

---

## 5. Accessibility floor

Non-negotiable, and each is enforced by a test:

| Rule | Standard | Guard |
|---|---|---|
| No text below 11px at any viewport | — | `globals.test.ts` |
| Text ≥ 4.5:1, control boundaries ≥ 3:1 | 1.4.3, 1.4.11 | `--border-control`, `--green-solid` |
| Never remove a focus indicator without a replacement | 2.4.7 | `globals.test.ts` |
| Every `<th>` has `scope`; every `<table>` has a name | 1.3.1 | `table-semantics.test.ts` |
| `aria-modal` implies a real trap, lock and restore | 4.1.2 | `overlay-contract.test.ts` |
| Every interactive control is keyboard reachable | 2.1.1 | — (review) |

---

## 6. What P7 deliberately did not do

- **No spacing retrofit** — §1.
- **No radius scale** — corners are square by decree; the scale would have been dead on arrival.
- **No generic menu hook** — §3.
- **No z-index reordering** — the tiers are named and every value preserved. Reordering overlays
  without being able to exercise the console ones is how overlays vanish behind each other.
- **No sweep of the remaining 58 hard-coded colours** — they are genuinely single-purpose (gibson
  gold, podium gradients, individual component tints). A token for one use is renaming.
- **`.entry-keyin__save` still hides its label with `font-size: 0`** — a text-hiding technique, so
  the type floor does not apply, but `.sr-only` would say it better. Noted, not changed.
