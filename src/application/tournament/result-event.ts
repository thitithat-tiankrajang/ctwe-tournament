"use client";

import type { Pairing } from "@/domain/tournament/types";

/**
 * The staff `result` SSE frame, as `CardEventPublisher.StaffResultChangeEvent` serialises it.
 *
 * `actor`/`actorRoles` were added by P4 SSE proof gate fix D: the concurrent-draft warning has to
 * name the account that moved a result out from under the reader, and before this the realtime event
 * carried no identity at all — the only way to find out was to refetch the card for its audit list.
 *
 * The identity is the existing one, not a new model: `actor` is `authentication.getName()`, the same
 * value written to `audit_logs.actor` and `matches.submitted_by`, and `actorRoles` is the authority
 * list exactly as `GET /api/auth/me` reports it.
 *
 * The matching PUBLIC frame is a different backend type with no actor, so an anonymous viewer stream
 * cannot carry a staff account name. That is enforced structurally, and pinned by
 * `CardEventPublisherTest.publicResultEventHasNoActorField`.
 */
export interface StaffResultChangeEvent {
  cardId: string;
  version: number;
  updatedAt: string;
  changedPairings: Pairing[];
  /** Account name of whoever saved the result. Absent from a pre-fix-D backend. */
  actor?: string;
  /** e.g. `["ROLE_DIRECTOR"]`. Absent from a pre-fix-D backend. */
  actorRoles?: string[];
}

/** Roles as stored, minus Spring's `ROLE_` prefix, for display. */
export function actorRoleLabels(event: Pick<StaffResultChangeEvent, "actorRoles">): string[] {
  return (event.actorRoles ?? []).map((role) => role.startsWith("ROLE_") ? role.slice(5) : role);
}

/**
 * Who to name in a concurrency warning, or `null` when the backend did not say.
 *
 * Returning null rather than a placeholder is deliberate: Invariant D keeps New FE + Old BE working,
 * and a pre-fix-D backend simply omits these fields (Jackson is configured `non_null`). A caller
 * must decide what to do with "unknown" rather than be handed an invented name.
 */
export function describeActor(event: StaffResultChangeEvent): { name: string; roles: string[] } | null {
  if (!event.actor) return null;
  return { name: event.actor, roles: actorRoleLabels(event) };
}
