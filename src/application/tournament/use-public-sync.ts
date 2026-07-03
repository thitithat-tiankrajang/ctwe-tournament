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
 * An open public card uses an isolated SSE invalidation stream for live results. The edge-cached
 * version manifest remains the low-traffic fallback and keeps the public catalog in sync.
 * Strategy (SSE on/off, polling on/off + interval) follows the admin-managed runtime config; when
 * the server refuses a stream (disabled or at capacity) the polling loop is the automatic fallback.
 */
export function usePublicSync(cardId: string | undefined, enabled: boolean) {
  const cards = useTournamentStore((state) => state.cards);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const applyResultPatch = useTournamentStore((state) => state.applyResultPatch);
  const refreshCatalog = useTournamentStore((state) => state.refreshPublicCatalog);
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

  useEffect(() => {
    if (!enabled || !config.realtimeEnabled || !config.pollingEnabled) return;
    let active = true;
    let timer: number | undefined;

    const schedule = () => {
      if (!active) return;
      // ±1/6 jitter spreads 5,000 viewers' polls instead of thundering the edge together.
      const base = config.pollingIntervalMs;
      const jitter = base / 3;
      timer = window.setTimeout(
        () => void poll(),
        base - jitter / 2 + Math.random() * jitter,
      );
    };
    const poll = async () => {
      if (!active) return;
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
  }, [cardId, enabled, config.realtimeEnabled, config.pollingEnabled, config.pollingIntervalMs, refreshCatalog, syncCard]);

}
