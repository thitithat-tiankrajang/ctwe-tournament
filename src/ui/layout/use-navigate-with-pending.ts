"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/** How long a navigation may claim to be pending before the flag is released regardless. */
export const NAVIGATION_PENDING_TIMEOUT_MS = 10_000;

/** The path part of an href, so `/cards/x?game=2` is recognised as an arrival at `/cards/x`. */
export function pathOf(href: string): string {
  const query = href.search(/[?#]/);
  return query === -1 ? href : href.slice(0, query);
}

/**
 * Should `pending` be released, given where we are and where we were going?
 *
 * Pure so the release rule is testable without a router: this is the logic that decides whether an
 * operator's button stops spinning, and getting it wrong strands them mid-tournament.
 */
export function hasArrived(target: string | null, pathname: string): boolean {
  return target !== null && pathOf(target) === pathname;
}

/**
 * `router.push` with a pending flag that spans the navigation.
 *
 * The defect this fixes is narrow and specific. Every workflow action here is
 * `await mutate(); router.push(next)` with the busy flag cleared in a `finally` — so the button
 * un-busies the instant the mutation resolves, while the navigation it triggered is still in
 * flight. With `prefetch={false}` and no `loading.tsx` that gap is the whole blocking navigation:
 * the operator sees a settled button and an unchanged screen, and clicks again.
 *
 * `useLinkStatus` cannot help here — it only tracks the most-recently-clicked `<Link>`, and these
 * are programmatic pushes.
 *
 * ## Pending is a hint, never a lock
 *
 * `pending` drives a spinner and nothing else. It is deliberately NOT wired to `disabled`, so even
 * a permanently stuck flag cannot make the UI unusable — the worst case is a spinner that outstays
 * its welcome next to a button that still works. Re-issuing `router.push` at the same href is
 * idempotent, so a second click during a slow navigation is harmless.
 *
 * On top of that there are three independent release paths, and the flag clears if ANY fires:
 *   1. Arrival — `pathname` becomes the target.
 *   2. Watchdog — a timeout releases it no matter what the router did (offline, a hung RSC fetch,
 *      a redirect that lands somewhere other than the target, a push the router coalesces away).
 *   3. Unmount — the timer is cleared, and on a successful navigation the component is gone anyway.
 *
 * Path 2 is the one that matters: 1 alone would strand the flag on exactly the failures that make
 * feedback worth having.
 */
export function useNavigateWithPending(timeoutMs: number = NAVIGATION_PENDING_TIMEOUT_MS) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const targetRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const settle = useCallback(() => {
    targetRef.current = null;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPending(false);
  }, []);

  // Release path 1: we got there.
  useEffect(() => {
    if (hasArrived(targetRef.current, pathname)) settle();
  }, [pathname, settle]);

  // Release path 3: never leave a timer behind.
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);

  const navigate = useCallback((href: string) => {
    targetRef.current = href;
    setPending(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    // Release path 2.
    timerRef.current = window.setTimeout(settle, timeoutMs);
    router.push(href);
  }, [router, settle, timeoutMs]);

  return { pending, navigate };
}
