"use client";

import { useEffect, useRef } from "react";
import type { Pairing, PublicCardVersion, TournamentCard } from "@/domain/tournament/types";
import { publicApiUrl } from "@/infrastructure/http/public-api";
import { useTournamentStore } from "./store";
import { useRealtimeConfig } from "./use-realtime-config";

interface PublicResultEvent {
  cardId: string;
  version: number;
  changedPairings: Pairing[];
}

/** A pairing publish pushed as data (the new game's rows) — applied without any refetch. */
interface PublicPairingsEvent {
  cardId: string;
  version: number;
  gameNumber: number;
  pairings: Pairing[];
}

/** A ranking publish pushed as the confirmation fact — applied without any refetch. */
interface PublicSnapshotEvent {
  cardId: string;
  version: number;
  snapshotId: string;
  gameNumbers: number[];
  confirmedAt: string;
  runtimeStage: TournamentCard["runtimeStage"];
  currentGame: number;
}

/** Spread broadcast-triggered full refetches so thousands of viewers do not hit the origin in the same second. */
const REFETCH_JITTER_MS = 4_000;
/** Ceiling for the re-subscribe backoff after a fatal SSE refusal (e.g. 503 over capacity). */
const MAX_RESUBSCRIBE_DELAY_MS = 60_000;

/**
 * An open public card uses one isolated SSE stream for live results, connected straight to the
 * public API origin (bypassing the Worker proxy). There is intentionally no routine polling:
 * EventSource reconnects itself after transient drops, which keeps request volume flat during
 * quiet periods.
 *
 * A refused stream (server 503 when over the viewer cap or SSE switched off) permanently closes
 * EventSource, so this hook adds two safety nets: it retries the subscription with jittered
 * backoff, and while disconnected it falls back to polling the tiny versions endpoint so viewers
 * keep receiving published data instead of a silently frozen page.
 */
export function usePublicSync(cardId: string | undefined, enabled: boolean) {
  const cards = useTournamentStore((state) => state.cards);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const applyResultPatch = useTournamentStore((state) => state.applyResultPatch);
  const applyPairingsPatch = useTournamentStore((state) => state.applyPairingsPatch);
  const applySnapshotPublish = useTournamentStore((state) => state.applySnapshotPublish);
  const config = useRealtimeConfig();
  const versionsRef = useRef(new Map<string, number>());

  useEffect(() => {
    versionsRef.current = new Map(cards.map((card) => [card.id, card.version]));
    const openCard = cardId ? cards.find((card) => card.id === cardId) : undefined;
    if (enabled && cardId && openCard?.summaryOnly) void syncCard(cardId);
  }, [cardId, cards, enabled, syncCard]);

  useEffect(() => {
    if (!enabled || !cardId || !config.realtimeEnabled) return;

    let disposed = false;
    let source: EventSource | null = null;
    let pollTimer: number | undefined;
    let resubscribeDelay = Math.max(config.reconnectDelayMs, 2_000);
    const timers = new Set<number>();

    const later = (run: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!disposed) run();
      }, delay);
      timers.add(timer);
    };
    const jitter = (max: number) => Math.random() * max;
    const syncSoon = (version?: number) => later(() => void syncCard(cardId, version), jitter(REFETCH_JITTER_MS));

    const stopPolling = () => {
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      pollTimer = undefined;
    };
    const schedulePoll = () => {
      const interval = Math.max(config.pollingIntervalMs, 15_000);
      pollTimer = window.setTimeout(() => {
        void (async () => {
          try {
            const response = await fetch(publicApiUrl("/api/public/cards/versions"), { credentials: "omit" });
            if (response.ok) {
              const versions = await response.json() as PublicCardVersion[];
              const latest = versions.find((entry) => entry.id === cardId);
              const known = versionsRef.current.get(cardId);
              if (latest && (known === undefined || latest.version > known)) syncSoon(latest.version);
            }
          } catch { /* transient poll error — next cycle retries */ }
          if (!disposed && pollTimer !== undefined) schedulePoll();
        })();
      }, interval + jitter(interval / 4));
    };
    const startPolling = () => {
      if (pollTimer !== undefined) return;
      schedulePoll();
    };

    const refreshOpenCard = (event?: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string> | undefined)?.data ?? "") as PublicCardVersion;
        // A delta event (result/pairings/publish) may already have advanced us to this version —
        // the generic bump is then old news and must not trigger a redundant refetch.
        const known = versionsRef.current.get(cardId);
        if (known !== undefined && payload.version <= known) return;
        syncSoon(payload.version);
      } catch {
        syncSoon();
      }
    };

    /** Shared guard for delta events: apply exactly version+1, resync on any gap or failure. */
    const applyDelta = (version: number, apply: () => boolean) => {
      const known = versionsRef.current.get(cardId);
      if (known !== undefined && version <= known) return;
      if (known === undefined || version !== known + 1) {
        void syncCard(cardId, version);
        return;
      }
      if (apply()) versionsRef.current.set(cardId, version);
      else void syncCard(cardId, version);
    };

    const connect = () => {
      if (!config.sseEnabled || !("EventSource" in window)) {
        // Live streams intentionally off (admin switch or no EventSource support): slow polling
        // only when the admin allows it. Capacity refusals below always poll — that state is not
        // an admin decision and viewers must not freeze silently.
        if (config.pollingEnabled) startPolling();
        return;
      }
      const stream = new EventSource(publicApiUrl(`/api/public/cards/${encodeURIComponent(cardId)}/events`));
      source = stream;
      stream.onopen = () => {
        resubscribeDelay = Math.max(config.reconnectDelayMs, 2_000);
        stopPolling();
      };
      stream.onmessage = refreshOpenCard;
      stream.addEventListener("card", refreshOpenCard);
      stream.addEventListener("connected", (event) => {
        stopPolling();
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as PublicCardVersion;
          if (versionsRef.current.get(cardId) !== payload.version) void syncCard(cardId, payload.version);
        } catch {
          refreshOpenCard();
        }
      });
      stream.addEventListener("result", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as PublicResultEvent;
          if (payload.cardId !== cardId || payload.changedPairings === undefined)
            throw new Error("Malformed public result event");
          applyDelta(payload.version, () => applyResultPatch(cardId, payload.version, payload.changedPairings));
        } catch {
          void syncCard(cardId);
        }
      });
      // A pairing publish arrives as data: splice the new game's rows in, no refetch.
      stream.addEventListener("pairings", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as PublicPairingsEvent;
          if (payload.cardId !== cardId || payload.pairings === undefined)
            throw new Error("Malformed public pairings event");
          applyDelta(payload.version, () => applyPairingsPatch(cardId, payload.version, payload.gameNumber, payload.pairings));
        } catch {
          void syncCard(cardId);
        }
      });
      // A ranking publish arrives as the confirmation fact: mark the snapshot confirmed locally.
      stream.addEventListener("publish", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as PublicSnapshotEvent;
          if (payload.cardId !== cardId || payload.snapshotId === undefined)
            throw new Error("Malformed public publish event");
          applyDelta(payload.version, () => applySnapshotPublish(cardId, payload.version, {
            snapshotId: payload.snapshotId,
            gameNumbers: payload.gameNumbers,
            confirmedAt: payload.confirmedAt,
            runtimeStage: payload.runtimeStage,
            currentGame: payload.currentGame,
          }));
        } catch {
          void syncCard(cardId);
        }
      });
      stream.onerror = () => {
        // CONNECTING means the browser is retrying on its own — leave it alone. CLOSED is fatal
        // (server refused the stream); recover manually and keep data flowing via polling.
        if (stream.readyState !== EventSource.CLOSED || disposed) return;
        stream.close();
        if (source === stream) source = null;
        startPolling();
        later(connect, resubscribeDelay + jitter(resubscribeDelay));
        resubscribeDelay = Math.min(resubscribeDelay * 2, MAX_RESUBSCRIBE_DELAY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      stopPolling();
      timers.forEach((timer) => window.clearTimeout(timer));
      source?.close();
    };
  }, [applyResultPatch, applyPairingsPatch, applySnapshotPublish, cardId, enabled, config.realtimeEnabled, config.sseEnabled, config.pollingEnabled, config.pollingIntervalMs, config.reconnectDelayMs, syncCard]);
}
