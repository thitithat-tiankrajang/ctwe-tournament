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

/** Every game grouped into result blocks: a PAIR_RESULT edge x→x+1 makes [x, x+1] one block; others stand alone. */
export function allResultBlocks(card: TournamentCard): number[][] {
  const blocks: number[][] = [];
  const total = card.games.length;
  let game = 1;
  while (game <= total) {
    const pairResult = card.rules.some((rule) => rule.fromGame === game && rule.toGame === game + 1 && rule.type === "PAIR_RESULT");
    if (pairResult && game < total) { blocks.push([game, game + 1]); game += 2; }
    else { blocks.push([game]); game += 1; }
  }
  return blocks;
}
