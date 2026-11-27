import assert from "node:assert/strict";
import test from "node:test";

import type { FinalSlot } from "@/domain/tournament/types";
import {
  editField, FINAL_MAX_SCORE, FINAL_MIN_SCORE, parseFinalScore, finalSlotDraftKey, gameDraftDirty, rebaseField, reconcileGameDrafts, reconcileSummaryDraft,
  savedText, summaryDraftDirty, type GameDrafts,
} from "./final-draft";

const slot = (games: [number | null, number | null][], summary: Partial<FinalSlot> = {}): FinalSlot => ({
  slot: 0, playerOneId: "A017", playerTwoId: "A010",
  games: games.map(([scoreOne, scoreTwo], index) => ({ gameIndex: index + 1, scoreOne, scoreTwo, winnerId: null, diff: null })),
  winnerId: null, winnerWins: null, winnerLosses: null, totalDiff: null, ...summary,
});
const values = (drafts: GameDrafts) => Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, [d.one.value, d.two.value]]));
const type = (drafts: GameDrafts, game: number, one: string, two: string, server: FinalSlot): GameDrafts => ({
  ...drafts,
  [game]: {
    one: editField(drafts[game]?.one, one, savedText(server.games[game - 1].scoreOne)),
    two: editField(drafts[game]?.two, two, savedText(server.games[game - 1].scoreTwo)),
  },
});

test("the first sync shows saved scores, blank where nothing is saved", () => {
  const drafts = reconcileGameDrafts({}, slot([[480, 405], [null, null]]).games);
  assert.deepEqual(values(drafts), { 1: ["480", "405"], 2: ["", ""] });
  assert.equal(gameDraftDirty(drafts, slot([[480, 405], [null, null]]).games), false);
});

test("game A's save response does not erase game B typed while A was in flight", () => {
  const empty = slot([[null, null], [null, null]]);
  let drafts = reconcileGameDrafts({}, empty.games);
  drafts = type(drafts, 1, "483", "404", empty);   // typed and sent
  drafts = type(drafts, 2, "475", "403", empty);   // typed while A pending
  const afterA = slot([[483, 404], [null, null]]);
  drafts = reconcileGameDrafts(drafts, afterA.games);
  assert.deepEqual(values(drafts), { 1: ["483", "404"], 2: ["475", "403"] });
  assert.equal(gameDraftDirty(drafts, afterA.games), true, "B is still unsaved and must keep the leave-page warning");
  const afterB = slot([[483, 404], [475, 403]]);
  drafts = reconcileGameDrafts(drafts, afterB.games);
  assert.equal(gameDraftDirty(drafts, afterB.games), false);
});

test("a row retyped while its own save is in flight keeps the newer value and stays unsaved", () => {
  const empty = slot([[null, null], [null, null]]);
  let drafts = type(reconcileGameDrafts({}, empty.games), 1, "413", "414", empty);
  drafts = type(drafts, 1, "415", "416", empty);
  const sent = slot([[413, 414], [null, null]]);
  drafts = reconcileGameDrafts(drafts, sent.games);
  assert.deepEqual(values(drafts)[1], ["415", "416"]);
  assert.equal(gameDraftDirty(drafts, sent.games), true);
});

test("a retype back to the sent value adopts the saved state cleanly", () => {
  const empty = slot([[null, null]]);
  let drafts = type(reconcileGameDrafts({}, empty.games), 1, "413", "414", empty);
  const sent = slot([[413, 414]]);
  drafts = reconcileGameDrafts(drafts, sent.games);
  assert.equal(gameDraftDirty(drafts, sent.games), false);
  assert.deepEqual(drafts[1].one, { value: "413", base: "413" });
});

test("another operator's save updates untouched fields but never a field this operator typed", () => {
  const start = slot([[480, 405], [null, null]]);
  let drafts = reconcileGameDrafts({}, start.games);
  drafts = { ...drafts, 2: { one: editField(drafts[2].one, "470", ""), two: drafts[2].two } };
  const remote = slot([[490, 400], [460, 455]]);
  drafts = reconcileGameDrafts(drafts, remote.games);
  assert.deepEqual(values(drafts), { 1: ["490", "400"], 2: ["470", "455"] });
  assert.equal(gameDraftDirty(drafts, remote.games), true);
});

test("a failed save leaves the typed value as an unsaved draft", () => {
  const start = slot([[480, 405]]);
  let drafts = type(reconcileGameDrafts({}, start.games), 1, "481", "405", start);
  drafts = reconcileGameDrafts(drafts, start.games); // failure: the card does not change, a refresh re-delivers it
  assert.deepEqual(values(drafts)[1], ["481", "405"]);
  assert.equal(gameDraftDirty(drafts, start.games), true);
});

test("clearing a field back to its base hands it back to the server", () => {
  assert.deepEqual(rebaseField({ value: "", base: "" }, "400"), { value: "400", base: "400" });
  assert.deepEqual(rebaseField(undefined, ""), { value: "", base: "" });
  assert.deepEqual(rebaseField({ value: "7", base: "" }, "400"), { value: "7", base: "400" });
});

test("editing keeps the base the draft was typed against", () => {
  assert.deepEqual(editField(undefined, "5", "3"), { value: "5", base: "3" });
  assert.deepEqual(editField({ value: "4", base: "1" }, "5", "3"), { value: "5", base: "1" });
});

test("a typed summary survives game saves and another operator's summary save", () => {
  const start = slot([[480, 405]]);
  let summary = reconcileSummaryDraft(undefined, start);
  assert.equal(summaryDraftDirty(summary, start), false);
  summary = { ...summary, winnerId: editField(summary.winnerId, "A010", ""), wins: editField(summary.wins, "2", ""),
    losses: editField(summary.losses, "1", ""), diff: editField(summary.diff, "37", "") };
  const gameSaved = slot([[480, 405], [null, null]]);
  summary = reconcileSummaryDraft(summary, gameSaved);
  assert.deepEqual([summary.winnerId.value, summary.wins.value, summary.losses.value, summary.diff.value], ["A010", "2", "1", "37"]);
  const remote = slot([[480, 405]], { winnerId: "A017", winnerWins: 2, winnerLosses: 0, totalDiff: 75 });
  summary = reconcileSummaryDraft(summary, remote);
  assert.deepEqual([summary.winnerId.value, summary.wins.value, summary.losses.value, summary.diff.value], ["A010", "2", "1", "37"]);
  assert.equal(summaryDraftDirty(summary, remote), true);
});

test("an untouched summary follows the saved winner", () => {
  const saved = slot([[480, 405]], { winnerId: "A017", winnerWins: 2, winnerLosses: 0, totalDiff: 75 });
  const summary = reconcileSummaryDraft(reconcileSummaryDraft(undefined, slot([[480, 405]])), saved);
  assert.deepEqual([summary.winnerId.value, summary.wins.value, summary.losses.value, summary.diff.value], ["A017", "2", "0", "75"]);
  assert.equal(summaryDraftDirty(summary, saved), false);
  for (const field of ["winnerId", "wins", "losses", "diff"] as const) {
    const changed = { ...summary, [field]: { ...summary[field], value: "9" } };
    assert.equal(summaryDraftDirty(changed, saved), true, field);
  }
});

test("dirty ignores games that have no draft yet", () => {
  assert.equal(gameDraftDirty({}, slot([[1, 2]]).games), false);
});

test("drafts are keyed by card, slot and both finalists", () => {
  const base = slot([[null, null]]);
  const key = finalSlotDraftKey("card-1", base);
  assert.equal(key, "card-1:0:A017:A010");
  assert.notEqual(finalSlotDraftKey("card-2", base), key);
  assert.notEqual(finalSlotDraftKey("card-1", { ...base, playerTwoId: "A044" }), key);
  assert.notEqual(finalSlotDraftKey("card-1", { ...base, playerOneId: "A044" }), key);
  assert.notEqual(finalSlotDraftKey("card-1", { ...base, slot: 1 }), key);
  assert.notEqual(finalSlotDraftKey("card-1", { ...base, pairingId: "old-pairing" }),
    finalSlotDraftKey("card-1", { ...base, pairingId: "new-pairing" }));
});

test("savedText renders absent values as blank", () => {
  assert.equal(savedText(null), "");
  assert.equal(savedText(undefined), "");
  assert.equal(savedText(0), "0");
  assert.equal(savedText("A010"), "A010");
});

test("final scores follow the real-match bounds, negatives included", () => {
  assert.equal(parseFinalScore("-43"), -43);
  assert.equal(parseFinalScore(" 452 "), 452);
  assert.equal(parseFinalScore("0"), 0);
  assert.equal(parseFinalScore(String(FINAL_MIN_SCORE)), FINAL_MIN_SCORE);
  assert.equal(parseFinalScore(String(FINAL_MAX_SCORE)), FINAL_MAX_SCORE);
  for (const bad of ["", " ", "-", "1.5", "1e3", "abc", "--1", String(FINAL_MIN_SCORE - 1), String(FINAL_MAX_SCORE + 1)]) {
    assert.equal(parseFinalScore(bad), null, JSON.stringify(bad));
  }
});
