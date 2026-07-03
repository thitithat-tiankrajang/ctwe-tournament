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
  pollingEnabled: true,
  pollingIntervalMs: 60_000,
  reconnectDelayMs: 2_000,
};

const REFRESH_MS = 60_000;

// Module-level cache: every hook instance shares one fetch per refresh window, so a page full of
// components costs a single tiny edge-cached request per minute.
let cached: RealtimeConfig | null = null;
let fetchedAt = 0;
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
  if (cached && Date.now() - fetchedAt < REFRESH_MS) return cached;
  if (!inflight) {
    inflight = fetchConfig()
      .then((config) => {
        cached = config;
        fetchedAt = Date.now();
        return config;
      })
      .catch(() => cached ?? REALTIME_DEFAULTS)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Admin-tunable sync strategy for the current browser. Starts with safe defaults, resolves from
 * the edge-cached config endpoint, and re-checks once a minute so admin changes reach open tabs
 * without a reload.
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
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return config;
}
