"use client";

import { useEffect, useRef } from "react";
import type { Pairing, PublicCardVersion } from "@/domain/tournament/types";
import { useTournamentStore } from "./store";
import { useRealtimeConfig } from "./use-realtime-config";

interface PublicResultEvent {
  cardId: string;
  version: number;
  changedPairings: Pairing[];
}

/**
 * An open public card uses one isolated SSE stream for live results. There is intentionally no
 * polling fallback: EventSource reconnects itself and avoiding per-viewer timers keeps edge request
 * volume flat during quiet periods.
 */
export function usePublicSync(cardId: string | undefined, enabled: boolean) {
  const cards = useTournamentStore((state) => state.cards);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const applyResultPatch = useTournamentStore((state) => state.applyResultPatch);
  const config = useRealtimeConfig();
  const versionsRef = useRef(new Map<string, number>());

  useEffect(() => {
    versionsRef.current = new Map(cards.map((card) => [card.id, card.version]));
    const openCard = cardId ? cards.find((card) => card.id === cardId) : undefined;
    if (enabled && cardId && openCard?.summaryOnly) void syncCard(cardId);
  }, [cardId, cards, enabled, syncCard]);

  useEffect(() => {
    if (!enabled || !cardId || !("EventSource" in window)) return;
    if (!config.realtimeEnabled || !config.sseEnabled) return;
    const source = new EventSource(`/api/public/cards/${encodeURIComponent(cardId)}/events`);
    const refreshOpenCard = (event?: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string> | undefined)?.data ?? "") as PublicCardVersion;
        void syncCard(cardId, payload.version);
      } catch {
        void syncCard(cardId);
      }
    };
    source.onmessage = refreshOpenCard;
    source.addEventListener("card", refreshOpenCard);
    source.addEventListener("connected", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as PublicCardVersion;
        if (versionsRef.current.get(cardId) !== payload.version) void syncCard(cardId, payload.version);
      } catch {
        refreshOpenCard();
      }
    });
    source.addEventListener("result", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as PublicResultEvent;
        const currentVersion = versionsRef.current.get(cardId);
        if (payload.cardId !== cardId || payload.changedPairings === undefined)
          throw new Error("Malformed public result event");
        if (currentVersion === undefined || payload.version !== currentVersion + 1) {
          void syncCard(cardId, payload.version);
          return;
        }
        const patched = applyResultPatch(cardId, payload.version, payload.changedPairings);
        if (patched) versionsRef.current.set(cardId, payload.version);
        else void syncCard(cardId, payload.version);
      } catch {
        void syncCard(cardId);
      }
    });
    return () => {
      source.onmessage = null;
      source.removeEventListener("card", refreshOpenCard);
      source.close();
    };
  }, [applyResultPatch, cardId, enabled, config.realtimeEnabled, config.sseEnabled, syncCard]);
}
