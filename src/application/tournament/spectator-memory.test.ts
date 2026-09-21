import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompletedPlayerHero, SpectatorParticipation } from "@/ui/components/spectator-participation";
import { SpectatorMemoryCard } from "@/ui/components/spectator-memory-card";
import { w1PlayerFixture } from "./fixtures/spectator-player-fixtures";
import { spectatorPlayerView } from "./spectator-player";
import { spectatorDivision, type PublicDivisionPayload } from "./spectator-read-model";

Object.assign(globalThis, { React });

function completedQualifyingCard(): PublicDivisionPayload {
  const card = w1PlayerFixture();
  card.status = "FINISHED";
  card.runtimeStage = "FINAL_PUBLISHED";
  card.snapshots[1].confirmedAt = "2026-09-16T05:00:00Z";
  Object.assign(card.snapshots[1].pairings[1], {
    resultType: "WIN", winnerId: "A001", scoreOne: 390, scoreTwo: 350, calculatedDiff: 40,
  });
  return card;
}

function completedBracketCard(): PublicDivisionPayload {
  const card = completedQualifyingCard();
  card.finalType = "CHAMPION";
  card.finalGames = 1;
  card.finalRound = { slots: [{
    slot: 0, playerOneId: "A001", playerTwoId: "A002",
    games: [{ gameIndex: 1, scoreOne: 380, scoreTwo: 410, winnerId: "A002", diff: 30 }],
    winnerId: "A002", winnerWins: 1, winnerLosses: 0, totalDiff: 30,
  }] };
  return card;
}

const viewOf = (card: PublicDivisionPayload, code = "A001") =>
  spectatorPlayerView(card, spectatorDivision(card), code)!;

const playerMarkup = (card: PublicDivisionPayload, code = "A001") => renderToStaticMarkup(
  React.createElement(SpectatorParticipation, {
    card, division: spectatorDivision(card), code, onBack: () => {}, onBrowseDivision: () => {},
  }),
);

test("W8: a fully official completed qualifying record becomes eligible", () => {
  const card = completedQualifyingCard();
  const view = viewOf(card);
  assert.deepEqual(view.completedRecord, {
    placing: view.standing!.rank,
    wins: view.standing!.wins,
    draws: view.standing!.draws,
    losses: view.standing!.losses,
    diff: view.standing!.diff,
    gamesPlayed: view.standing!.wins + view.standing!.draws + view.standing!.losses,
    averageScore: 374,
    winRate: 2 / 3 * 100,
    statsScope: "tournament",
  });
  const html = playerMarkup(card);
  assert.match(html, /data-completed-record="true"/);
  assert.match(html, /ผลการแข่งขันอย่างเป็นทางการ/);
  assert.match(html, />บันทึกภาพ<\/button>/);
  assert.doesNotMatch(html, /เกมปัจจุบัน|spectator-seat|รอประกาศคู่แข่งขัน/);
});

test("W8: any public provisional result blocks the final record presentation", () => {
  const card = w1PlayerFixture();
  card.status = "FINISHED";
  card.runtimeStage = "FINAL_PUBLISHED";
  const view = viewOf(card);
  assert.equal(view.phase, "complete");
  assert.equal(view.completedRecord, null);
  const html = playerMarkup(card);
  assert.doesNotMatch(html, /data-completed-record="true"/);
  assert.match(html, /ยังไม่รวมอันดับ/);
});

test("W8: completed bracket hero uses finalStandings and labels qualifying statistics", () => {
  const card = completedBracketCard();
  const division = spectatorDivision(card);
  assert.deepEqual(division.finalStandings.slice(0, 2).map(player => player.id), ["A002", "A001"]);
  const view = spectatorPlayerView(card, division, "A001")!;
  assert.equal(view.completedRecord?.placing, 2, "qualifying leader finished second in the bracket");
  assert.equal(view.completedRecord?.statsScope, "qualifying");
  const html = playerMarkup(card);
  assert.match(html, /อันดับสุดท้าย/);
  assert.match(html, />#2</);
  assert.match(html, /สถิติรอบคัดเลือก/);
  assert.doesNotMatch(html, />#1</);
});

test("W8: a completed non-finalist receives the authoritative final order without finals claims", () => {
  const card = completedBracketCard();
  const view = viewOf(card, "A003");
  assert.equal(view.final, null);
  assert.equal(view.completedRecord?.placing, 3);
  assert.equal(view.completedRecord?.statsScope, "qualifying");
  const html = playerMarkup(card, "A003");
  assert.match(html, />#3</);
  assert.match(html, /สถิติรอบคัดเลือก/);
  assert.doesNotMatch(html, /ชิงอันดับ|ชนะคู่ชิง|แพ้คู่ชิง/);
});

test("W8: withdrawn players and active tournaments never receive a completed hero", () => {
  const active = w1PlayerFixture();
  assert.equal(viewOf(active).completedRecord, null);
  assert.doesNotMatch(playerMarkup(active), /data-completed-record="true"/);

  const withdrawn = completedQualifyingCard();
  withdrawn.players[0].terminated = true;
  assert.equal(viewOf(withdrawn).completedRecord, null);
  assert.doesNotMatch(playerMarkup(withdrawn), /data-completed-record="true"/);
  assert.match(playerMarkup(withdrawn), /ถอนตัว/);
});

test("W8: bye and void are resolved without fabricating record figures", () => {
  const bye = completedQualifyingCard();
  Object.assign(bye.snapshots[1].pairings[1], {
    playerTwoId: null, resultType: "WIN", winnerId: "A001", scoreOne: 150, scoreTwo: 0, calculatedDiff: 150,
  });
  assert.ok(viewOf(bye).completedRecord);
  assert.match(playerMarkup(bye), /บาย/);

  const voided = completedQualifyingCard();
  Object.assign(voided.snapshots[1].pairings[1], { voided: true });
  assert.ok(viewOf(voided).completedRecord);
  assert.match(playerMarkup(voided), /ยกเลิกคู่แข่งขัน/);
});

test("W8: capture presentation reuses the same authoritative figures", () => {
  const card = completedBracketCard();
  const view = viewOf(card);
  const normal = renderToStaticMarkup(React.createElement(CompletedPlayerHero, { eventName: card.name, view }));
  const capture = renderToStaticMarkup(React.createElement(SpectatorMemoryCard, {
    tournamentName: "การแข่งขันครอสเวิร์ดชิงแชมป์ประเทศไทย",
    competitionName: card.name,
    view,
  }));
  for (const fact of [card.name, view.participant.name, "สถิติรอบคัดเลือก", `${view.completedRecord!.diff}`]) {
    assert.ok(normal.includes(fact), `normal summary contains ${fact}`);
    assert.ok(capture.includes(fact), `capture summary contains ${fact}`);
  }
  assert.match(normal, />#2</);
  assert.match(capture, /aria-label="อันดับสุดท้าย 2"/);
  assert.match(capture, /spectator-memory__placing/);
  assert.match(capture, /คะแนนเฉลี่ย/);
  assert.match(capture, /อัตราชนะ/);
  assert.match(capture, /ชนะ · เสมอ · แพ้/);
  assert.match(capture, /ผลต่างสะสม/);
  assert.ok(capture.indexOf(card.name) < capture.indexOf("การแข่งขันครอสเวิร์ดชิงแชมป์ประเทศไทย"),
    "competition identity leads the supporting tournament name");
});

test("Memory Moment statistics come from official ranking figures, including a submitted zero", () => {
  const card = completedQualifyingCard();
  Object.assign(card.snapshots[1].pairings[1], {
    resultType: "WIN", winnerId: "A004", scoreOne: 0, scoreTwo: 350, calculatedDiff: 350,
  });
  const record = viewOf(card).completedRecord;
  assert.ok(record);
  assert.equal(record.gamesPlayed, 3);
  assert.equal(record.averageScore, 244, "420 + 312 + submitted 0, divided by all three counted games");
  assert.equal(record.wins, 1);
  assert.equal(record.draws, 0);
  assert.equal(record.losses, 2);
  assert.equal(record.winRate, 1 / 3 * 100, "wins divided by the authoritative W/T/L outcomes");
  assert.equal(record.diff, -368, "the ranking's capped differentials remain authoritative");
});

test("Memory Moment formats boundary win rates, signed differential, and long Thai identity", () => {
  const card = completedQualifyingCard();
  card.name = "การแข่งขันครอสเวิร์ดเกมและเอแม็ทชิงแชมป์เยาวชนแห่งประเทศไทย";
  card.division = "มัธยมศึกษาตอนต้น ประเภททีมชาย รุ่นอายุไม่เกิน 15 ปี";
  const view = viewOf(card);
  assert.ok(view.completedRecord);

  const render = (winRate: number, diff: number) => {
    Object.assign(view.completedRecord!, { winRate, diff, wins: 12, draws: 10, losses: 11, averageScore: 987.5 });
    return renderToStaticMarkup(React.createElement(SpectatorMemoryCard, {
      tournamentName: "มหกรรมการแข่งขันกีฬาทางปัญญานานาชาติ ประจำปีการศึกษา 2569 รอบชิงชนะเลิศแห่งประเทศไทย",
      competitionName: card.name,
      view,
    }));
  };

  const zero = render(0, -1234);
  assert.match(zero, />0<small>%<\/small>/);
  assert.match(zero, /class="is-negative">-1234</);
  assert.match(zero, /ประภัสสรานุวัฒน์ ศรีสุวรรณวัฒนกิจจา/);
  assert.match(zero, /โรงเรียนสาธิตมหาวิทยาลัยศรีนครินทรวิโรฒ ประสานมิตร/);

  assert.match(render(66.7, 0), />66\.7<small>%<\/small>/);
  const full = render(100, 1234);
  assert.match(full, />100<small>%<\/small>/);
  assert.match(full, /class="is-positive">\+1234</);
});

/**
 * W8 invariant 5: none of the active lifecycle shapes may receive the keepsake, and each must keep
 * the answer W1 gives it. One `complete` flag is not what earns the completed hero.
 */
test("W8: every active lifecycle shape keeps its W1 answer and no completed hero", () => {
  // published current pairing + provisional game 2 already visible
  const actionable = w1PlayerFixture();
  // recorded current game, next pairing not published yet
  const recorded = w1PlayerFixture();
  recorded.currentGame = 2;
  recorded.snapshots[1].gameNumbers = [2];
  recorded.snapshots[1].pairings = [recorded.snapshots[1].pairings[0]];
  // current game has no published assignment for this player
  const awaiting = w1PlayerFixture();
  awaiting.snapshots[1].pairings = [awaiting.snapshots[1].pairings[0]];
  awaiting.snapshots[1].gameNumbers = [2];
  awaiting.currentGame = 3;
  // finals under way
  const finalsActive = w1PlayerFixture();
  finalsActive.runtimeStage = "FINAL_COLLECTION";
  finalsActive.finalType = "CHAMPION";
  finalsActive.finalGames = 1;
  finalsActive.finalRound = { slots: [{ slot: 0, playerOneId: "A001", playerTwoId: "A003",
    games: [], winnerId: null, winnerWins: null, winnerLosses: null, totalDiff: null }] };

  for (const [label, card] of Object.entries({ actionable, recorded, awaiting, finalsActive })) {
    const view = viewOf(card);
    assert.equal(view.completedRecord, null, `${label} must not earn a completed record`);
    assert.doesNotMatch(playerMarkup(card), /data-completed-record="true"/, `${label} renders no hero`);
  }
  assert.ok(viewOf(actionable).assignment, "the published current pairing still directs the player");
  assert.ok(viewOf(recorded).recordedCurrentGame, "the recorded current game still explains the wait");
  assert.equal(viewOf(awaiting).awaitingGame, 3, "the unpublished next game is still named");
  assert.equal(viewOf(finalsActive).phase, "finals");
});
