import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spectatorDivision, type PublicDivisionPayload } from "@/application/tournament/spectator-read-model";
import type { Pairing, PairingSnapshot } from "@/domain/tournament/types";
import { cardStageInfo, viewerCardStageInfo } from "@/ui/components/stage-info";

const code = (n: number) => `A00${n}`;
const pairs: Record<number, [number, number][]> = { 1: [[1, 2], [3, 4]], 2: [[1, 3], [2, 4]], 3: [[1, 4], [2, 3]], 4: [[1, 2], [3, 4]] };
const rows = (game: number, scored: boolean, published: boolean): Pairing[] => pairs[game].map(([a, b], i) => ({
  id: `g${game}-t${i + 1}`, gameNumber: game, tableNumber: i + 1, playerOneId: code(a), playerTwoId: code(b),
  pairingPublished: published,
  ...(scored ? { scoreOne: 400, scoreTwo: 300, winnerId: code(a), resultType: "WIN" as const, calculatedDiff: 100 } : {}),
}));
const confirmed = (game: number): PairingSnapshot => ({ id: `s${game}`, gameNumbers: [game], confirmedAt: `2026-11-21T0${game}:00:00Z`, pairings: rows(game, true, true) });
const open = (game: number, scored: boolean, published: boolean): PairingSnapshot =>
  ({ id: `preview-${game}`, gameNumbers: [game], confirmedAt: "", pairings: rows(game, scored, published) });

/** A synthetic public payload: 5 games, raw currentGame and snapshots as given. */
function payload(currentGame: number, runtimeStage: PublicDivisionPayload["runtimeStage"], snapshots: PairingSnapshot[]): PublicDivisionPayload {
  return {
    id: "card-1", tournamentId: "t-1", name: "Live Cup", division: "Open", status: "RUNNING", runtimeStage, currentGame,
    version: 31, games: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), number: n, name: `เกม ${n}`, status: "PENDING", maxDiff: 350 })),
    players: [1, 2, 3, 4].map((n) => ({ id: code(n), firstName: `P${n}`, lastName: "F", school: "S", division: "Open",
      wins: 0, draws: 0, losses: 0, winPoints: 0, diff: 0, terminated: false })),
    snapshots, finalType: "NONE", finalGames: 0, finalRound: null, gibsonEnabled: false, createdAt: "2026-11-21T00:00:00Z",
    codePrefix: "A", initialPairingRule: "RANDOM", slotLabel: "PAIR",
  };
}
const viewerLabel = (card: PublicDivisionPayload) =>
  viewerCardStageInfo(card, spectatorDivision(card).publication.currentGame).label;

test("PAIR_RESULT publish-next: game-4 pairing public while raw currentGame is 3 → the list says 4/5", () => {
  const card = payload(3, "RESULT_COLLECTION", [confirmed(1), confirmed(2), confirmed(3), open(4, false, true)]);
  assert.equal(spectatorDivision(card).publication.currentGame, 4, "the report already shows game 4");
  assert.equal(viewerLabel(card), "เกม 4/5 · กำลังแข่งขัน");
});

test("an unpublished future pairing is ignored → still 3/5", () => {
  const card = payload(3, "RESULT_COLLECTION", [confirmed(1), confirmed(2), open(3, true, true), open(4, false, false)]);
  assert.equal(viewerLabel(card), "เกม 3/5 · กำลังแข่งขัน");
});

test("ordinary flows are unchanged: game in progress, and SWISS after results publish", () => {
  const inGame = payload(3, "RESULT_COLLECTION", [confirmed(1), confirmed(2), open(3, true, true)]);
  assert.equal(viewerLabel(inGame), "เกม 3/5 · กำลังแข่งขัน");
  const afterResults = payload(4, "TABLE_PAIRING", [confirmed(1), confirmed(2), confirmed(3)]);
  assert.equal(viewerLabel(afterResults), "เกม 4/5 · กำลังแข่งขัน", "raw currentGame already ahead of published games");
});

test("the badge never goes below the card's own game and tolerates a missing division", () => {
  const card = payload(4, "TABLE_PAIRING", [confirmed(1)]);
  assert.equal(viewerCardStageInfo(card, 2).label, "เกม 4/5 · กำลังแข่งขัน");
  assert.equal(viewerCardStageInfo(card, undefined).label, "เกม 4/5 · กำลังแข่งขัน");
});

test("staff/operator wording keeps the operational currentGame", () => {
  const card = payload(3, "RESULT_COLLECTION", [confirmed(1), confirmed(2), confirmed(3), open(4, false, true)]);
  assert.equal(cardStageInfo(card, "staff").label, "เกม 3/5 · กรอกผล");
});

test("the public list renders through viewerCardStageInfo with no extra request", () => {
  const viewer = readFileSync(join(process.cwd(), "src/ui/components/tournament-viewer.tsx"), "utf8");
  assert.match(viewer, /viewerCardStageInfo\(card, publishedGameById\.get\(card\.id\)\)/);
  assert.equal(/cardStageInfo\(card, "viewer"\)/.test(viewer), false, "no raw-currentGame viewer badge left");
  const stageInfo = readFileSync(join(process.cwd(), "src/ui/components/stage-info.ts"), "utf8");
  assert.equal(/\bfetch\(|EventSource|publicApiUrl/.test(stageInfo), false);
});
