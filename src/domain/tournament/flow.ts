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

/** Published source games keep their historical view while the destination stays editable. */
export function editableResultGames(card: TournamentCard): number[] {
  const games = resultBlockGames(card);
  const sourcePublished = games.length > 1 && card.snapshots.some((snapshot) =>
    Boolean(snapshot.confirmedAt) && snapshot.gameNumbers.length === 1 && snapshot.gameNumbers[0] === games[0]);
  return sourcePublished ? games.slice(1) : games;
}

export function rosterBlockScopes(card: TournamentCard) {
  const block = resultBlockGames(card);
  if (card.runtimeStage !== "RESULT_COLLECTION" || block.length < 2) return [];
  const games = editableResultGames(card);
  const last = block[block.length - 1];
  return [
    ...games.map((game) => game === block[0]
      ? { game, label: `ทั้งชุด เกม ${block[0]}–${last}`, detail: "เอาออกจากคู่ทั้งชุด" }
      : { game, label: `ตั้งแต่เกม ${game}`, detail: `คงคู่ ผล และอันดับเกม ${game - 1}` }),
    { game: last + 1, label: "หลังจบชุดนี้", detail: "คงคู่ ผล และอันดับทั้งชุด" },
  ];
}
