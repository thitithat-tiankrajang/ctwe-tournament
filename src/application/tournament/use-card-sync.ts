"use client";

import { useEffect, useRef } from "react";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";
import { useTournamentStore } from "./store";
import { useRealtimeConfig } from "./use-realtime-config";

interface CardChangeEvent {
  cardId: string;
  version: number;
  updatedAt: string;
}

interface ResultChangeEvent extends CardChangeEvent {
  changedPairings: Pairing[];
}

interface CardStateEvent extends CardChangeEvent {
  card: TournamentCard;
}

/**
 * Live multi-user sync: while a card is open, subscribe to server-sent card change events so every
 * screen (staff + directors, many machines) sees each other's edits immediately. EventSource handles
 * reconnects; there is intentionally no polling fallback. Unsaved drafts and the quick-entry
 * highlight remain local component state.
 */
export function useCardSync(cardId: string | undefined) {
  const syncCard = useTournamentStore((state) => state.syncCard);
  const applyCardState = useTournamentStore((state) => state.applyCardState);
  const applyResultPatch = useTournamentStore((state) => state.applyResultPatch);
  const config = useRealtimeConfig();
  const sseAllowed = config.realtimeEnabled && config.sseEnabled;
  const currentVersion = useTournamentStore((state) => cardId ? state.cards.find((card) => card.id === cardId)?.version : undefined);
  const currentVersionRef = useRef<number | undefined>(currentVersion);
  useEffect(() => { currentVersionRef.current = currentVersion; }, [currentVersion]);

  useEffect(() => {
    if (!cardId) return;
    let active = true;
    let source: EventSource | null = null;
    if ("EventSource" in window && sseAllowed) {
      source = new EventSource(`/api/cards/${encodeURIComponent(cardId)}/events`);
      source.addEventListener("connected", (event) => {
        if (!active) return;
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as CardChangeEvent;
          if (payload.cardId !== cardId) return;
          if (currentVersionRef.current === undefined || payload.version > currentVersionRef.current) {
            void syncCard(cardId);
          }
        } catch {
          void syncCard(cardId);
        }
      });
      source.addEventListener("card", (event) => {
        if (!active) return;
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as CardChangeEvent;
          if (payload.cardId !== cardId) return;
          if (payload.version >= 0 && currentVersionRef.current !== undefined && payload.version <= currentVersionRef.current) return;
        } catch { /* malformed event payload: fall through and resync defensively */ }
        void syncCard(cardId);
      });
      source.addEventListener("state", (event) => {
        if (!active) return;
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as CardStateEvent;
          if (payload.cardId !== cardId || payload.card.id !== cardId) return;
          applyCardState(payload.card);
          currentVersionRef.current = Math.max(currentVersionRef.current ?? 0, payload.version);
        } catch {
          void syncCard(cardId);
        }
      });
      source.addEventListener("result", (event) => {
        if (!active) return;
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as ResultChangeEvent;
          if (payload.cardId !== cardId) return;
          const patched = applyResultPatch(cardId, payload.version, payload.changedPairings);
          currentVersionRef.current = Math.max(currentVersionRef.current ?? 0, payload.version);
          if (!patched) void syncCard(cardId);
        } catch {
          void syncCard(cardId);
        }
      });
    }
    return () => {
      active = false;
      source?.close();
    };
  }, [applyCardState, applyResultPatch, cardId, sseAllowed, syncCard]);
}
