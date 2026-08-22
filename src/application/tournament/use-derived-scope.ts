"use client";

import { useEffect } from "react";
import { useTournamentStore } from "./store";

/**
 * Recover the tournament scope from the URL when a back-office user opens a card directly.
 *
 * `activeTournament` is normally set when someone enters a tournament from `/` and is remembered in
 * `localStorage`. Arriving straight at `/cards/{id}` — a bookmark, a link from a colleague, a new
 * browser — leaves it null, and the sidebar then shows no tournament and no card folders: the
 * director keeps the page but loses the navigation around it.
 *
 * **This hook belongs to the `/cards/[id]` route page and nowhere else** (`04_BLOCKERS.md` B5).
 * `CardOverview` renders it *and* `/tour/[token]`, and running this there would call
 * `setActiveTournament` on the viewer path, where it nulls `publicScopeToken` — losing viewer bundle
 * dedup — and leaves `published` undefined, which reopens SSE on a published tournament and breaks
 * the "a published tournament issues zero origin requests" invariant. Gating on `authenticated`
 * is the second guard; living in the route page is the first.
 *
 * Only `{ id, name }` is stored, matching what `/` already does for back-office users: a staff
 * session has no viewer scope token, and passing `accessToken` here would set one.
 */
export function useDerivedTournamentScope(cardId: string | undefined) {
  const authenticated = useTournamentStore((state) => state.auth.authenticated);
  const hasScope = useTournamentStore((state) => state.activeTournament !== null);
  // From either source — the card may be a full one or only a summary row (P3-B).
  const tournamentId = useTournamentStore((state) => cardId
    ? state.cards.find((card) => card.id === cardId)?.tournamentId
      ?? state.summaries.find((summary) => summary.id === cardId)?.tournamentId
    : undefined);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);

  useEffect(() => {
    if (!authenticated || hasScope || !tournamentId) return;
    let active = true;
    void loadTournaments()
      .then((tournaments) => {
        if (!active) return;
        const match = tournaments.find((tournament) => tournament.id === tournamentId);
        // No match means the card belongs to a tournament this account cannot see. Leave the scope
        // unset rather than inventing one; the page itself is already access-controlled server-side.
        if (match) setActiveTournament({ id: match.id, name: match.name });
      })
      .catch(() => { /* a scope we could not resolve is not worth surfacing an error for */ });
    return () => { active = false; };
  }, [authenticated, hasScope, tournamentId, loadTournaments, setActiveTournament]);
}
