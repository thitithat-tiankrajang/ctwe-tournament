/** The existing public entry paths; fragments never change bootstrap selection. */
export function isSpectatorRoute(pathname: string): boolean {
  return /^\/(?:tour|t)\/[^/]+\/?$/.test(pathname);
}

const CARD_HASH = /^#card=([0-9a-fA-F-]{36})$/;

export function spectatorCardFromHash(hash: string): string | null {
  return hash.match(CARD_HASH)?.[1] ?? null;
}

/**
 * Where inside one tournament the spectator is.
 *
 * The whole public experience stays on ONE URL: every destination is a fragment, so switching
 * between finding a player, a player's participation and the transitional division reports costs
 * zero requests and still gives the browser a real history entry to go Back to.
 *
 * `card` is Phase 1's shape and is deliberately unchanged — every QR code, chat message and printed
 * link carrying `#card={uuid}` has to keep resolving to the same division report forever.
 */
export type SpectatorRoute =
  | { kind: "home" }
  | { kind: "card"; cardId: string }
  | { kind: "find"; query: string; divisionId: string | null; school: string | null }
  | { kind: "player"; divisionId: string; code: string };

/**
 * The part of a public division report that belongs to the browser history entry.
 *
 * It deliberately contains presentation state only. Tournament data continues to come from the
 * public projection, while this small record lets Player → Back return to the same lens without
 * inventing another URL or persistence model.
 */
export type SpectatorReportView = "ranking" | "pairing" | "result";
export type SpectatorReportGame = number | "final" | "result" | null;
export interface SpectatorReportFilter {
  mode: "player" | "school";
  playerIds: string[];
  schools: string[];
  query: string;
}
export interface SpectatorReportContext {
  /** The division this lens belongs to; optional so older in-memory history entries remain readable. */
  cardId?: string;
  game: SpectatorReportGame;
  views: SpectatorReportView[];
  filter: SpectatorReportFilter;
  scrollY: number;
}

export const SPECTATOR_HOME: SpectatorRoute = { kind: "home" };

const REPORT_VIEWS: readonly SpectatorReportView[] = ["ranking", "pairing", "result"];
const isReportView = (value: unknown): value is SpectatorReportView =>
  typeof value === "string" && REPORT_VIEWS.includes(value as SpectatorReportView);
const isReportGame = (value: unknown): value is SpectatorReportGame =>
  value === null || value === "final" || value === "result"
  || (typeof value === "number" && Number.isInteger(value) && value >= 0);

/** Read a report context from history.state without trusting stale or hand-edited browser data. */
export function spectatorReportContextFromHistory(state: unknown): SpectatorReportContext | null {
  if (!state || typeof state !== "object") return null;
  const raw = (state as { spectatorReport?: unknown }).spectatorReport;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<SpectatorReportContext>;
  const filter = value.filter;
  if (!filter || typeof filter !== "object") return null;
  const rawFilter = filter as Partial<SpectatorReportFilter>;
  if (rawFilter.mode !== "player" && rawFilter.mode !== "school") return null;
  if (!Array.isArray(rawFilter.playerIds) || !rawFilter.playerIds.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(rawFilter.schools) || !rawFilter.schools.every((item) => typeof item === "string")) return null;
  if (typeof rawFilter.query !== "string" || !isReportGame(value.game)) return null;
  const views = Array.isArray(value.views) ? value.views.filter(isReportView) : [];
  const scrollY = typeof value.scrollY === "number" && Number.isFinite(value.scrollY) && value.scrollY >= 0
    ? value.scrollY : 0;
  return {
    ...(typeof value.cardId === "string" && value.cardId.trim() ? { cardId: value.cardId } : {}),
    game: value.game,
    views,
    filter: {
      mode: rawFilter.mode,
      playerIds: [...rawFilter.playerIds],
      schools: [...rawFilter.schools],
      query: rawFilter.query,
    },
    scrollY,
  };
}

/** `#player=<divisionId>:<CODE>` — the division scopes the code, exactly as participant keys do. */
const PLAYER_HASH = /^#player=([0-9a-fA-F-]{36}):(.+)$/;

function searchParams(rest: string): URLSearchParams {
  return new URLSearchParams(rest.startsWith("?") ? rest.slice(1) : rest);
}

/** Unknown, truncated or hand-edited fragments resolve to the entrance rather than to an error. */
export function parseSpectatorHash(hash: string): SpectatorRoute {
  const cardId = spectatorCardFromHash(hash);
  if (cardId) return { kind: "card", cardId };
  const player = hash.match(PLAYER_HASH);
  if (player) {
    const code = decodeURIComponent(player[2]).trim().toUpperCase();
    if (code) return { kind: "player", divisionId: player[1], code };
    return SPECTATOR_HOME;
  }
  if (hash === "#find" || hash.startsWith("#find?")) {
    const params = searchParams(hash.slice("#find".length));
    return { kind: "find", query: params.get("q") ?? "",
      divisionId: params.get("div") || null, school: params.get("school") || null };
  }
  return SPECTATOR_HOME;
}

/** The fragment for a route. The entrance is the empty fragment, so it never leaves a stub `#`. */
export function spectatorHash(route: SpectatorRoute): string {
  if (route.kind === "card") return `#card=${route.cardId}`;
  if (route.kind === "player") return `#player=${route.divisionId}:${encodeURIComponent(route.code)}`;
  if (route.kind === "find") {
    const params = new URLSearchParams();
    if (route.query.trim()) params.set("q", route.query.trim());
    if (route.divisionId) params.set("div", route.divisionId);
    if (route.school) params.set("school", route.school);
    const query = params.toString();
    return query ? `#find?${query}` : "#find";
  }
  return "";
}

/** Two routes are the same destination when their fragments are — used to avoid junk history. */
export function sameSpectatorRoute(first: SpectatorRoute, second: SpectatorRoute): boolean {
  return spectatorHash(first) === spectatorHash(second);
}
