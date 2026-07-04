"use client";

import { useEffect, useState } from "react";

export interface RealtimeConfig {
  realtimeEnabled: boolean;
  sseEnabled: boolean;
  pollingEnabled: boolean;
  pollingIntervalMs: number;
  reconnectDelayMs: number;
}

/** Safe fallbacks while the config request is in flight (mirror the server seeds). */
export const REALTIME_DEFAULTS: RealtimeConfig = {
  realtimeEnabled: true,
  sseEnabled: true,
  pollingEnabled: false,
  pollingIntervalMs: 60_000,
  reconnectDelayMs: 2_000,
};

// Module-level cache: all hook instances share one config request for the lifetime of this page.
let cached: RealtimeConfig | null = null;
let inflight: Promise<RealtimeConfig> | null = null;

async function fetchConfig(): Promise<RealtimeConfig> {
  const response = await fetch("/api/public/realtime-config", { credentials: "omit" });
  if (!response.ok) throw new Error(`realtime-config ${response.status}`);
  const body = await response.json() as Partial<RealtimeConfig>;
  return {
    realtimeEnabled: body.realtimeEnabled ?? REALTIME_DEFAULTS.realtimeEnabled,
    sseEnabled: body.sseEnabled ?? REALTIME_DEFAULTS.sseEnabled,
    pollingEnabled: body.pollingEnabled ?? REALTIME_DEFAULTS.pollingEnabled,
    pollingIntervalMs: body.pollingIntervalMs ?? REALTIME_DEFAULTS.pollingIntervalMs,
    reconnectDelayMs: body.reconnectDelayMs ?? REALTIME_DEFAULTS.reconnectDelayMs,
  };
}

export async function getRealtimeConfig(): Promise<RealtimeConfig> {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetchConfig()
      .then((config) => {
        cached = config;
        return config;
      })
      .catch(() => cached ?? REALTIME_DEFAULTS)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Admin-tunable sync strategy for the current browser. Starts with safe defaults, resolves from
 * the config endpoint once, and then relies exclusively on SSE for the lifetime of the page.
 */
export function useRealtimeConfig(): RealtimeConfig {
  const [config, setConfig] = useState<RealtimeConfig>(cached ?? REALTIME_DEFAULTS);

  useEffect(() => {
    let active = true;
    const refresh = () => void getRealtimeConfig().then((next) => {
      if (!active) return;
      setConfig((current) =>
        current.realtimeEnabled === next.realtimeEnabled
        && current.sseEnabled === next.sseEnabled
        && current.pollingEnabled === next.pollingEnabled
        && current.pollingIntervalMs === next.pollingIntervalMs
        && current.reconnectDelayMs === next.reconnectDelayMs
          ? current : next);
    });
    refresh();
    return () => { active = false; };
  }, []);

  return config;
}
