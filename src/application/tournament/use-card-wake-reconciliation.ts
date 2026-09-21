"use client";

import { useEffect } from "react";
import { useTournamentStore } from "./store";

/** Collapse browser resume signals that arrive together into one authoritative read. */
const RESUME_COALESCE_MS = 150;

export interface WakeReconciliationRunner {
  schedule: () => void;
  dispose: () => void;
}

/** Coalesce resume signals and guarantee one trailing read after an active read settles. */
export function createWakeReconciliationRunner(run: () => Promise<unknown>, options: {
  delayMs?: number;
  isVisible?: () => boolean;
} = {}): WakeReconciliationRunner {
  const delayMs = options.delayMs ?? RESUME_COALESCE_MS;
  const isVisible = options.isVisible ?? (() => true);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;

  const attempt = () => {
    if (disposed || !isVisible()) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    void Promise.resolve(run()).finally(() => {
      inFlight = false;
      if (queued) {
        queued = false;
        attempt();
      }
    });
  };

  return {
    schedule: () => {
      if (disposed || !isVisible()) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; attempt(); }, delayMs);
    },
    dispose: () => {
      disposed = true;
      queued = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function useCardWakeReconciliation(cardId: string | undefined, enabled: boolean) {
  const reconcileCard = useTournamentStore((state) => state.reconcileCard);

  useEffect(() => {
    if (!enabled || !cardId) return;

    const runner = createWakeReconciliationRunner(() => reconcileCard(cardId),
      { isVisible: () => document.visibilityState === "visible" });

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") runner.schedule();
    };
    const onResume = () => runner.schedule();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);

    return () => {
      runner.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [cardId, enabled, reconcileCard]);
}
