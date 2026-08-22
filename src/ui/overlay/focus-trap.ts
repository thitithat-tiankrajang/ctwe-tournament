/**
 * The arithmetic behind an overlay's keyboard behaviour, kept apart from the DOM so it can be
 * tested. The hooks in this directory own the element wrangling; everything decidable without a
 * document lives here.
 */

/** Elements that can hold focus. `:not([disabled])` and the negative-tabindex filter matter: a
 *  disabled confirm button and a roving-tabindex option are both in the DOM and neither is a stop. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Where Tab should land inside a trap.
 *
 * `current` is the index of the focused element, or -1 when focus has escaped the overlay (which
 * happens when the browser moves it to <body> after the previously focused node is removed). From
 * outside, Tab enters at the start and Shift+Tab at the end, so a trap that has lost focus recovers
 * instead of letting the next Tab walk into the page behind it.
 */
export function nextTrapIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * Where the arrow keys should land in a menu.
 *
 * Menus wrap like a trap does, but they are NOT modal: Escape returns focus to the trigger and the
 * page behind stays live. Keeping the two rules in one file is deliberate — they look alike and
 * differ on purpose, so the difference should be readable in one place.
 */
export function nextMenuIndex(count: number, current: number, offset: number): number {
  if (count <= 0) return -1;
  return (current + offset + count) % count;
}
