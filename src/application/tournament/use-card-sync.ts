"use client";

import { useEffect, useRef } from "react";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";
import { useTournamentStore } from "./store";

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
 * screen (staff + directors, many machines) sees each other's edits immediately. Polling runs only
 * while the stream is disconnected; continuously polling every few seconds creates significant HTTP
 * and database egress even when nobody is editing. Unsaved drafts and the quick-entry highlight remain
 * local component state.
 */
export function useCardSync(cardId: string | undefined, fallbackIntervalMs = 30_000) {
  const syncCard = useTournamentStore((state) => state.syncCard);
  const applyCardState = useTournamentStore((state) => state.applyCardState);
  const applyResultPatch = useTournamentStore((state) => state.applyResultPatch);
  const currentVersion = useTournamentStore((state) => cardId ? state.cards.find((card) => card.id === cardId)?.version : undefined);
  const currentVersionRef = useRef<number | undefined>(currentVersion);
  useEffect(() => { currentVersionRef.current = currentVersion; }, [currentVersion]);

  useEffect(() => {
    if (!cardId) return;
    let active = true;
    let streamConnected = false;
    let missedWhileHidden = false;
    // Poll the tiny version endpoint only as a fallback while SSE is unavailable.
    const tick = async () => {
      if (!active || streamConnected || document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/version`, { credentials: "same-origin", cache: "no-store" });
        if (!active || !response.ok) return;
        const { version } = (await response.json()) as { version: number };
        if (currentVersionRef.current === undefined || version !== currentVersionRef.current) await syncCard(cardId);
      } catch { /* transient poll error — keep current state */ }
    };
    const timer = window.setInterval(() => void tick(), fallbackIntervalMs);
    void tick();
    let source: EventSource | null = null;
    if ("EventSource" in window) {
      source = new EventSource(`/api/cards/${encodeURIComponent(cardId)}/events`);
      source.onopen = () => { streamConnected = true; };
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
        if (document.visibilityState === "hidden") {
          missedWhileHidden = true;
          return;
        }
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
        if (document.visibilityState === "hidden") {
          missedWhileHidden = true;
          return;
        }
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
      source.onerror = () => {
        streamConnected = false;
        void tick();
      };
    }
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (missedWhileHidden) {
        missedWhileHidden = false;
        void syncCard(cardId);
      } else {
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      source?.close();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyCardState, applyResultPatch, cardId, fallbackIntervalMs, syncCard]);
}
