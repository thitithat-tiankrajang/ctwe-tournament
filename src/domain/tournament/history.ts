import type { Pairing, PairingSnapshot, Player, TournamentCard } from "./types";
import { NO_HEAD_TO_HEAD, rank, type H2HProvider, type RankInput } from "./ranking";

export function snapshotForGame(snapshots: PairingSnapshot[], gameNumber: number) {
  return snapshots.find((snapshot) => snapshot.gameNumbers.includes(gameNumber));
}

export interface PlayerHistoryRow {
  /** Stable across the two sections: qualifying rows are `q-N`, championship rows `f-N`. */
  key: string;
  game: number;
  table: number;
  result: "W" | "T" | "L";
  cumulativeWinPoints: number;
  ownScore: number;
  opponentScore: number;
  diff: number;
  cumulativeDiff: number;
  opponentId: string;
  /** True for a championship-round game; `gameLabel` then carries a display name like "ชิง 1". */
  final?: boolean;
  gameLabel?: string;
}

/**
 * One player's record, split at the boundary the tournament rules draw.
 *
 * Qualification and the championship are two separate accumulations: the final decides placings,
 * it does not add to the totals a player qualified on. Keeping them in separate arrays with
 * separate running totals makes the leak that used to exist structurally impossible rather than
 * merely fixed — `qualifyingTotals` cannot see a championship row.
 */
export interface PlayerHistory {
  qualifying: PlayerHistoryRow[];
  /** Empty unless the scope asked for the final and this player reached it. */
  final: PlayerHistoryRow[];
  qualifyingTotals: { winPoints: number; diff: number };
}

function hasPlayer(pairing: Pairing, playerId: string): boolean {
  return pairing.playerOneId === playerId || pairing.playerTwoId === playerId;
}

/**
 * Which games a history view covers.
 *
 * Callers state the scope explicitly rather than handing in a pre-filtered card, because
 * pre-filtering invites the mistake this replaced: dropping a whole snapshot whose LAST game is
 * past the cutoff also drops its earlier games. A PAIR_RESULT block bundles games N and N+1 into
 * one snapshot, so viewing game N must still show game N.
 */
export interface HistoryScope {
  /** Qualifying games up to and including this number. */
  throughGame: number;
  /** Append the championship round after the qualifying games. */
  includeFinal: boolean;
}

/** The game a pairing belongs to; a snapshot may bundle several (PAIR_RESULT blocks). */
function pairingGame(pairing: Pairing, snapshot: PairingSnapshot): number {
  return pairing.gameNumber ?? Math.min(...snapshot.gameNumbers);
}

/** Per-game play history for one player, with running totals, bounded by `scope`. */
export function playerHistory(card: TournamentCard, playerId: string, scope: HistoryScope): PlayerHistory {
  const entries: { game: number; pairing: Pairing }[] = [];
  card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt)).forEach((snapshot) => {
    snapshot.pairings.forEach((pairing) => {
      const recorded = pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
      if (!recorded || !hasPlayer(pairing, playerId)) return;
      // Bound per PAIRING, never per snapshot — the same rule rankingAfterGame already applies.
      const game = pairingGame(pairing, snapshot);
      if (game > scope.throughGame) return;
      entries.push({ game, pairing });
    });
  });
  entries.sort((a, b) => a.game - b.game);

  let cumulativeWinPoints = 0; let cumulativeDiff = 0;
  const rows: PlayerHistoryRow[] = entries.map(({ game, pairing }) => {
    const isOne = pairing.playerOneId === playerId;
    const ownScore = (isOne ? pairing.scoreOne : pairing.scoreTwo) ?? 0;
    const opponentScore = (isOne ? pairing.scoreTwo : pairing.scoreOne) ?? 0;
    const result: "W" | "T" | "L" = pairing.resultType === "DRAW" ? "T" : pairing.winnerId === playerId ? "W" : "L";
    cumulativeWinPoints += result === "W" ? 2 : result === "T" ? 1 : 0;
    const diff = pairing.resultType === "PENALTY"
      ? -(pairing.calculatedDiff ?? 0)
      : ownScore - opponentScore;
    cumulativeDiff += diff;
    return { key: `q-${game}`, game, table: pairing.tableNumber, result, cumulativeWinPoints, ownScore, opponentScore, diff, cumulativeDiff, opponentId: (isOne ? pairing.playerTwoId : pairing.playerOneId) ?? "" };
  });
  const qualifyingTotals = { winPoints: cumulativeWinPoints, diff: cumulativeDiff };

  // The championship round is a SEPARATE accumulation. Its counters start at zero, so a final can
  // never move the totals a player qualified on, and it is only built when the scope asks for it.
  const finalRows: PlayerHistoryRow[] = [];
  if (!scope.includeFinal) return { qualifying: rows, final: finalRows, qualifyingTotals };
  const slot = card.finalRound?.slots.find((entry) => entry.playerOneId === playerId || entry.playerTwoId === playerId);
  let finalWinPoints = 0; let finalDiff = 0;
  slot?.games.forEach((finalGame) => {
    if (finalGame.scoreOne == null || finalGame.scoreTwo == null) return;
    const isOne = slot.playerOneId === playerId;
    const ownScore = isOne ? finalGame.scoreOne : finalGame.scoreTwo;
    const opponentScore = isOne ? finalGame.scoreTwo : finalGame.scoreOne;
    const result: "W" | "T" | "L" = finalGame.winnerId == null ? "T" : finalGame.winnerId === playerId ? "W" : "L";
    finalWinPoints += result === "W" ? 2 : result === "T" ? 1 : 0;
    const diff = ownScore - opponentScore;
    finalDiff += diff;
    finalRows.push({
      key: `f-${finalGame.gameIndex}`, game: finalGame.gameIndex,
      gameLabel: `ชิง ${finalGame.gameIndex}`, final: true,
      table: 0, result, cumulativeWinPoints: finalWinPoints, ownScore, opponentScore,
      diff, cumulativeDiff: finalDiff,
      opponentId: (isOne ? slot.playerTwoId : slot.playerOneId) ?? "",
    });
  });
  return { qualifying: rows, final: finalRows, qualifyingTotals };
}

/**
 * Final placings for the "ผลการแข่งขัน" view: the championship bracket decides the top seats
 * (slot 0 winner = 1st / loser = 2nd, slot 1 winner = 3rd / loser = 4th) and everyone else follows
 * the regular standings. A card without a final round simply returns its final regular standings.
 */
export function finalStandings(card: TournamentCard, lastGame: number): Player[] {
  const base = lastGame > 0 ? rankingAfterGame(card, lastGame) : [];
  const round = card.finalRound;
  if (!round || card.finalType === "NONE") return base;
  const byId = new Map(card.players.map((player) => [player.id, player]));
  const ordered: Player[] = [];
  const placed = new Set<string>();
  const place = (id: string | null | undefined) => {
    if (id && byId.has(id) && !placed.has(id)) { ordered.push(byId.get(id)!); placed.add(id); }
  };
  [...round.slots].sort((a, b) => a.slot - b.slot).forEach((slot) => {
    if (!slot.winnerId) return; // unresolved bracket: fall back to standings order for these players
    place(slot.winnerId);
    place(slot.winnerId === slot.playerOneId ? slot.playerTwoId : slot.playerOneId);
  });
  base.forEach((player) => place(player.id));
  return ordered;
}

/** A player with the figures the ranking rule is computed from, plus where they placed. */
export interface RankedPlayer extends Player {
  /** Points scored across qualifying games. A bye counts; a penalty is not a game. */
  scoreFor: number;
  /** Qualifying games played, on the same rule. */
  games: number;
  /** `scoreFor / games`, or 0 before anyone has played. */
  average: number;
  /** Shared by players the rules could not separate: 1, 2, 2, 4. */
  displayRank: number;
}

/** One recorded meeting between two real opponents, used to aggregate head-to-head. */
interface Meeting { one: string; two: string; winnerId?: string; scoreOne: number; scoreTwo: number; diff: number }

/**
 * Head-to-head over the meetings the client already holds — no request, no matrix.
 *
 * `hasMet` is answered from a set built in the same pass that read the rows, so the engine resolves
 * the overwhelmingly common "these two never played" case without aggregating anything. Aggregation
 * is memoised per unordered pair, because neighbours shift during the promotion walk and the same
 * pair can become adjacent more than once.
 */
function meetingsProvider(meetings: Meeting[]): H2HProvider {
  if (meetings.length === 0) return NO_HEAD_TO_HEAD;
  const met = new Map<string, Set<string>>();
  const remember = (a: string, b: string) => {
    if (!met.has(a)) met.set(a, new Set());
    met.get(a)!.add(b);
  };
  meetings.forEach((meeting) => { remember(meeting.one, meeting.two); remember(meeting.two, meeting.one); });

  const cache = new Map<string, 1 | 0 | -1>();
  return {
    hasMet: (playerId, opponentId) => met.get(playerId)?.has(opponentId) ?? false,
    verdict: (playerId, opponentId) => {
      const [first] = [playerId, opponentId].sort();
      const key = [playerId, opponentId].sort().join("|");
      const cached = cache.get(key);
      if (cached !== undefined) return (first === playerId ? cached : -cached) as 1 | 0 | -1;
      let wins = 0; let diff = 0; let points = 0; let against = 0;
      for (const meeting of meetings) {
        const isOne = meeting.one === playerId && meeting.two === opponentId;
        const isTwo = meeting.one === opponentId && meeting.two === playerId;
        if (!isOne && !isTwo) continue;
        points += isOne ? meeting.scoreOne : meeting.scoreTwo;
        against += isOne ? meeting.scoreTwo : meeting.scoreOne;
        // A draw has no winner and counts for neither side.
        if (meeting.winnerId === playerId) { wins += 1; diff += meeting.diff; }
        else if (meeting.winnerId === opponentId) { wins -= 1; diff -= meeting.diff; }
      }
      const result = (wins !== 0 ? Math.sign(wins) : diff !== 0 ? Math.sign(diff) : Math.sign(points - against)) as 1 | 0 | -1;
      cache.set(key, (first === playerId ? result : -result) as 1 | 0 | -1);
      return result;
    },
  };
}

export function rankingAfterGame(card: TournamentCard, gameNumber: number): RankedPlayer[] {
  const ranking = new Map(card.players.map((player) => [player.id, {
    ...player,
    wins: 0,
    draws: 0,
    losses: 0,
    winPoints: 0,
    diff: 0,
    scoreFor: 0,
    games: 0,
  }]));
  const meetings: Meeting[] = [];
  const snapshots = card.snapshots
    .filter((snapshot) => Boolean(snapshot.confirmedAt) && snapshot.gameNumbers.some((game) => game <= gameNumber))
    .sort((a, b) => Math.min(...a.gameNumbers) - Math.min(...b.gameNumbers));

  snapshots.forEach((snapshot) => snapshot.pairings.forEach((pairing) => {
    if ((!pairing.playerOneId && !pairing.playerTwoId) || (pairing.gameNumber ?? snapshot.gameNumbers[0]) > gameNumber || pairing.scoreOne === undefined || pairing.scoreTwo === undefined) return;
    const one = pairing.playerOneId ? ranking.get(pairing.playerOneId) : undefined;
    const two = pairing.playerTwoId ? ranking.get(pairing.playerTwoId) : undefined;
    // A row counts toward ScoreFor and the game count exactly when it counted toward the standings.
    // Anything else would let the two figures disagree about what a "game" is.
    const played = (entry: typeof one, score: number) => {
      if (!entry) return;
      entry.scoreFor += score;
      entry.games += 1;
    };
    if (pairing.resultType === "DRAW") {
      if (!one || !two) return;
      one.draws += 1; two.draws += 1; one.winPoints += 1; two.winPoints += 1;
      played(one, pairing.scoreOne); played(two, pairing.scoreTwo);
      meetings.push({ one: one.id, two: two.id, scoreOne: pairing.scoreOne, scoreTwo: pairing.scoreTwo, diff: 0 });
      return;
    }
    if (pairing.resultType === "PENALTY") {
      // A penalty is not a game: it is a sanction recorded when there is no trustworthy result. Its
      // stored 0:0 scores exist only to satisfy a database constraint, so counting them would inject
      // a fabricated zero into the average and punish the player a second time. Diff still applies.
      const diff = pairing.calculatedDiff ?? 0;
      for (const penalised of [one, two]) {
        if (!penalised) continue;
        penalised.losses += 1;
        penalised.diff -= diff;
      }
      return;
    }
    const winner = pairing.winnerId === one?.id ? one : pairing.winnerId === two?.id ? two : undefined;
    if (!winner) return;
    const loser = winner === one ? two : one;
    const diff = pairing.calculatedDiff ?? Math.abs(pairing.scoreOne - pairing.scoreTwo);
    winner.wins += 1; winner.winPoints += 2; winner.diff += diff;
    if (loser) { loser.losses += 1; loser.diff -= diff; }
    played(one, pairing.scoreOne); played(two, pairing.scoreTwo);
    // A bye has only one player, so it is a game but never a head-to-head meeting.
    if (one && two)
      meetings.push({ one: one.id, two: two.id, winnerId: winner.id, scoreOne: pairing.scoreOne, scoreTwo: pairing.scoreTwo, diff });
  }));

  // Terminated players are scored (so their past opponents' wins/losses stay correct) but never
  // shown in the standings — once withdrawn they live only in the director's restore "trash". They
  // are dropped BEFORE ranking so they never occupy a rank number.
  const active = [...ranking.values()].filter((player) => !player.terminated);
  const byId = new Map(active.map((player) => [player.id, player]));
  const inputs: RankInput[] = active.map((player) => ({
    playerId: player.id, winPoints: player.winPoints, diff: player.diff, scoreFor: player.scoreFor, games: player.games,
  }));
  return rank(inputs, meetingsProvider(meetings)).map((entry) => ({
    ...byId.get(entry.playerId)!,
    average: entry.average,
    displayRank: entry.displayRank,
  }));
}
