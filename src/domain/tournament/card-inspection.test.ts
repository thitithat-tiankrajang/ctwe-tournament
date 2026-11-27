import assert from "node:assert/strict";
import test from "node:test";
import { canInspectCard, inspectCard, inspectTournament } from "./card-inspection";
import { canManageTournament, isOperator } from "./roles";
import type { Tournament, TournamentCard } from "./types";
import { gameOnePreviewFixture, inspectionFixture, seatsFor } from "@/application/tournament/fixtures/card-inspection-fixture";

const auth = (roles: string[], authenticated = true) => ({ authenticated, roles });

test("only an authenticated ADMIN may inspect; mutation gates are unchanged for ADMIN", () => {
  assert.equal(canInspectCard(auth(["ROLE_ADMIN"])), true);
  assert.equal(canInspectCard(auth(["ROLE_DIRECTOR"])), false);
  assert.equal(canInspectCard(auth(["ROLE_STAFF"])), false);
  assert.equal(canInspectCard(auth([], false)), false);
  assert.equal(canInspectCard(auth(["ROLE_ADMIN"], false)), false);
  // Inspection must not have been implemented by widening the mutation helpers.
  assert.equal(canManageTournament(auth(["ROLE_ADMIN"])), false);
  assert.equal(isOperator(auth(["ROLE_ADMIN"])), false);
  assert.equal(canManageTournament(auth(["ROLE_DIRECTOR"])), true);
  assert.equal(isOperator(auth(["ROLE_STAFF"])), true);
});

test("full card: per-game maxDiff, rule and pairing state come straight from the payload", () => {
  const state = inspectCard(inspectionFixture());
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  const card = state.inspection;
  assert.equal(card.totalGames, 3);
  assert.equal(card.currentGame, 2);
  assert.deepEqual(card.games.map((game) => game.maxDiff), [250, 400, 175]);
  assert.deepEqual(card.games.map((game) => [game.rule, game.ruleSource]),
    [["RANDOM", "initial"], ["SWISS", "transition"], ["KING_OF_THE_HILL", "transition"]]);
  assert.deepEqual(card.games.map((game) => game.pairingState), ["confirmed", "published", "none"]);
  assert.deepEqual(card.games.map((game) => [game.tableCount, game.publishedCount, game.resultCount]),
    [[2, 2, 2], [2, 2, 1], [0, 0, 0]]);
  assert.deepEqual(card.games[0].pairings.map((row) => row.table), [1, 2], "pairing rows are table-ordered");
  assert.equal(card.finalType, "CHAMPION_AND_THIRD");
  assert.equal(card.finalGames, 3);
  assert.equal(card.finalSlotCount, null, "final not seeded yet: no slot count invented");
  assert.equal(card.gibsonEnabled, true);
  assert.equal(card.slotLabel, "SEAT");
});

test("an unpublished preview reads as a draft, and a partly published one as partial", () => {
  const draft = inspectionFixture();
  draft.snapshots[1].pairings.forEach((pairing) => { pairing.pairingPublished = false; });
  const drafted = inspectCard(draft);
  assert.equal(drafted.kind === "ready" && drafted.inspection.games[1].pairingState, "draft");
  draft.snapshots[1].pairings[0].pairingPublished = true;
  const partial = inspectCard(draft);
  assert.equal(partial.kind === "ready" && partial.inspection.games[1].pairingState, "partial");
});

test("missing values stay missing: no default rule, no zero maxDiff, no default slot label", () => {
  const card = inspectionFixture();
  card.rules = [{ fromGame: 1, toGame: 2, type: "SWISS" }];
  card.games[0].maxDiff = 0;
  delete card.slotLabel;
  card.finalType = "NONE";
  const state = inspectCard(card);
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.equal(state.inspection.games[0].maxDiff, null);
  assert.deepEqual([state.inspection.games[2].rule, state.inspection.games[2].ruleSource], [null, "unset"]);
  assert.equal(state.inspection.slotLabel, null);
  assert.equal(state.inspection.finalGames, null);
});

test("a summary-only or absent card is never presented as complete configuration", () => {
  const summary = { ...inspectionFixture(), summaryOnly: true, games: [], rules: [], snapshots: [] };
  assert.deepEqual(inspectCard(summary), { kind: "partial" });
  assert.deepEqual(inspectCard(undefined), { kind: "missing" });
  const sparse = { ...inspectionFixture() } as Partial<TournamentCard>;
  delete sparse.games;
  assert.deepEqual(inspectCard(sparse as TournamentCard), { kind: "partial" });
});

test("tournament OPEN and CLOSED both resolve; an unknown tournament is reported, not guessed", () => {
  const tournaments: Tournament[] = [
    { id: "t-open", name: "Open Cup", status: "OPEN", createdBy: null, createdAt: "", version: 1, directors: [], cardCount: 1, accessToken: "x" },
    { id: "t-closed", name: "Closed Cup", status: "CLOSED", createdBy: null, createdAt: "", version: 1, directors: [], cardCount: 1, accessToken: "y" },
  ];
  assert.deepEqual(inspectTournament(tournaments, "t-open"), { kind: "ready", name: "Open Cup", status: "OPEN" });
  assert.deepEqual(inspectTournament(tournaments, "t-closed"), { kind: "ready", name: "Closed Cup", status: "CLOSED" });
  assert.deepEqual(inspectTournament(tournaments, "t-gone"), { kind: "unavailable" });
  assert.deepEqual(inspectTournament(null, "t-open"), { kind: "loading" });
});

// ---- game 1 PAIRING_PREVIEW lives in seats (card.tables), not matches ---------------------------

const game1 = (card: TournamentCard) => {
  const state = inspectCard(card);
  assert.equal(state.kind, "ready");
  return state.kind === "ready" ? state.inspection.games[0] : assert.fail("not ready");
};

test("game-1 draft with no match rows is read from seats: draft, pair-numbered across tables", () => {
  const game = game1(gameOnePreviewFixture(8));
  assert.equal(game.pairingState, "draft");
  assert.equal(game.pairingSource, "seating");
  assert.deepEqual([game.tableCount, game.publishedCount, game.resultCount], [4, 0, 0]);
  assert.deepEqual(game.pairings.map((row) => [row.table, row.playerOne, row.playerTwo, row.bye, row.published]), [
    [1, "A001", "A002", false, false],
    [2, "A003", "A004", false, false],
    [3, "A005", "A006", false, false],
    [4, "A007", "A008", false, false],
  ]);
});

test("odd player count: the bye is its own pair slot, on the last table or a new one", () => {
  // 7 players → 3 pairs; bye at seat 3 of table 2 → slots 1..4, slot 4 is the bye.
  assert.deepEqual(seatsFor(7).map((table) => table.playerIds), [["A001", "A002", "A003", "A004"], ["A005", "A006", "A007"]]);
  const seven = game1(gameOnePreviewFixture(7));
  assert.deepEqual([seven.pairingState, seven.tableCount], ["draft", 4]);
  assert.deepEqual(seven.pairings.at(-1), { table: 4, playerOne: "A007", playerTwo: null, scoreOne: null, scoreTwo: null, published: false, voided: false, bye: true });
  assert.equal(seven.pairings.filter((row) => row.bye).length, 1);
  // 5 players → 2 pairs; bye opens table 2 seat 1 → slot 3.
  const five = game1(gameOnePreviewFixture(5));
  assert.deepEqual(five.pairings.map((row) => [row.table, row.playerOne, row.playerTwo, row.bye]),
    [[1, "A001", "A002", false], [2, "A003", "A004", false], [3, "A005", null, true]]);
});

test("before generation there is genuinely no pairing, and seats outside game-1 preview are ignored", () => {
  const before = gameOnePreviewFixture(8);
  before.runtimeStage = "TABLE_PAIRING";
  before.tables = [];
  assert.deepEqual([game1(before).pairingState, game1(before).pairingSource, game1(before).tableCount], ["none", "none", 0]);
  // Same seats, wrong stage: seats are not a pairing outside PAIRING_PREVIEW of game 1.
  const stale = gameOnePreviewFixture(8);
  stale.runtimeStage = "TABLE_PAIRING";
  assert.equal(game1(stale).pairingState, "none");
});

test("after confirmation the match rows are used and the surviving seats are not double-counted", () => {
  const confirmed = gameOnePreviewFixture(8);
  confirmed.runtimeStage = "RESULT_COLLECTION"; // seats survive until results are published
  confirmed.snapshots = [{ id: "preview-1", gameNumbers: [1], confirmedAt: "", pairings: [1, 2, 3, 4].map((slot) => ({
    id: `g1-t${slot}`, gameNumber: 1, tableNumber: slot,
    playerOneId: `A00${slot * 2 - 1}`, playerTwoId: `A00${slot * 2}`, pairingPublished: true,
  })) }];
  const game = game1(confirmed);
  assert.equal(game.pairingSource, "matches");
  assert.equal(game.pairingState, "published");
  assert.deepEqual([game.tableCount, game.publishedCount], [4, 4]);
  // Even inside PAIRING_PREVIEW, existing match rows win over seats.
  confirmed.runtimeStage = "PAIRING_PREVIEW";
  assert.deepEqual([game1(confirmed).pairingSource, game1(confirmed).tableCount], ["matches", 4]);
});

test("later-game inspection is unaffected by game-1 seats", () => {
  const card = inspectionFixture();
  card.tables = seatsFor(8); // present but irrelevant: the card is collecting game-2 results
  const state = inspectCard(card);
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.deepEqual(state.inspection.games.map((game) => [game.pairingSource, game.pairingState, game.tableCount]),
    [["matches", "confirmed", 2], ["matches", "published", 2], ["none", "none", 0]]);
});
