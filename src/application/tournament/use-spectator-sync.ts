"use client";

import { useEffect } from "react";
import { publicApiUrl } from "@/infrastructure/http/public-api";
import { getRealtimeConfig } from "./use-realtime-config";
import type { SpectatorStore, PublicDelta, SpectatorState } from "./spectator-state";

/** Same list/open-division subscription topology as the transitional viewer, with public-owned state. */
export function useSpectatorSync(store: SpectatorStore, cardId: string | null, source: SpectatorState["source"], retry: number) {
  useEffect(() => {
    if (source !== "live") return;
    let disposed = false;
    let stream: EventSource | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let polling: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const later = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!disposed) callback(); }, delay);
      timers.add(timer);
      return timer;
    };
    const refresh = async () => {
      if (cardId) await store.syncCard(cardId);
      else await store.load().catch(() => undefined);
    };
    const refreshSoon = () => {
      if (refreshTimer) return;
      refreshTimer = later(() => { refreshTimer = null; void refresh(); }, Math.random() * 4000);
    };
    // The stream can stay open through a short network loss while the card read it triggers fails
    // (seen as ERR_INTERNET_DISCONNECTED on ?v= reads with the EventSource still OPEN). Nothing would
    // ask again until the next event, so the newest version the stream announced is retried with
    // backoff until it lands, and immediately when the browser reports it is back online.
    let announced = -1;
    let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
    let catchUpDelay = 2000;
    const announce = (version: number) => { if (Number.isFinite(version)) announced = Math.max(announced, version); };
    const catchUp = () => {
      if (disposed || !cardId || catchUpTimer) return;
      const known = store.getSnapshot().cards.find(card => card.id === cardId)?.version;
      // An unknown card was removed or never loaded; the bundle path owns that case.
      if (known === undefined) return;
      if (known >= announced) {
        catchUpDelay = 2000;
        if (stream?.readyState === EventSource.OPEN && store.getSnapshot().freshness === "delayed") store.setFreshness("current");
        return;
      }
      catchUpTimer = later(() => { catchUpTimer = null; void store.syncCard(cardId).then(catchUp); }, catchUpDelay);
      catchUpDelay = Math.min(catchUpDelay * 2, 30000);
    };
    const onOnline = () => {
      if (!cardId) { void refresh(); return; }
      if (catchUpTimer) { clearTimeout(catchUpTimer); timers.delete(catchUpTimer); catchUpTimer = null; }
      catchUpDelay = 2000;
      void store.syncCard(cardId).then(catchUp);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    void getRealtimeConfig().then(config => {
      if (disposed) return;
      if (!config.realtimeEnabled) { store.setFreshness("delayed"); return; }
      let backoff = Math.max(config.reconnectDelayMs, 2000);
      const stopPolling = () => {
        if (polling) { clearTimeout(polling); timers.delete(polling); polling = null; }
      };
      const poll = () => {
        if (polling) return;
        polling = later(() => { polling = null; void refresh().finally(() => { if (!disposed) poll(); }); }, Math.max(config.pollingIntervalMs, 15000));
      };
      const connect = () => {
        if (disposed) return;
        if (!config.sseEnabled || typeof EventSource === "undefined") {
          store.setFreshness("delayed");
          if (config.pollingEnabled) poll();
          return;
        }
        const path = cardId ? `/api/public/cards/${encodeURIComponent(cardId)}/events`
          : `/api/public/tournaments/${encodeURIComponent(store.getSnapshot().token)}/events`;
        const current = new EventSource(publicApiUrl(path));
        stream = current;
        current.addEventListener("connected", event => {
          if (disposed) return;
          stopPolling();
          backoff = Math.max(config.reconnectDelayMs, 2000);
          if (!cardId) { refreshSoon(); return; }
          try {
            const payload = JSON.parse((event as MessageEvent<string>).data) as { version: number };
            announce(payload.version);
            const known = store.getSnapshot().cards.find(card => card.id === cardId)?.version;
            if (known === payload.version) store.setFreshness("current");
            else void store.syncCard(cardId, payload.version).then(() => {
              if (!disposed && store.getSnapshot().cards.find(card => card.id === cardId)?.version === payload.version)
                store.setFreshness("current");
              catchUp();
            });
          } catch { refreshSoon(); }
        });
        if (cardId) {
          const bumped = (event: Event) => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as { version: number };
              announce(payload.version);
              const known = store.getSnapshot().cards.find(card => card.id === cardId)?.version;
              if (known === undefined || payload.version > known) void store.syncCard(cardId, payload.version).then(catchUp);
            } catch { refreshSoon(); }
          };
          current.addEventListener("message", bumped);
          current.addEventListener("card", bumped);
          for (const type of ["result", "pairings", "publish"] as const) current.addEventListener(type, event => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as PublicDelta;
              if (payload.cardId !== cardId || !Number.isFinite(payload.version)) throw new Error("Invalid public event");
              announce(payload.version);
              store.applyDelta({ ...payload, type } as PublicDelta);
              void Promise.resolve().then(catchUp);
            } catch { refreshSoon(); }
          });
        } else {
          current.addEventListener("card-summary", event => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as {
                tournamentId: string; cardId: string; summary: { version: number };
              };
              if (payload.tournamentId !== store.getSnapshot().tournament?.id) return;
              // Retain full rosters until the replacement arrives; never turn them into summaries.
              void store.syncCard(payload.cardId, payload.summary.version);
            } catch { refreshSoon(); }
          });
          current.addEventListener("card-removed", event => {
            try {
              const payload = JSON.parse((event as MessageEvent<string>).data) as { tournamentId: string; cardId: string };
              if (payload.tournamentId === store.getSnapshot().tournament?.id) store.removeCard(payload.cardId);
            } catch { refreshSoon(); }
          });
        }
        current.onerror = () => {
          if (disposed) return;
          store.setFreshness("reconnecting");
          if (current.readyState !== EventSource.CLOSED) return;
          current.close();
          poll(); // Capacity refusal must not silently freeze a live viewer.
          later(connect, backoff + Math.random() * backoff);
          backoff = Math.min(backoff * 2, 60000);
        };
      };
      connect();
    });
    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      stream?.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [store, cardId, source, retry]);
}
