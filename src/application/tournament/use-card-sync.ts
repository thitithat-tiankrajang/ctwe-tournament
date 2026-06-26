"use client";

import { useEffect } from "react";
import { useTournamentStore } from "./store";

/**
 * Live multi-user sync: while a card is open, poll it so every screen (staff + directors, many
 * machines) sees each other's result/player edits within a few seconds. Unsaved local drafts in the
 * entry grid live in component state and are not clobbered by the refresh.
 */
export function useCardSync(cardId: string | undefined, intervalMs = 3500) {
  const syncCard = useTournamentStore((state) => state.syncCard);
  useEffect(() => {
    if (!cardId) return;
    let active = true;
    const tick = () => { if (active && document.visibilityState !== "hidden") void syncCard(cardId); };
    const timer = window.setInterval(tick, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [cardId, intervalMs, syncCard]);
}
