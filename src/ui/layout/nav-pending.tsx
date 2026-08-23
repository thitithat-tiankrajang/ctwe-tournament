"use client";

import type { LucideIcon } from "lucide-react";
import { LoaderCircle } from "lucide-react";
import { useLinkStatus } from "next/link";

/**
 * A nav link's icon, swapped for a spinner while THAT link's navigation is in flight.
 *
 * Every nav link here is `prefetch={false}` (deliberately — the Worker CPU budget), and no route
 * has a `loading.tsx`. Together that makes an App Router navigation fully blocking: on the first
 * click of a route the router waits for the RSC payload and the route chunk before committing
 * anything, so the URL does not move, the old page stays painted, and the only feedback is the
 * browser's own tab spinner. Operators read that as a dead click and press again.
 *
 * `useLinkStatus` must be called from a component rendered INSIDE `<Link>` — it reads the
 * most-recently-clicked link's optimistic status, so a hook call in the parent would report
 * nothing. Hence a leaf component rather than a prop on `NavigationLink`.
 *
 * Swap, not append: the collapsed sidebar is an icon rail with room for exactly one glyph, and
 * appending a spinner there would jog the whole rail sideways. The spinner is decorative — the
 * link's own text remains its accessible name — so it stays `aria-hidden`.
 *
 * Note this covers `<Link>` clicks only. `router.push` navigations are not tracked by
 * `useLinkStatus` at all; those report through `useNavigateWithPending`.
 */
export function NavLinkIcon({ icon: Icon, size = 18 }: { icon: LucideIcon; size?: number }) {
  const { pending } = useLinkStatus();
  return pending
    ? <LoaderCircle className="loading-spinner" size={size} aria-hidden="true" />
    : <Icon size={size} aria-hidden="true" />;
}
