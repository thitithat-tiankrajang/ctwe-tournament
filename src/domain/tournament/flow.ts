import type { TournamentCard } from "./types";

export function resultBlockGames(card: TournamentCard) {
  const outgoingPairResult = card.rules.some((rule) =>
    rule.fromGame === card.currentGame && rule.toGame === card.currentGame + 1 && rule.type === "PAIR_RESULT");
  return outgoingPairResult && card.currentGame < card.games.length
    ? [card.currentGame, card.currentGame + 1]
    : [card.currentGame];
}

export function isPairResultBlock(card: TournamentCard) {
  return resultBlockGames(card).length === 2;
}
