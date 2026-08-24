"use client";

import { useCallback, useEffect, useRef, type ComponentPropsWithRef } from "react";

/**
 * A competition score field that a mouse wheel cannot change.
 *
 * `type="number"` steps its value when the wheel turns over a FOCUSED input, so scrolling a long
 * entry grid after clicking into a cell silently rewrites a score the operator already keyed. The
 * spinner arrows are hidden by CSS, so nothing on screen suggests the value can move that way, and
 * nothing marks the row as changed in the operator's mind — they scroll, and the number is wrong.
 *
 * Two details this depends on:
 *
 *  - React registers `wheel` passively at the root, so `preventDefault()` inside an `onWheel` prop
 *    is a no-op (and warns). The listener has to be added manually with `{ passive: false }`.
 *  - It must fire only while THIS input is focused. Blocking unconditionally would trap the page
 *    scroll whenever the pointer crossed one of the grid's dozens of score cells — worse than the
 *    bug it fixes. An unfocused number input does not step, so there is nothing to prevent.
 *
 * Keyboard ↑/↓ still step the value: those take deliberate intent, a wheel does not.
 *
 * Deliberately NOT applied to every `type="number"` in the app. This is for fields that record a
 * competition score; configuration inputs (max diff, realtime limits, penalty points) keep the
 * platform's default behaviour.
 */
export function ScoreInput({ ref, ...props }: ComponentPropsWithRef<"input">) {
  const inner = useRef<HTMLInputElement | null>(null);

  const attach = useCallback((element: HTMLInputElement | null) => {
    inner.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  }, [ref]);

  useEffect(() => {
    const element = inner.current;
    if (!element) return;
    const block = (event: WheelEvent) => { if (document.activeElement === element) event.preventDefault(); };
    element.addEventListener("wheel", block, { passive: false });
    return () => element.removeEventListener("wheel", block);
  }, []);

  return <input {...props} ref={attach} />;
}
