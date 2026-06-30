"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Pairing, PublicCardSummary, PublicCardVersion, TournamentCard } from "@/domain/tournament/types";
import { useTournamentStore } from "./store";

const BASE_INTERVAL_MS = 60_000;
const JITTER_MS = 20_000;
type NotificationState = NotificationPermission | "unsupported";
interface PublicResultEvent {
  cardId: string;
  version: number;
  changedPairings: Pairing[];
}

function publishedGameCount(card: TournamentCard) {
  if (card.publishedGameCount !== undefined) return card.publishedGameCount;
  return new Set(card.snapshots
    .filter((snapshot) => Boolean(snapshot.confirmedAt))
    .flatMap((snapshot) => snapshot.gameNumbers)).size;
}

async function showPublicationNotification(previous: TournamentCard, next: PublicCardSummary) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;

  const finalPublished = previous.runtimeStage !== "FINAL_PUBLISHED" && next.runtimeStage === "FINAL_PUBLISHED";
  const resultsPublished = next.publishedGameCount > publishedGameCount(previous);
  const pairingPublished = previous.runtimeStage !== "RESULT_COLLECTION" && next.runtimeStage === "RESULT_COLLECTION";
  if (!finalPublished && !resultsPublished && !pairingPublished) return;

  const title = finalPublished
    ? `ประกาศผล ${next.name}`
    : resultsPublished
      ? `อัปเดต Ranking ${next.name}`
      : `Pairing ใหม่ ${next.name}`;
  const body = finalPublished
    ? `${next.division} ประกาศผลการแข่งขันอย่างเป็นทางการแล้ว`
    : resultsPublished
      ? `${next.division} เผยแพร่ผลเกม ${next.publishedGameCount} แล้ว`
      : `${next.division} เผยแพร่ Pairing เกม ${next.currentGame} แล้ว`;
  const options: NotificationOptions = {
    body,
    tag: `ctwe-publication-${next.id}`,
    data: { url: `/cards/${next.id}` },
  };

  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.register("/notification-sw.js");
      await registration.showNotification(title, options);
    } else {
      new Notification(title, options);
    }
  } catch {
    // Notification support differs between desktop and mobile browsers; sync must continue regardless.
  }
}

/**
 * An open public card uses an isolated SSE invalidation stream for live results. The edge-cached
 * version manifest remains the low-traffic fallback and keeps the public catalog in sync.
 */
export function usePublicSync(cardId: string | undefined, enabled: boolean) {
  const cards = useTournamentStore((state) => state.cards);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const applyResultPatch = useTournamentStore((state) => state.applyResultPatch);
  const refreshCatalog = useTournamentStore((state) => state.refreshPublicCatalog);
  const versionsRef = useRef(new Map<string, number>());
  const cardsRef = useRef(new Map<string, TournamentCard>());
  const [notificationPermission, setNotificationPermission] = useState<NotificationState>("unsupported");

  useEffect(() => {
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
  }, []);

  useEffect(() => {
    versionsRef.current = new Map(cards.map((card) => [card.id, card.version]));
    cardsRef.current = new Map(cards.map((card) => [card.id, card]));
    const openCard = cardId ? cards.find((card) => card.id === cardId) : undefined;
    if (enabled && cardId && openCard?.summaryOnly) void syncCard(cardId);
  }, [cardId, cards, enabled, syncCard]);

  useEffect(() => {
    if (!enabled || !cardId || !("EventSource" in window)) return;
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
  }, [applyResultPatch, cardId, enabled, syncCard]);

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
      try {
        const response = await fetch("/api/public/cards/versions", { credentials: "omit" });
        if (!response.ok) return;
        const remote = await response.json() as PublicCardVersion[];
        const changed = remote.filter((item) => versionsRef.current.get(item.id) !== item.version);
        const removed = [...versionsRef.current.keys()].some((id) => !remote.some((item) => item.id === id));
        if (changed.length > 0 || removed) {
          const versionToken = remote.map((item) => `${item.id}:${item.version}`).join(",");
          const summaries = await refreshCatalog(versionToken);
          for (const summary of summaries) {
            if (!changed.some((item) => item.id === summary.id)) continue;
            const previous = cardsRef.current.get(summary.id);
            if (previous) void showPublicationNotification(previous, summary);
          }
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

  const requestNotificationPermission = useCallback(async () => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return "unsupported" as const;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted" && "serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("/notification-sw.js"); } catch { /* browser fallback is used */ }
    }
    return permission;
  }, []);

  return { notificationPermission, requestNotificationPermission };
}
