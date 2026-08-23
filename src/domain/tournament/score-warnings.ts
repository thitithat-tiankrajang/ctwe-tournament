/**
 * Scores that are unusual but not wrong.
 *
 * An A-Math game normally lands in the hundreds. A score far outside that is usually a typo — a
 * dropped digit, or a diff typed into a score box — but it is occasionally real, so this must never
 * block a save. The operator is told which player's score looks odd and decides.
 *
 * Pure and shared, because five surfaces submit scores (the entry grid, quick key-in, bye rows, the
 * director's override editor and the final board) and they must all say the same thing.
 */

/** Below this, a score reads as unusually low. */
export const LOW_SCORE_THRESHOLD = 100;
/** Above this, a score reads as unusually high. */
export const HIGH_SCORE_THRESHOLD = 999;

export interface ScoreWarning {
  /** The code of the player whose score it is — the warning names them, not the pairing. */
  playerId: string;
  kind: "low" | "high";
  message: string;
}

export interface ScoreEntry {
  playerId: string;
  score: number;
}

/** Warnings for one saved result. Both sides can warn, and both are reported. */
export function scoreWarnings(entries: readonly ScoreEntry[]): ScoreWarning[] {
  const warnings: ScoreWarning[] = [];
  for (const { playerId, score } of entries) {
    if (!Number.isFinite(score)) continue;
    if (score < LOW_SCORE_THRESHOLD)
      warnings.push({ playerId, kind: "low", message: `คะแนน ${playerId} ต่ำกว่าปกติ` });
    else if (score > HIGH_SCORE_THRESHOLD)
      warnings.push({ playerId, kind: "high", message: `คะแนน ${playerId} มากกว่าปกติ` });
  }
  return warnings;
}

/** True when this single score is outside the normal band — drives the inline badge. */
export function isUnusualScore(score: number): boolean {
  return Number.isFinite(score) && (score < LOW_SCORE_THRESHOLD || score > HIGH_SCORE_THRESHOLD);
}
