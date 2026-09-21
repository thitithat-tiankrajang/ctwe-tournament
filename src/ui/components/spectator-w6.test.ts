import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spectatorDivision } from "@/application/tournament/spectator-read-model";
import { w1PlayerFixture } from "@/application/tournament/fixtures/spectator-player-fixtures";
import { SpectatorFind } from "@/ui/components/spectator-find";
import { SpectatorPairList, SpectatorStandingList } from "@/ui/components/spectator-report-lists";

Object.assign(globalThis, { React });

const fixture = w1PlayerFixture();
const players = new Map(fixture.players.map((player) => [player.id, player]));
const pairing = fixture.snapshots[1].pairings[0];

test("public reports use the Thai-first numeric vocabulary and compact identity grouping", () => {
  const result = renderToStaticMarkup(React.createElement(SpectatorPairList, {
    pairings: [pairing],
    players,
    mode: "result",
    slotLabel: "PAIR",
    emptyText: "ไม่มีผล",
  }));
  assert.match(result, />คะแนน</);
  assert.doesNotMatch(result, />แต้ม</);
  assert.match(result, /spectator-line__primary/);
  assert.match(result, /spectator-line__school/);

  const standing = renderToStaticMarkup(React.createElement(SpectatorStandingList, {
    rows: [{ rank: 1, id: "A001", name: "ผู้เล่นหนึ่ง", school: "โรงเรียนหนึ่ง", figures: { winPoints: 2, diff: 30, scoreFor: 500, average: "500.0" } }],
    emptyText: "ไม่มีผู้เล่น",
  }));
  assert.match(standing, />คะแนนสะสม</);
  assert.doesNotMatch(standing, /แต้มสะสม/);
  assert.match(standing, /ผลต่างสะสม/);
});

test("result rows use player-perspective differential signs without inventing a bye score", () => {
  const bye = {
    ...pairing,
    id: "w6-bye",
    playerOneId: null,
    playerTwoId: "A001",
    scoreOne: 0,
    scoreTwo: 102,
    winnerId: "A001",
  };
  const markup = renderToStaticMarkup(React.createElement(SpectatorPairList, {
    pairings: [pairing, bye],
    players,
    mode: "result",
    slotLabel: "PAIR",
    emptyText: "ไม่มีผล",
  }));
  assert.match(markup, />\+138</);
  assert.match(markup, />-138</);
  assert.match(markup, />—<\/span> บาย/);
  assert.match(markup, /<td class="spectator-cell--num spectator-cell--score">—<\/td>/);
});

test("event-wide search confirms people rather than generic records", () => {
  const division = spectatorDivision(fixture);
  const markup = renderToStaticMarkup(React.createElement(SpectatorFind, {
    divisions: [division],
    criteria: { query: "A001", divisionId: null, school: null },
    onCriteriaChange: () => {},
    onOpenPlayer: () => {},
    onSubmit: () => {},
    browse: null,
  }));
  assert.match(markup, /พบ 1 คน/);
  assert.doesNotMatch(markup, /พบ 1 รายการ/);
});

test("public Thai identity text uses normal line breaking instead of anywhere", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const publicCss = css.slice(css.indexOf("/* ---- Player identity"));
  assert.doesNotMatch(publicCss, /overflow-wrap:\s*anywhere/);
  assert.match(publicCss, /overflow-wrap:\s*break-word/);
  assert.match(publicCss, /word-break:\s*normal/);
});
