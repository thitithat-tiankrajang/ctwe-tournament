"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { FOCUSABLE_SELECTOR, nextTrapIndex } from "./focus-trap";

/** Nested dialogs each lock scrolling; the page unlocks when the last one closes, not the first. */
let scrollLocks = 0;
let restoreOverflow = "";

function lockScroll() {
  if (scrollLocks++ === 0) {
    restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}
function unlockScroll() {
  if (--scrollLocks <= 0) {
    scrollLocks = 0;
    document.body.style.overflow = restoreOverflow;
  }
}

/**
 * Modal-dialog behaviour: the contract in `23_P6_CLOSURE.md` §2.8, in one place.
 *
 * A dialog is modal, so it does what a menu must not: it takes focus, keeps it, locks the page
 * behind it, and hands focus back to whatever opened it. Menus use `useDismissableLayer` instead —
 * see `24_P7_DESIGN_SYSTEM.md` for why the two are separate.
 *
 * Returns the ids to wire into `aria-labelledby` / `aria-describedby`. They come from `useId`
 * because the previous hard-coded `id="confirm-dialog-title"` mislabels one of the two dialogs the
 * moment a page-local dialog and the global queue are open together.
 */
export function useModalDialog({
  open,
  onDismiss,
  dismissible = true,
}: {
  open: boolean;
  onDismiss: () => void;
  /** False while a submit is in flight: Escape and the backdrop must not cancel a running action. */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const base = useId();
  const titleId = `${base}-title`;
  const descriptionId = `${base}-description`;

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  // Escape, and Tab kept inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dismissibleRef.current) { event.preventDefault(); dismissRef.current(); }
        return;
      }
      if (event.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) { event.preventDefault(); root.focus(); return; }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = nextTrapIndex(focusable.length, current, event.shiftKey);
      // Only intervene at the ends; inside the list the browser already does the right thing.
      const atEdge = current < 0 || (event.shiftKey ? current === 0 : current === focusable.length - 1);
      if (!atEdge) return;
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // Take focus on open, give it back on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first = root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? root)?.focus();
    return () => {
      // Only restore if focus is still somewhere in the dialog; if the operator has already clicked
      // elsewhere, yanking it back is worse than leaving it.
      const active = document.activeElement;
      if (!active || active === document.body || root?.contains(active)) previouslyFocused?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    lockScroll();
    return unlockScroll;
  }, [open]);

  /** Backdrop click. Guarded on the same flag as Escape so a busy dialog cannot be dismissed. */
  const onBackdropMouseDown = useCallback(() => {
    if (dismissibleRef.current) dismissRef.current();
  }, []);

  return { ref, titleId, descriptionId, onBackdropMouseDown };
}
