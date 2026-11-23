import { comparePlayerCodes, matchesPlayerCode, normalizePlayerCode, parseSearchQuery } from "@/domain/tournament/player-code";
import type { SpectatorDivision, SpectatorParticipant } from "./spectator-read-model";
import type { SpectatorReportContext, SpectatorReportGame, SpectatorReportView } from "./spectator-route";

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
  return parseSearchQuery(trimmed).kind === "codes" ? "code" : "name";
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
  const parsed = parseSearchQuery(query);
  const codes = parsed.kind === "codes" ? parsed.tokens : [];
  const normalizedQueryCode = codes.length === 1 ? normalizePlayerCode(codes[0]) : null;
  const scoped = criteria.divisionId ? divisions.filter(division => division.id === criteria.divisionId) : divisions;
  const matches = scoped.flatMap(division => {
    const label = divisionLabel(division);
    return division.participants
      .filter(participant => !criteria.school || participant.school === criteria.school)
      .filter(participant => kind === "code"
        ? codes.some((code) => matchesPlayerCode(participant.code, code))
        : term.split(" ").every((word) => [participant.name, participant.school, division.name, label]
          .some((value) => normalizedName(value).includes(word))))
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

export interface SpectatorReportSearchHit {
  division: SpectatorDivision;
  label: string;
  context: SpectatorReportContext;
  details?: boolean;
}

export function searchReports(divisions: SpectatorDivision[], query: string, selectedGame: SpectatorReportGame = null): SpectatorReportSearchHit[] {
  const term = normalizedName(query);
  if (!term) return [];
  const game = term.match(/^(?:เกม(?:ที่)?|game)\s*(\d+)$/);
  const place = term.match(/^(คู่(?:ที่)?|ที่นั่ง|pair|seat)\s*(\d+)$/);
  const final = /^(?:รอบชิง(?:ชนะเลิศ)?|เกมชิงชนะเลิศ|ชิงชนะเลิศ|finals?)$/.test(term);
  const details = /^(?:รายละเอียด(?:การแข่งขัน|การ์ด)?|max diff|เพดานผลต่าง)$/.test(term);
  const view: SpectatorReportView | undefined = /^(?:ranking|อันดับ|ตารางอันดับ|คะแนนสะสม)$/.test(term) ? "ranking"
    : /^(?:pairing|คู่แข่งขัน|ตารางคู่|การจับคู่)$/.test(term) ? "pairing"
      : /^(?:result|ผล|ผลการแข่งขัน|คะแนน)$/.test(term) ? "result" : undefined;

  return divisions.flatMap((division) => {
    const publishedGames = division.publication.publishedGames;
    const activeGame = typeof selectedGame === "number" && publishedGames.includes(selectedGame)
      ? selectedGame : publishedGames.at(-1) ?? null;
    const hit = (label: string, game: SpectatorReportGame, views: SpectatorReportView[], playerIds: string[] = []): SpectatorReportSearchHit => ({
      division, label,
      context: { cardId: division.id, game, views, filter: { mode: "player", playerIds, schools: [], query: "" }, scrollY: 0 },
    });
    if (game) {
      const number = Number(game[1]);
      return publishedGames.includes(number) ? [hit(`เกม ${number}`, number, ["pairing"])] : [];
    }
    if (final) return division.finals ? [hit("รอบชิงชนะเลิศ", "final", ["pairing"])] : [];
    if (details) return [{ ...hit("รายละเอียดการแข่งขัน", activeGame, ["pairing"]), details: true }];
    if (view) {
      if (activeGame === null) return [];
      const gamesWithResults = division.publication.officialGames;
      const displayGame = view === "result" && !gamesWithResults.includes(activeGame)
        && !division.contests.some((contest) => contest.game === activeGame && contest.result)
        ? gamesWithResults.at(-1) : activeGame;
      return displayGame === undefined ? [] : [hit({ ranking: "Ranking", pairing: "Pairing", result: "Result" }[view], displayGame, [view])];
    }
    if (place) {
      const number = Number(place[2]);
      const bySeat = place[1] === "seat" || place[1] === "ที่นั่ง";
      const contest = division.contests.find((row) => row.game === activeGame && row.state !== "void" && (
        bySeat ? row.assignments.some((assignment) => assignment.seat === number && assignment.participantKey) : row.pairNumber === number
      ));
      if (!contest) return [];
      const keys = new Set(contest.assignments.map((assignment) => assignment.participantKey));
      const ids = division.participants.filter((participant) => keys.has(participant.key)).map((participant) => participant.code);
      return ids.length ? [hit(`${bySeat ? "ที่นั่ง" : "คู่ที่"} ${number} · เกม ${contest.game}`, contest.game, ["pairing"], ids)] : [];
    }
    const divisionName = normalizedName(`${division.name} ${division.division}`);
    return term.split(" ").every((word) => divisionName.includes(word))
      ? [hit(division.division || division.name, activeGame, ["pairing"])] : [];
  });
}
