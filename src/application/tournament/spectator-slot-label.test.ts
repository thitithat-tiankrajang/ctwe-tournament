import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlotLabel } from "@/domain/tournament/types";
import { SpectatorParticipation } from "@/ui/components/spectator-participation";
import { SpectatorPairList } from "@/ui/components/spectator-report-lists";
import { legacyPublicCard, publicDivisionPayload, spectatorDivision, type PublicDivisionPayload } from "./spectator-read-model";
import { spectatorPlayerView } from "./spectator-player";
import { w1PlayerFixture } from "./fixtures/spectator-player-fixtures";

Object.assign(globalThis, { React });

const cardWithSlot = (slotLabel?: SlotLabel): PublicDivisionPayload => {
  const card = w1PlayerFixture();
  if (slotLabel) card.slotLabel = slotLabel;
  else delete card.slotLabel;
  return card;
};

const playerMarkup = (card: PublicDivisionPayload) => {
  const division = spectatorDivision(card);
  return renderToStaticMarkup(React.createElement(SpectatorParticipation, {
    card, division, code: "A001", onBack: () => {}, onBrowseDivision: () => {},
  }));
};

const reportMarkup = (card: PublicDivisionPayload, mode: "pairing" | "result") => {
  const payload = publicDivisionPayload(card);
  const publicCard = legacyPublicCard(payload);
  const division = spectatorDivision(payload);
  const pairings = publicCard.snapshots.flatMap(snapshot => snapshot.pairings).filter(pairing => pairing.gameNumber === 3);
  return renderToStaticMarkup(React.createElement(SpectatorPairList, {
    pairings, players: new Map(publicCard.players.map(player => [player.id, player])), mode,
    slotLabel: division.slotLabel, emptyText: "ไม่มีผล",
  }));
};

function locationHeading(markup: string, label: string): boolean {
  return new RegExp(`spectator-seat__label[^>]*>${label}<`).test(markup);
}

for (const slotLabel of ["SEAT", "PAIR"] as const) {
  test(`${slotLabel} configuration survives the public adapter and agrees across report and Player`, () => {
    const card = cardWithSlot(slotLabel);
    const division = spectatorDivision(publicDivisionPayload(card));
    const view = spectatorPlayerView(publicDivisionPayload(card), division, "A001")!;
    const player = playerMarkup(card);
    const pairingReport = reportMarkup(card, "pairing");
    const resultReport = reportMarkup(card, "result");
    const label = slotLabel === "SEAT" ? "ที่นั่ง" : "คู่ที่";
    const other = slotLabel === "SEAT" ? "คู่ที่ 3" : "ที่นั่ง 5";

    assert.equal(card.slotLabel, slotLabel);
    assert.equal(legacyPublicCard(publicDivisionPayload(card)).slotLabel, slotLabel);
    assert.equal(division.slotLabel, slotLabel);
    assert.equal(view.slotLabel, slotLabel);
    assert.ok(locationHeading(player, label), "Player must emphasize the configured cue");
    assert.match(player, new RegExp(`data-slot-label="${slotLabel}"`));
    assert.match(player, new RegExp(`>${other}<`), "Player keeps the other location fact available");
    assert.match(pairingReport, new RegExp(`<th[^>]*>${label}</th>`));
    assert.match(resultReport, new RegExp(`<th[^>]*>${label}</th>`));
    if (slotLabel === "SEAT") {
      assert.doesNotMatch(pairingReport, /<th[^>]*>คู่ที่<\/th>/);
      assert.doesNotMatch(resultReport, /<th[^>]*>คู่ที่<\/th>/);
    } else {
      assert.doesNotMatch(pairingReport, /<th[^>]*>ที่นั่ง<\/th>/);
      assert.doesNotMatch(resultReport, /<th[^>]*>ที่นั่ง<\/th>/);
    }
  });
}

test("a legacy payload without slotLabel keeps the PAIR compatibility fallback", () => {
  const card = cardWithSlot();
  const payload = publicDivisionPayload(card);
  assert.equal(payload.slotLabel, undefined);
  const division = spectatorDivision(payload);
  const view = spectatorPlayerView(payload, division, "A001")!;
  assert.equal(division.slotLabel, "PAIR");
  assert.equal(view.slotLabel, "PAIR");
  assert.match(reportMarkup(payload, "pairing"), /<th[^>]*>คู่ที่<\/th>/);
  assert.ok(locationHeading(playerMarkup(payload), "คู่ที่"));
});

test("W1 provisional game remains visible while the configured location cue applies only to game N+1", () => {
  const card = cardWithSlot("SEAT");
  const view = spectatorPlayerView(card, spectatorDivision(card), "A001")!;
  const player = playerMarkup(card);
  assert.equal(view.assignment?.game, 3);
  assert.deepEqual(view.ledger.map(game => [game.game, game.state]), [[1, "official"], [2, "recorded"], [3, "awaiting-result"]]);
  assert.match(player, /data-slot-label="SEAT"/);
  assert.match(player, /เกม 2[\s\S]*312 - 450/);
  assert.match(player, /บันทึกผลแล้ว · ยังไม่รวมอันดับ/);
  assert.match(player, /spectator-seat__label">ที่นั่ง<\/span><strong[^>]*>5<\/strong>/);
});

test("a bye does not invent a location or opponent from the slot-label mode", () => {
  const card = cardWithSlot("PAIR");
  card.currentGame = 2;
  card.snapshots[1].pairings = [{ id: "w1-bye-slot", gameNumber: 2, tableNumber: 2,
    playerOneId: "A001", playerTwoId: null, pairingPublished: true }];
  const player = playerMarkup(card);
  assert.match(player, /บาย — ไม่มีคู่แข่งขันในเกมนี้/);
  assert.doesNotMatch(player, /spectator-seat|พบกับ|ยังไม่ระบุคู่แข่ง/);
});

test("finals do not derive regular Seat or Pair from the configured cue", () => {
  const card = cardWithSlot("SEAT");
  card.runtimeStage = "FINAL_COLLECTION";
  card.finalType = "CHAMPION";
  card.finalRound = { slots: [{ slot: 0, playerOneId: "A001", playerTwoId: "A003", games: [], winnerId: null,
    winnerWins: null, winnerLosses: null, totalDiff: null }] };
  const player = playerMarkup(card);
  assert.match(player, /ชิงอันดับ 1 - 2/);
  assert.doesNotMatch(player, /spectator-seat|data-slot-label|ที่นั่ง[^\n]*\d|คู่ที่[^\n]*\d|โต๊ะ/);
});
