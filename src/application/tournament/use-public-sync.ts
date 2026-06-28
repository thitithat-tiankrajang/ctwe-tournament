"use client";

import { useEffect, useRef } from "react";
import type { PublicCardVersion } from "@/domain/tournament/types";
import { useTournamentStore } from "./store";

const BASE_INTERVAL_MS = 60_000;
const JITTER_MS = 20_000;

/**
 * Public viewers never hold an origin SSE connection. A tiny edge-cached manifest detects newly
 * published data, then only the open card is refreshed. Hidden tabs generate no polling traffic.
 */
export function usePublicSync(cardId: string | undefined, enabled: boolean) {
  const cards = useTournamentStore((state) => state.cards);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const refreshCatalog = useTournamentStore((state) => state.refreshPublicCatalog);
  const versionsRef = useRef(new Map<string, number>());

  useEffect(() => {
    versionsRef.current = new Map(cards.map((card) => [card.id, card.version]));
    const openCard = cardId ? cards.find((card) => card.id === cardId) : undefined;
    if (enabled && cardId && openCard?.summaryOnly) void syncCard(cardId);
  }, [cardId, cards, enabled, syncCard]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;

    const schedule = () => {
      if (!active) return;
      timer = window.setTimeout(
        () => void poll(),
        BASE_INTERVAL_MS - JITTER_MS / 2 + Math.random() * JITTER_MS,
      );
    };
    const poll = async () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      try {
        const response = await fetch("/api/public/cards/versions", { credentials: "omit" });
        if (!response.ok) return;
        const remote = await response.json() as PublicCardVersion[];
        const changed = remote.filter((item) => versionsRef.current.get(item.id) !== item.version);
        const removed = [...versionsRef.current.keys()].some((id) => !remote.some((item) => item.id === id));
        if (changed.length > 0 || removed) {
          const versionToken = remote.map((item) => `${item.id}:${item.version}`).join(",");
          await refreshCatalog(versionToken);
          if (cardId && changed.some((item) => item.id === cardId)) await syncCard(cardId);
        }
      } catch {
        // The current published snapshot remains usable while the network is unavailable.
      } finally {
        schedule();
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer !== undefined) window.clearTimeout(timer);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cardId, enabled, refreshCatalog, syncCard]);
}
