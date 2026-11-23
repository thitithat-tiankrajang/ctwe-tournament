import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { w1PlayerFixture } from "@/application/tournament/fixtures/spectator-player-fixtures";
import { legacyPublicCard } from "@/application/tournament/spectator-read-model";
import type { TournamentCard } from "@/domain/tournament/types";
import { CardOverviewView } from "@/ui/components/card-overview-view";
import { SpectatorFinals } from "@/ui/components/spectator-finals";

Object.assign(globalThis, { React });

function finalsCard(state: "not-started" | "active" | "partial" | "entered" | "published" = "published", championshipOnly = false): TournamentCard {
  const card = legacyPublicCard(w1PlayerFixture());
  card.finalType = championshipOnly ? "CHAMPION" : "CHAMPION_AND_THIRD";
  card.finalGames = 3;
  card.runtimeStage = state === "published" ? "FINAL_PUBLISHED" : "FINAL_COLLECTION";
  card.status = state === "published" ? "FINISHED" : "RUNNING";
  if (state === "not-started") {
    card.runtimeStage = "FINAL_SEEDING";
    card.finalRound = null;
    return card;
  }
  const third = {
    slot: 1,
    playerOneId: "A003",
    playerTwoId: "A004",
    games: [{ gameIndex: 1, scoreOne: 355, scoreTwo: 401, winnerId: "A004", diff: 46 }],
    winnerId: state === "entered" || state === "published" ? "A004" : null,
    winnerWins: state === "entered" || state === "published" ? 1 : null,
    winnerLosses: state === "entered" || state === "published" ? 0 : null,
    totalDiff: state === "entered" || state === "published" ? 46 : null,
  };
  card.finalRound = { slots: [{
    slot: 0,
    playerOneId: "A001",
    playerTwoId: "A002",
    games: [
      { gameIndex: 1, scoreOne: state === "active" ? null : 410, scoreTwo: state === "active" ? null : 388, winnerId: state === "active" ? null : "A001", diff: state === "active" ? null : 22 },
      { gameIndex: 2, scoreOne: state === "active" ? null : 377, scoreTwo: state === "active" ? null : 402, winnerId: state === "active" ? null : "A002", diff: state === "active" ? null : 25 },
      { gameIndex: 3, scoreOne: state === "entered" || state === "published" ? 420 : null, scoreTwo: state === "entered" || state === "published" ? 399 : null, winnerId: state === "entered" || state === "published" ? "A001" : null, diff: state === "entered" || state === "published" ? 21 : null },
    ],
    winnerId: state === "entered" || state === "published" ? "A001" : null,
    winnerWins: state === "entered" || state === "published" ? 2 : null,
    winnerLosses: state === "entered" || state === "published" ? 1 : null,
    totalDiff: state === "entered" || state === "published" ? 18 : null,
  }, ...(championshipOnly ? [] : [third])] };
  return card;
}

const renderFinals = (card: TournamentCard) => renderToStaticMarkup(React.createElement(SpectatorFinals, {
  card,
  onOpenPlayer: () => {},
}));

test("configured Finals can be inspected before the bracket starts", () => {
  const card = finalsCard("not-started");
  const markup = renderFinals(card);
  assert.match(markup, /รอบชิงชนะเลิศ/);
  assert.match(markup, /ยังไม่เริ่มรอบชิง/);
  assert.doesNotMatch(markup, /final-slot-table|final-summary-form/);

  const overview = renderToStaticMarkup(React.createElement(CardOverviewView, {
    cardId: card.id, card, spectator: true, onSpectatorPlayer: () => {},
    initialSpectatorContext: { game: "final", views: [], filter: { mode: "player", playerIds: [], schools: [], query: "" }, scrollY: 0 },
  }));
  assert.match(overview, /spectator-finals__empty/);
});

test("active and partial Finals report games without claiming an official winner", () => {
  const active = renderFinals(finalsCard("active"));
  assert.match(active, /กำลังแข่งขัน/);
  assert.match(active, /A001/);
  assert.match(active, /A002/);
  assert.match(active, /ยังไม่มีผลการแข่งขัน/);
  assert.doesNotMatch(active, /ผู้ชนะอย่างเป็นทางการ/);

  const partial = renderFinals(finalsCard("partial"));
  assert.match(partial, /เกม 1/);
  assert.match(partial, />410</);
  assert.match(partial, />388</);
  assert.match(partial, /1 เกมชนะ/);
  assert.match(partial, /spectator-final-series/);
  assert.ok(partial.indexOf("spectator-final-series") < partial.indexOf("spectator-final-games"), "series score must lead the game evidence");
  assert.doesNotMatch(partial, /ผู้ชนะอย่างเป็นทางการ/);
});

test("entered result stays provisional until Finals publication", () => {
  const entered = renderFinals(finalsCard("entered"));
  assert.match(entered, /บันทึกผลแล้ว · รอประกาศ/);
  assert.match(entered, /บันทึกเป็นผู้ชนะ/);
  assert.doesNotMatch(entered, /ผู้ชนะอย่างเป็นทางการ/);

  const published = renderFinals(finalsCard("published"));
  assert.match(published, /ผลการแข่งขันอย่างเป็นทางการ/);
  assert.match(published, /ผู้ชนะอย่างเป็นทางการ/);
  assert.match(published, /ผลต่าง \+18/);
});

test("championship is primary and third-place is optional", () => {
  const both = renderFinals(finalsCard("published"));
  assert.match(both, /คู่ชิงอันดับ 1 - 2/);
  assert.match(both, /คู่ชิงอันดับ 3 - 4/);
  assert.match(both, /spectator-final-championship/);
  assert.match(both, /spectator-final-third/);

  const championshipOnly = renderFinals(finalsCard("published", true));
  assert.match(championshipOnly, /คู่ชิงอันดับ 1 - 2/);
  assert.doesNotMatch(championshipOnly, /คู่ชิงอันดับ 3 - 4/);
});

test("Finals owns the Viewer content width without paint escaping its gutter", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const finalsCss = css.slice(css.indexOf("/* ---- Finals"), css.indexOf("/* ---- Report tables"));
  assert.match(finalsCss, /\.spectator-finals\s*\{[\s\S]*?width:\s*100%/);
  assert.doesNotMatch(finalsCss, /box-shadow:\s*var\(--sp-shadow\)/);
  assert.doesNotMatch(finalsCss, /100vw|margin-(?:left|right):\s*-/);
});

test("real finalists use canonical player identity targets", () => {
  const markup = renderFinals(finalsCard("published", true));
  assert.equal((markup.match(/<button type="button" class="spectator-final-player(?: spectator-final-player--winner)?"/g) ?? []).length, 2);
  assert.match(markup, /ประภัสสรานุวัฒน์ ศรีสุวรรณวัฒนกิจจา/);
  assert.match(markup, /โรงเรียนสาธิตมหาวิทยาลัยศรีนครินทรวิโรฒ/);
});

test("public and read-only back-office overviews both use the final composition, never the entry board", () => {
  const card = finalsCard("published");
  const context = { game: "final" as const, views: [], filter: { mode: "player" as const, playerIds: [], schools: [], query: "" }, scrollY: 0 };
  const publicMarkup = renderToStaticMarkup(React.createElement(CardOverviewView, {
    cardId: card.id, card, spectator: true, initialSpectatorContext: context, onSpectatorPlayer: () => {},
  }));
  assert.match(publicMarkup, /spectator-finals/);
  assert.doesNotMatch(publicMarkup, /final-slot-table|final-summary-form/);

  const staffMarkup = renderToStaticMarkup(React.createElement(CardOverviewView, {
    cardId: card.id, card, initialSpectatorContext: null,
  }));
  // The accepted design shows admin's read-only overview with the same final panel as the viewer.
  assert.match(staffMarkup, /fin__matches/);
  assert.doesNotMatch(staffMarkup, /final-summary-form/);
});
