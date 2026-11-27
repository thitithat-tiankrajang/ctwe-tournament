"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { prototypeSportTheme } from "./prototype-spectator-chrome";

/**
 * Admin-chosen sport accents for the public report, scoped by tournament and kept in this
 * browser's localStorage — the accepted design's behaviour. Every open tab of this browser follows
 * a change immediately; other browsers keep the defaults.
 */
const KEY = "ctwe.sportColors";
const EVENT = "ctwe:sport-colors";
const defaults: Record<string, string> = { "A-Math": "#315db3", Crossword: "#246f60", "คำคม": "#7751a3" };

export const isSportColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
export const defaultSportColor = (sport: string) => defaults[sport] ?? "#315db3";
const keyOf = (tournamentId: string, sport: string) => JSON.stringify([tournamentId, sport]);

function readAll(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export function readSportColor(tournamentId: string | undefined, sport: string): string | undefined {
  if (!tournamentId) return undefined;
  const value = readAll()[keyOf(tournamentId, sport)];
  return isSportColor(value) ? value : undefined;
}

export function sportColorFor(tournamentId: string | undefined, sport: string) {
  return readSportColor(tournamentId, sport) ?? defaultSportColor(sport);
}

export function writeSportColor(tournamentId: string, sport: string, color: string) {
  if (!isSportColor(color)) return;
  const all = readAll();
  all[keyOf(tournamentId, sport)] = color.toLowerCase();
  try { window.localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private browsing: keep the default */ }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === KEY) callback(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, callback);
  };
}

const snapshot = () => { try { return window.localStorage.getItem(KEY) ?? ""; } catch { return ""; } };

/** Re-renders the caller whenever this browser's sport colours change (any tab). */
export function useSportColorRevision(): string {
  return useSyncExternalStore(subscribe, snapshot, () => "");
}

export function sportThemeFor(tournamentId: string | undefined, sport: string): CSSProperties {
  return prototypeSportTheme(sport, readSportColor(tournamentId, sport));
}
