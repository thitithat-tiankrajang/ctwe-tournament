import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlayerHistoryRow } from "@/domain/tournament/history";
import { CardOverviewView } from "@/ui/components/card-overview-view";
import { SpectatorParticipation } from "@/ui/components/spectator-participation";
import { SpectatorPairList, SpectatorStandingList, SpectatorHistoryRows } from "@/ui/components/spectator-report-lists";
import { legacyPublicCard, spectatorDivision, type PublicDivisionPayload } from "./spectator-read-model";
import { spectatorHash, parseSpectatorHash, spectatorReportContextFromHistory, type SpectatorReportContext } from "./spectator-route";
import { w1PlayerFixture, W1_DIVISION } from "./fixtures/spectator-player-fixtures";

Object.assign(globalThis, { React });

const fixture = (): PublicDivisionPayload => w1PlayerFixture();
const playersOf = (card: PublicDivisionPayload) => new Map(card.players.map((player) => [player.id, player]));

test("standing identity is a single deliberate canonical Player action", () => {
  const markup = renderToStaticMarkup(React.createElement(SpectatorStandingList, {
    rows: [{ rank: 1, id: "A001", name: "สมชาย ใจดี", school: "โรงเรียนสวนกุหลาบ" }],
    onRowClick: () => {}, emptyText: "ไม่มีผู้เล่น",
  }));
  assert.equal((markup.match(/class="spectator-who"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /ประวัติการแข่งขัน|history-table-dialog/);
});

for (const mode of ["pairing", "result"] as const) {
  test(`${mode} participant identities are targets while pair/seat/score remain information`, () => {
    const card = fixture();
    const pairing = card.snapshots[1].pairings[1];
    const markup = renderToStaticMarkup(React.createElement(SpectatorPairList, {
      pairings: [pairing], players: playersOf(card), mode, slotLabel: "PAIR", onOpenPlayer: () => {}, emptyText: "ไม่มีผล",
    }));
    assert.equal((markup.match(/class="spectator-(?:side|athlete)-link/g) ?? []).length, 2);
    assert.match(markup, /class="spectator-cell--pair"[^>]*>3</);
    assert.doesNotMatch(markup, /spectator-cell--pair[^<]*<button/);
    if (mode === "result") assert.match(markup, /spectator-cell--score/);
  });
}

test("player current game and ledger opponents use the same canonical Player target", () => {
  const card = fixture();
  const division = spectatorDivision(card);
  const markup = renderToStaticMarkup(React.createElement(SpectatorParticipation, {
    card, division, code: "A001", onBack: () => {}, onBrowseDivision: () => {}, onOpenPlayer: () => {},
  }));
  assert.match(markup, /class="spectator-versus__link"/);
  assert.match(markup, /class="spectator-history__opponent spectator-history__opponent-link"/);
  assert.match(markup, /A004/);
});

test("BYE and missing opponents never become false Player links", () => {
  const card = fixture();
  card.currentGame = 2;
  card.snapshots[1].pairings = [{ id: "bye", gameNumber: 2, tableNumber: 2, playerOneId: "A001", playerTwoId: null, pairingPublished: true }];
  const markup = renderToStaticMarkup(React.createElement(SpectatorParticipation, {
    card, division: spectatorDivision(card), code: "A001", onBack: () => {}, onBrowseDivision: () => {}, onOpenPlayer: () => {},
  }));
  assert.match(markup, /บาย — ไม่มีคู่แข่งขันในเกมนี้/);
  assert.doesNotMatch(markup, /spectator-versus__link/);
});

test("history rows link real opponents but keep BYE as plain status", () => {
  const rows: PlayerHistoryRow[] = [
    { key: "q-1", game: 1, table: 1, result: "W", cumulativeWinPoints: 2, ownScore: 420, opponentScore: 300, diff: 120, cumulativeDiff: 120, opponentId: "A002" },
    { key: "q-2", game: 2, table: 2, result: "T", cumulativeWinPoints: 3, ownScore: 0, opponentScore: 0, diff: 0, cumulativeDiff: 120, opponentId: "" },
  ];
  const markup = renderToStaticMarkup(React.createElement(SpectatorHistoryRows, {
    rows, opponentName: (code: string) => code === "A002" ? "สมชาย ใจดี" : code, opponentSchool: () => "โรงเรียนสวนกุหลาบ", onOpenPlayer: () => {},
  }));
  assert.equal((markup.match(/spectator-history__opponent-link/g) ?? []).length, 1);
  assert.match(markup, />บาย</);
});

test("public CardOverview has no competing spectator history dialog", () => {
  const card = fixture();
  const markup = renderToStaticMarkup(React.createElement(CardOverviewView, {
    cardId: card.id, card: legacyPublicCard(card), spectator: true, onSpectatorPlayer: () => {},
    initialSpectatorContext: { game: 3, views: ["ranking"], filter: { mode: "player", playerIds: [], schools: [], query: "" }, scrollY: 0 },
  }));
  assert.doesNotMatch(markup, /history-table-dialog/);
  assert.match(markup, /spectator-player-identity-link|spectator-who/);
});

test("report context is validated and preserves game, lens, filters and scroll", () => {
  const context: SpectatorReportContext = {
    game: 3,
    views: ["result"],
    filter: { mode: "player", playerIds: ["A004"], schools: [], query: "A004" },
    scrollY: 812,
  };
  const restored = spectatorReportContextFromHistory({ spectatorReport: context });
  assert.deepEqual(restored, context);
  assert.equal(spectatorReportContextFromHistory({ spectatorReport: { ...context, cardId: W1_DIVISION } })?.cardId, W1_DIVISION);
  assert.equal(spectatorReportContextFromHistory({ spectatorReport: { ...context, scrollY: -1 } })?.scrollY, 0);
  assert.equal(spectatorReportContextFromHistory({ spectatorReport: { ...context, filter: { ...context.filter, mode: "bad" } } }), null);
});

test("canonical Player identity survives ranking changes because the route uses division and code", () => {
  const before = spectatorHash({ kind: "player", divisionId: W1_DIVISION, code: "A004" });
  const after = spectatorHash({ kind: "player", divisionId: W1_DIVISION, code: "A004" });
  assert.equal(before, after);
  assert.deepEqual(parseSpectatorHash(before), { kind: "player", divisionId: W1_DIVISION, code: "A004" });
});
