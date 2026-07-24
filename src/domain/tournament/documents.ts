import type { Pairing, PairingSnapshot, TournamentCard } from "./types";

/**
 * What a director may export, and from which rows.
 *
 * The three documents become available at different moments, so they are gated separately instead
 * of waiting for the whole game to be over:
 *
 * - Pairing  — as soon as the pairing rows of that game are published (a PAIR_RESULT destination
 *              game is published while its source game is still being scored), or once the game's
 *              results are confirmed.
 * - Result   — once the game's snapshot is confirmed (results published), which is the only moment
 *              scores exist for everyone.
 * - Ranking  — same gate as Result: the standings after game N need game N's confirmed scores.
 */

export type DocumentKind = "pairing" | "ranking" | "result";

const gameOf = (pairing: Pairing, snapshot: PairingSnapshot) => pairing.gameNumber ?? snapshot.gameNumbers[0];

function collect(card: TournamentCard, gameNumber: number, confirmedOnly: boolean): Pairing[] {
  const rows: Pairing[] = [];
  for (const snapshot of card.snapshots) {
    const confirmed = Boolean(snapshot.confirmedAt);
    if (confirmedOnly && !confirmed) continue;
    for (const pairing of snapshot.pairings) {
      if (gameOf(pairing, snapshot) !== gameNumber) continue;
      // Backstage rows of an unconfirmed snapshot are not published yet — they never leave the app.
      if (!confirmed && !pairing.pairingPublished) continue;
      rows.push(pairing);
    }
  }
  return rows.sort((a, b) => a.tableNumber - b.tableNumber);
}

/** Rows for a Pairing document: the confirmed snapshot when it exists, else the published preview. */
export function pairingRowsForGame(card: TournamentCard, gameNumber: number): Pairing[] {
  const confirmed = collect(card, gameNumber, true);
  return confirmed.length > 0 ? confirmed : collect(card, gameNumber, false);
}

/** Rows for a Result document — confirmed snapshots only, so every score is final. */
export function resultRowsForGame(card: TournamentCard, gameNumber: number): Pairing[] {
  return collect(card, gameNumber, true);
}

/** Games whose results are published (confirmed snapshot) — the gate for Ranking and Result. */
export function publishedGames(card: TournamentCard): number[] {
  const games = card.snapshots
    .filter((snapshot) => Boolean(snapshot.confirmedAt))
    .flatMap((snapshot) => snapshot.gameNumbers);
  return [...new Set(games)].sort((a, b) => a - b);
}

/** Games whose pairings are published — the gate for Pairing, ahead of any result being entered. */
export function pairingPublishedGames(card: TournamentCard): number[] {
  const games = new Set<number>();
  for (const snapshot of card.snapshots) {
    const confirmed = Boolean(snapshot.confirmedAt);
    for (const pairing of snapshot.pairings) {
      if (confirmed || pairing.pairingPublished) games.add(gameOf(pairing, snapshot));
    }
  }
  return [...games].sort((a, b) => a - b);
}

export function availableGames(card: TournamentCard, kind: DocumentKind): number[] {
  return kind === "pairing" ? pairingPublishedGames(card) : publishedGames(card);
}
