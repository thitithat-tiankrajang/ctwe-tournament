import type { Viewport } from "next";
import type { ReactNode } from "react";

/**
 * The public viewer, and ONLY the public viewer, lays out at 75% scale on a phone.
 *
 * WHY THIS AND NOT CSS. What the owner validated on a real phone was the browser's own 75% zoom,
 * which does two things at once: it shrinks everything by 0.75, and it widens the layout viewport
 * (390px device → 520 CSS px), which is what lets a Thai name in the pairing table stop wrapping
 * onto a third line. A font/spacing change reproduces the first effect only, and CSS `zoom` on
 * `.spectator-shell` reproduces neither faithfully — it leaves media queries evaluating at the
 * device width and it multiplies `env(safe-area-inset-*)`, which would slide the fixed bottom nav
 * onto the home indicator. `initial-scale` IS the browser-zoom mechanism, so it is the one that
 * reproduces what was approved.
 *
 * SAFE AREA, measured rather than assumed. Under an emulated 34px bottom inset the page still
 * reads `env(safe-area-inset-bottom)` as 34 CSS px, which at this scale paints ~26 physical px —
 * so the nav's reserved strip is 0.75 of the home indicator, not equal to it. The bar itself still
 * reaches the bottom edge and the buttons clear the indicator; only the cushion is thinner. If a
 * real iPhone shows the gesture area eating taps, the fix is one scoped line next to the other
 * `.spectator-shell .overview-mobile-nav` overrides in globals.css, dividing the inset by the
 * scale — NOT a change to the scale itself.
 *
 * ACCEPTED COST, deliberately. At 0.75 the scale renders below the 11px Thai reading floor and the
 * 44px tap-target floor that `docs/ux-refactor/22_P6_TYPOGRAPHY_STANDARD.md` sets for the
 * operational console: 13px meta text lands at ~9.75 physical px, a 44px control at 33. The owner
 * accepted that trade for the viewer on 2026-09-22 in exchange for the approved density. The
 * mitigation is that NOTHING here disables user scaling — no `maximumScale`, no `userScalable` —
 * so pinch-to-zoom remains available to anyone who needs it. Do not add either field.
 *
 * SCOPE. A `viewport` export applies to its own segment and below, so this file covers `/tour/*`
 * and nothing else: the director, staff and admin consoles keep the root viewport from
 * `src/app/layout.tsx`, as does the legacy `/t/{hex}` viewer. `src/app/viewport.test.ts` is what
 * keeps that true.
 *
 * BREAKPOINTS. Every media query and `matchMedia` in the app evaluates against the WIDENED layout
 * viewport, so each one now flips at a device width of 0.75 × its own value:
 *   - 640px (`PHONE_VIEWPORT`, the report's list-vs-grid switch) flips at a 480px device
 *   - 768px (`NARROW_VIEWPORT`, the bottom nav and single-panel mode) flips at a 576px device
 * Phones are comfortably inside both (a 430px device lays out at 573px), but a device between 481
 * and 576 CSS px now gets the nine-column grid where it used to get the list. Choosing a scale
 * lower than 0.75 walks that cliff down into real phone widths — measure before changing it.
 *
 * KNOWN LIMITATIONS, accepted for this change. Its scope is phones, 320–480px, and these two are
 * recorded rather than fixed:
 *   1. Devices of 481–576 CSS px (small tablets, an unfolded foldable) now read the report as the
 *      nine-column grid instead of the list, and above 576 they get the desktop layout. Nothing
 *      here is wrong on those screens, they are simply not what was measured. Widening the scope
 *      later means re-deriving `PHONE_VIEWPORT` / `NARROW_VIEWPORT` in the scaled space, NOT
 *      editing the shared `@media (max-width: 768px)` blocks, which the consoles also read.
 *   2. The viewer's `@media (max-width: 380px)` step in globals.css can no longer fire: it would
 *      need a device of 285px or narrower. It is dead rather than harmful — it stepped the display
 *      numbers down for a cramped 320px phone, and at this scale that phone already lays out at
 *      426px and renders those numbers smaller than the step produced. Rebase it to ~507px or
 *      delete it in a cleanup of its own.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 0.75,
  viewportFit: "cover",
};

export default function TourViewportLayout({ children }: { children: ReactNode }) {
  return children;
}
