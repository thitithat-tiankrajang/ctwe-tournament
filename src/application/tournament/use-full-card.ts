"use client";

import { useEffect } from "react";
import { useTournamentStore } from "./store";
import { useRealtimeConfig } from "./use-realtime-config";

/**
 * How long to let the staff SSE stream fetch the card before stepping in. Long enough that a healthy
 * stream always wins the race (its `connected` frame arrives in tens of milliseconds locally, and
 * the fetch is issued from that handler), short enough that a refused stream is not felt as a hang.
 */
const SSE_GRACE_MS = 1_500;

/**
 * Make sure an authenticated user who opens a card ends up with the **full** card, not just the
 * summary row P3-B now loads for the list.
 *
 * Until P3-B, `load()` fetched every card in full, so a card page always had its data. Now the list
 * is twelve fields per card and the full object — players, matches, snapshots, audit — has to be
 * fetched when a card is actually opened.
 *
 * **This is deliberately a fallback, not the primary path.** `use-card-sync.ts` already fetches the
 * card from its `connected` handler when the store holds no version for it, so firing
 * unconditionally here would issue *two* requests per card page — measured, and precisely the
 * duplication P3 exists to remove. So:
 *
 *   - SSE unavailable (realtime or SSE switched off by the admin, no `EventSource`) — fetch at once,
 *     because nothing else will.
 *   - SSE available — wait {@link SSE_GRACE_MS}. A healthy stream fetches the card and this effect
 *     re-runs with `hasFullCard` true, cancelling the timer. Only a stream that never connects — a
 *     refused staff stream at the connection cap, a proxy that blocks `text/event-stream` — lets the
 *     timer fire, and then a blank card page would be the alternative.
 *
 * Lives here, called from the shell, rather than inside `use-card-sync.ts`, which is frozen
 * (`03_INVARIANTS.md` §1). Same technique as P2-D: change what the shell passes, never the hook.
 * `syncCard` routes through `replaceCard`, so its version guard still decides what wins.
 */
export function useFullCard(cardId: string | undefined, enabled: boolean) {
  const syncCard = useTournamentStore((state) => state.syncCard);
  // A boolean, deliberately: subscribing to `cards` would re-run this effect on every SSE patch.
  const hasFullCard = useTournamentStore((state) =>
    Boolean(cardId) && state.cards.some((card) => card.id === cardId && !card.summaryOnly));
  const config = useRealtimeConfig(enabled);
  const streamWillFetch = config.realtimeEnabled && config.sseEnabled;

  useEffect(() => {
    if (!enabled || !cardId || hasFullCard) return;
    if (!streamWillFetch) {
      void syncCard(cardId);
      return;
    }
    const timer = window.setTimeout(() => { void syncCard(cardId); }, SSE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [cardId, enabled, hasFullCard, streamWillFetch, syncCard]);
}
