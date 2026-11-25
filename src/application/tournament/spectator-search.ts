import { comparePlayerCodes, matchesPlayerCode, normalizePlayerCode, PLAYER_CODE_QUERY } from "@/domain/tournament/player-code";
import type { SpectatorDivision, SpectatorParticipant } from "./spectator-read-model";

/**
 * What a spectator typed, resolved into the one thing it can mean.
 *
 * A tournament hands out numeric player codes, and the seats printed on the boards are numbers too.
 * A numeric query is ALWAYS a player code: mixing seat hits into these results would answer a
 * question nobody asked ("who is sitting at 27?") with the same weight as the one they did ask
 * ("where does A027 play?"). Seat lookup is a separate capability.
 */
export type SpectatorQueryKind = "empty" | "code" | "name";

export function spectatorQueryKind(query: string): SpectatorQueryKind {
  const trimmed = query.trim();
  if (!trimmed) return "empty";
  return PLAYER_CODE_QUERY.test(trimmed) ? "code" : "name";
}

export interface SpectatorSearchCriteria {
  query: string;
  /** Optional narrowing only. A spectator is never made to pick a division before searching. */
  divisionId: string | null;
  school: string | null;
}

export interface SpectatorSearchResult extends SpectatorParticipant {
  divisionLabel: string;
  /** The normalized code equals the normalized query — the strongest possible identification. */
  exactCode: boolean;
}

export interface SpectatorSearchOutcome {
  kind: SpectatorQueryKind;
  results: SpectatorSearchResult[];
  /** Matches before the display cap, so the UI can say "refine" instead of lying by omission. */
  total: number;
  /** Set only when one participant in the whole event carries exactly this code. */
  uniqueExactCode: SpectatorSearchResult | null;
}

/** Enough rows to scan on a phone; beyond this a spectator should add a filter, not scroll. */
export const SPECTATOR_SEARCH_LIMIT = 60;

export const divisionLabel = (division: SpectatorDivision) => division.division || division.name;

const normalizedName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export function divisionOptions(divisions: SpectatorDivision[]): { value: string; label: string }[] {
  return divisions.map(division => ({ value: division.id, label: divisionLabel(division) }))
    .sort((a, b) => a.label.localeCompare(b.label, "th", { numeric: true }));
}

/**
 * Institutions that can still be chosen, given the division already picked. Offering a school that
 * cannot appear in the current division would produce an empty result the spectator cannot explain.
 */
export function schoolOptions(divisions: SpectatorDivision[], divisionId: string | null): string[] {
  const scoped = divisionId ? divisions.filter(division => division.id === divisionId) : divisions;
  return [...new Set(scoped.flatMap(division => division.participants.map(participant => participant.school))
    .filter(school => school.trim() !== ""))].sort((a, b) => a.localeCompare(b, "th", { numeric: true }));
}

/**
 * Is every division's roster actually visible to the public right now?
 *
 * Only then can "one match" be trusted to mean "the only player with this code in the event" — a
 * division still in registration publishes no roster, so a code that looks unique may not be. Being
 * conservative costs one extra tap; being wrong opens somebody else's participation page.
 */
export function searchCoverageComplete(divisions: SpectatorDivision[]): boolean {
  return divisions.length > 0 && divisions.every(division => division.participants.length > 0);
}

export function searchParticipants(
  divisions: SpectatorDivision[],
  criteria: SpectatorSearchCriteria,
  limit = SPECTATOR_SEARCH_LIMIT,
): SpectatorSearchOutcome {
  const kind = spectatorQueryKind(criteria.query);
  if (kind === "empty") return { kind, results: [], total: 0, uniqueExactCode: null };
  const query = criteria.query.trim();
  const term = normalizedName(query);
  const normalizedQueryCode = kind === "code" ? normalizePlayerCode(query) : null;
  const scoped = criteria.divisionId ? divisions.filter(division => division.id === criteria.divisionId) : divisions;
  const matches = scoped.flatMap(division => {
    const label = divisionLabel(division);
    return division.participants
      .filter(participant => !criteria.school || participant.school === criteria.school)
      .filter(participant => kind === "code"
        ? matchesPlayerCode(participant.code, query)
        : normalizedName(participant.name).includes(term))
      .map(participant => ({ ...participant, divisionLabel: label,
        exactCode: normalizedQueryCode !== null && normalizePlayerCode(participant.code) === normalizedQueryCode }));
  });
  matches.sort((a, b) => Number(b.exactCode) - Number(a.exactCode)
    || a.divisionLabel.localeCompare(b.divisionLabel, "th", { numeric: true })
    || comparePlayerCodes(a.code, b.code));
  const exact = matches.filter(match => match.exactCode);
  return {
    kind,
    results: matches.slice(0, limit),
    total: matches.length,
    // Unique across the WHOLE event, not merely within the applied filters: a filter that hides the
    // second holder of a code must not turn an ambiguous code into an automatic destination.
    uniqueExactCode: exact.length === 1 && !criteria.divisionId && !criteria.school ? exact[0] : null,
  };
}
