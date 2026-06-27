"use client";

import { useEffect, useRef } from "react";
import { useTournamentStore } from "./store";

interface CardChangeEvent {
  cardId: string;
  version: number;
  updatedAt: string;
}

/**
 * Live multi-user sync: while a card is open, subscribe to server-sent card change events so every
 * screen (staff + directors, many machines) sees each other's result/player edits immediately.
 * The interval stays as a fallback if a proxy/browser drops the stream. Unsaved local drafts in the
 * entry grid live in component state, so remote refreshes update saved rows without broadcasting
 * the quick-entry highlight or clobbering text someone is actively typing.
 */
export function useCardSync(cardId: string | undefined, intervalMs = 3500) {
  const syncCard = useTournamentStore((state) => state.syncCard);
  const currentVersion = useTournamentStore((state) => cardId ? state.cards.find((card) => card.id === cardId)?.version : undefined);
  const currentVersionRef = useRef<number | undefined>(currentVersion);
  useEffect(() => { currentVersionRef.current = currentVersion; }, [currentVersion]);

  useEffect(() => {
    if (!cardId) return;
    let active = true;
    // Poll a tiny version endpoint first; only pull the (much larger) full card when it actually changed.
    const tick = async () => {
      if (!active || document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/version`, { credentials: "same-origin", cache: "no-store" });
        if (!active || !response.ok) return;
        const { version } = (await response.json()) as { version: number };
        if (currentVersionRef.current === undefined || version !== currentVersionRef.current) await syncCard(cardId);
      } catch { /* transient poll error — keep current state */ }
    };
    const timer = window.setInterval(() => void tick(), intervalMs);
    void tick();
    let source: EventSource | null = null;
    if ("EventSource" in window) {
      source = new EventSource(`/api/cards/${encodeURIComponent(cardId)}/events`);
      source.addEventListener("card", (event) => {
        if (!active || document.visibilityState === "hidden") return;
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as CardChangeEvent;
          if (payload.cardId !== cardId) return;
          if (payload.version >= 0 && currentVersionRef.current !== undefined && payload.version <= currentVersionRef.current) return;
        } catch { /* malformed event payload: fall through and resync defensively */ }
        void syncCard(cardId);
      });
      source.onerror = () => {
        // EventSource reconnects itself; the polling fallback covers the gap.
      };
    }
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      source?.close();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cardId, intervalMs, syncCard]);
}
