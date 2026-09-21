import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SpectatorParticipation } from "@/ui/components/spectator-participation";
import { CardOverviewView } from "@/ui/components/card-overview-view";
import { SpectatorPairList } from "@/ui/components/spectator-report-lists";
import { spectatorDivision, type PublicDivisionPayload } from "./spectator-read-model";
import { spectatorPlayerView } from "./spectator-player";
import { applyPublicDelta, createSpectatorState } from "./spectator-state";
import { legacyPublicCard } from "./spectator-read-model";
import { playerHistory, rankingAfterGame } from "@/domain/tournament/history";
import { w1PlayerFixture } from "./fixtures/spectator-player-fixtures";

// tsx runs the repository's JSX-preserve configuration with the classic JSX runtime.
Object.assign(globalThis, { React });

const viewOf = (card: PublicDivisionPayload) => spectatorPlayerView(card, spectatorDivision(card), "A001")!;
const playerMarkup = (card: PublicDivisionPayload) => renderToStaticMarkup(React.createElement(SpectatorParticipation, {
  card, division: spectatorDivision(card), code: "A001", onBack: () => {}, onBrowseDivision: () => {},
}));

test("B: a provisional result visible in the public Result report remains on Player after the next pairing", () => {
  const card = w1PlayerFixture();
  const report = renderToStaticMarkup(React.createElement(SpectatorPairList, {
    pairings: [card.snapshots[1].pairings[0]], players: new Map(card.players.map(p => [p.id, p])),
    mode: "result", slotLabel: "PAIR", emptyText: "ไม่มีผล",
  }));
  assert.match(report, />312</, "the actual public Result renderer exposes game 2's score");
  assert.match(report, />450</);
  assert.equal(viewOf(card).assignment?.game, 3, "the newer pairing is actionable");
  const player = playerMarkup(card);
  assert.match(player, /312/, "Player must not lose the publicly visible game-2 result");
  assert.match(player, /450/);
  assert.match(player, /ยังไม่รวมอันดับ/);
  assert.deepEqual(viewOf(card).ledger.map(game => [game.game, game.state]), [[1, "official"], [2, "recorded"], [3, "awaiting-result"]]);
  assert.equal((player.match(/data-game="2"/g) ?? []).length, 1);
  assert.equal(viewOf(card).standing?.throughGame, 1);
  assert.deepEqual([viewOf(card).standing?.wins, viewOf(card).standing?.losses, viewOf(card).standing?.diff], [1, 0, 120]);
});

test("A: official N remains in history while pairing N+1 is actionable", () => {
  const card = w1PlayerFixture();
  card.snapshots = [card.snapshots[0], { ...card.snapshots[1], gameNumbers: [2], pairings: [{
    id: "w1-g2-next", gameNumber: 2, tableNumber: 2, playerOneId: "A001", playerTwoId: "A004", pairingPublished: true,
  }] }];
  card.currentGame = 2;
  const view = viewOf(card);
  assert.equal(view.assignment?.game, 2);
  assert.deepEqual(view.history.qualifying.map(row => row.game), [1]);
  assert.match(playerMarkup(card), /data-game="1" data-publication="official"/);
});

test("C: provisional N and awaiting N+1 coexist without an old location instruction", () => {
  const card = w1PlayerFixture();
  card.snapshots[1].pairings.pop();
  const view = viewOf(card);
  assert.equal(view.assignment, null);
  assert.equal(view.awaitingGame, 3);
  assert.deepEqual(view.ledger[1].score, { own: 312, opponent: 450 });
  const html = playerMarkup(card);
  assert.match(html, /ยังไม่ประกาศคู่แข่งขันเกม 3/);
  assert.match(html, /312 - 450/);
  assert.doesNotMatch(html, /เกมปัจจุบัน|spectator-seat/);
});

test("D: publishing changes the same game's status once; official aggregates change only then", () => {
  const card = w1PlayerFixture();
  const open = card.snapshots.pop()!;
  card.snapshots.push({ ...open, gameNumbers: [2], pairings: [open.pairings[0]] },
    { ...open, id: "w1-next", gameNumbers: [3], pairings: [open.pairings[1]] });
  const before = viewOf(card);
  const updated = applyPublicDelta(card, { type: "publish", cardId: card.id, version: card.version + 1,
    snapshotId: "w1-s2", gameNumbers: [2], confirmedAt: "2026-09-16T04:00:00Z", currentGame: 3, runtimeStage: "RESULT_COLLECTION" })!;
  const after = viewOf(updated);
  assert.deepEqual(after.ledger.map(game => game.key), before.ledger.map(game => game.key));
  assert.equal(before.ledger[1].state, "recorded");
  assert.equal(after.ledger[1].state, "official");
  assert.equal(after.assignment?.game, 3);
  assert.deepEqual([before.standing?.wins, before.standing?.losses, before.standing?.diff], [1, 0, 120]);
  assert.deepEqual([after.standing?.wins, after.standing?.losses, after.standing?.diff], [1, 1, -18]);
  assert.deepEqual(after.history, playerHistory(legacyPublicCard(updated), "A001", { throughGame: 2, includeFinal: false }));
  assert.equal(after.standing?.rank, rankingAfterGame(legacyPublicCard(updated), 2).find(p => p.id === "A001")?.displayRank);
  assert.equal((playerMarkup(updated).match(/data-game="2"/g) ?? []).length, 1);
  assert.match(playerMarkup(updated), /data-game="2" data-publication="official"/);
  assert.doesNotMatch(playerMarkup(updated), /ยังไม่รวมอันดับ/);
});

for (const state of ["withdrawn", "void"] as const) test(`${state === "withdrawn" ? "E" : "F"}: ${state} has no valid result or current location`, () => {
  const card = w1PlayerFixture();
  card.currentGame = 2;
  card.snapshots[1].pairings.pop();
  // Even retained score fields must not override an authoritative invalidation flag.
  Object.assign(card.snapshots[1].pairings[0], state === "withdrawn" ? { resultWithdrawn: true } : { voided: true });
  const view = viewOf(card);
  assert.equal(view.ledger[1].state, state);
  assert.equal(view.ledger[1].score, null);
  assert.equal(view.ledger[1].outcome, null);
  assert.equal(view.assignment, null);
  assert.equal(view.awaitingGame, null, "retracted result and canceled contest are not an unpublished pairing");
  const html = playerMarkup(card);
  assert.match(html, state === "withdrawn" ? /ถอนผลแล้ว/ : /ยกเลิกคู่แข่งขัน/);
  assert.doesNotMatch(html, /312|450|spectator-seat|เกมปัจจุบัน/);
  assert.deepEqual(view.standing, viewOf(w1PlayerFixture()).standing);
});

test("G: bye is explicit with no phantom opponent or played score; official awards remain readable", () => {
  const card = w1PlayerFixture();
  card.currentGame = 2;
  card.snapshots[1].pairings = [{ id: "w1-bye", gameNumber: 2, tableNumber: 2,
    playerOneId: "A001", playerTwoId: null, pairingPublished: true }];
  let view = viewOf(card);
  assert.equal(view.assignment?.bye, true);
  assert.equal(view.assignment?.opponent, null);
  assert.equal(view.ledger[1].score, null);
  assert.match(playerMarkup(card), /บาย/);
  assert.doesNotMatch(playerMarkup(card), /spectator-seat|ยังไม่ระบุคู่แข่ง|0 - 0/);
  Object.assign(card.snapshots[1].pairings[0], { resultType: "WIN", winnerId: "A001", scoreOne: 150, scoreTwo: 0, calculatedDiff: 150 });
  card.snapshots[1].confirmedAt = "2026-09-16T04:00:00Z";
  card.snapshots[1].gameNumbers = [2];
  view = viewOf(card);
  assert.equal(view.ledger[1].state, "official");
  assert.equal(view.standing?.wins, 2);
  assert.match(playerMarkup(card), /คะแนนตามกติกา 150/);
  assert.doesNotMatch(playerMarkup(card), /150 - 0|spectator-seat/);
});

test("H: withdrawn player keeps public results and official history but has no live action", () => {
  const card = w1PlayerFixture();
  card.players[0].terminated = true;
  const view = viewOf(card);
  assert.equal(view.assignment, null);
  assert.equal(view.awaitingGame, null);
  assert.equal(view.standing, null);
  assert.deepEqual(view.history.qualifying.map(game => game.game), [1]);
  assert.match(playerMarkup(card), /ถอนตัว/);
  assert.match(playerMarkup(card), /312 - 450/);
  assert.doesNotMatch(playerMarkup(card), /spectator-seat|เกมปัจจุบัน/);
});

function finalsCard(finalist: boolean) {
  const card = w1PlayerFixture();
  card.finalType = "CHAMPION";
  card.runtimeStage = "FINAL_COLLECTION";
  card.finalRound = { slots: [{ slot: 0, playerOneId: finalist ? "A001" : "A002", playerTwoId: "A003",
    games: [{ gameIndex: 1, scoreOne: 401, scoreTwo: 399, winnerId: finalist ? "A001" : "A002", diff: 2 }],
    winnerId: null, winnerWins: null, winnerLosses: null, totalDiff: null }] };
  return card;
}

test("I: finalist sees separate finals results, without a qualifying location or unofficial totals", () => {
  const card = finalsCard(true);
  const view = viewOf(card);
  assert.equal(view.assignment, null);
  assert.equal(view.awaitingGame, null);
  assert.equal(view.final?.opponent?.code, "A003");
  assert.equal(view.final?.official, false);
  assert.deepEqual(view.standing, viewOf(w1PlayerFixture()).standing);
  const html = playerMarkup(card);
  assert.match(html, /ผลยังไม่ทางการ/);
  assert.match(html, /401 - 399/);
  assert.match(html, /312 - 450/, "finals must not erase a publicly visible qualifying result");
  assert.doesNotMatch(html, /spectator-seat|เกมปัจจุบัน/);
});

test("J: non-finalist gets a finals-phase message, never an old current game", () => {
  const card = finalsCard(false);
  assert.equal(viewOf(card).final, null);
  const html = playerMarkup(card);
  assert.match(html, /การแข่งขันอยู่ในรอบชิงชนะเลิศ/);
  assert.match(html, /คุณไม่มีคู่แข่งขันรอบชิง/);
  assert.doesNotMatch(html, /spectator-seat|เกมปัจจุบัน/);
  assert.match(html, /312 - 450/);
});

test("K: an archived completed record uses the same Player ledger and makes no live request", async () => {
  const card = finalsCard(true);
  card.status = "FINISHED";
  card.runtimeStage = "FINAL_PUBLISHED";
  Object.assign(card.finalRound!.slots[0], { winnerId: "A001", winnerWins: 1, winnerLosses: 0, totalDiff: 2 });
  card.snapshots[1].pairings.pop();
  card.snapshots[1].gameNumbers = [2];
  card.snapshots[1].confirmedAt = "2026-09-16T04:00:00Z";
  const store = createSpectatorState("w1-archive", {
    snapshot: async () => ({ id: card.tournamentId, name: card.name, accessToken: "w1-archive",
      cardCount: 1, publishedCardCount: 1, cards: [legacyPublicCard(card)] }),
    fetch: async () => { throw new Error("archive must not request live data"); },
  });
  await store.load();
  assert.equal(store.getSnapshot().source, "archive");
  const archived = store.getSnapshot().cards[0];
  assert.deepEqual(viewOf(archived), viewOf(card));
  assert.equal(viewOf(archived).final?.official, true);
  const html = playerMarkup(archived);
  assert.match(html, /การแข่งขันจบแล้ว/);
  assert.match(html, /data-game="2" data-publication="official"/);
  assert.doesNotMatch(html, /spectator-seat|เกมปัจจุบัน|ยังไม่รวมอันดับ|ผลยังไม่ทางการ/);
});

test("completed bracket placement is shared by the public Result report and Player", () => {
  const card = w1PlayerFixture();
  card.status = "FINISHED";
  card.runtimeStage = "FINAL_PUBLISHED";
  card.snapshots[1].confirmedAt = "2026-09-16T04:00:00Z";
  card.finalType = "CHAMPION";
  card.finalRound = { slots: [{ slot: 0, playerOneId: "A001", playerTwoId: "A002", games: [],
    winnerId: "A002", winnerWins: 1, winnerLosses: 0, totalDiff: 2 }] };
  const division = spectatorDivision(card);
  assert.deepEqual(division.finalStandings.slice(0, 2).map(player => player.id), ["A002", "A001"]);
  const playerView = spectatorPlayerView(card, division, "A001")!;
  assert.equal(playerView.standing?.rank, 2);
  assert.equal(playerView.standing?.isFinal, true);
  const player = renderToStaticMarkup(React.createElement(SpectatorParticipation, {
    card, division, code: "A001", onBack: () => {}, onBrowseDivision: () => {},
  }));
  assert.match(player, /อันดับสุดท้าย/);
  assert.match(player, />#2</);
  const result = renderToStaticMarkup(React.createElement(CardOverviewView, {
    cardId: card.id, card: legacyPublicCard(card), spectator: true,
    initialSpectatorContext: { game: "result", views: [], filter: { mode: "player", playerIds: [], schools: [], query: "" }, scrollY: 0 },
    onSpectatorPlayer: () => {},
  }));
  assert.ok(result.indexOf("สมชาย ใจดี") < result.indexOf("ประภัสสรานุวัฒน์ ศรีสุวรรณวัฒนกิจจา"), "Result report must use the bracket winner first");
});

test("a recorded current game is explicit while the next pairing is still unpublished", () => {
  const card = w1PlayerFixture();
  card.currentGame = 2;
  card.snapshots[1] = { ...card.snapshots[1], gameNumbers: [2], pairings: [card.snapshots[1].pairings[0]] };
  const view = spectatorPlayerView(card, spectatorDivision(card), "A001")!;
  assert.equal(view.assignment, null);
  assert.equal(view.recordedCurrentGame?.game, 2);
  assert.deepEqual([view.standing?.wins, view.standing?.losses, view.standing?.diff], [1, 0, 120]);
  const html = renderToStaticMarkup(React.createElement(SpectatorParticipation, {
    card, division: spectatorDivision(card), code: "A001", onBack: () => {}, onBrowseDivision: () => {},
  }));
  assert.match(html, /เกม 2 บันทึกผลแล้ว/);
  assert.match(html, /รอประกาศคู่แข่งขันเกม 3/);
  assert.doesNotMatch(html, /spectator-seat/);
});

test("repeated public pairing IDs produce one ledger game while distinct IDs in the same game remain", () => {
  const card = w1PlayerFixture();
  const gameTwo = card.snapshots[1].pairings[0];
  card.snapshots.push({ id: "w1-confirmed-2", gameNumbers: [2], confirmedAt: "2026-09-16T05:00:00Z", pairings: [
    { ...gameTwo, resultType: "WIN", winnerId: "A003", scoreOne: 312, scoreTwo: 450, calculatedDiff: 138 },
    { id: "w1-g2-distinct", gameNumber: 2, tableNumber: 4, playerOneId: "A002", playerTwoId: "A004",
      pairingPublished: true, resultType: "DRAW", scoreOne: 300, scoreTwo: 300, calculatedDiff: 0 },
  ] });
  const division = spectatorDivision(card);
  assert.equal(division.contests.filter(contest => contest.locator === gameTwo.id).length, 1);
  assert.equal(division.contests.filter(contest => contest.game === 2).length, 2);
  const view = spectatorPlayerView(card, division, "A001")!;
  assert.deepEqual(view.ledger.filter(game => game.game === 2).map(game => game.key), [gameTwo.id]);
  assert.equal(view.ledger.find(game => game.game === 2)?.state, "official");
});
