import assert from "node:assert/strict";
import test from "node:test";
import { selectShellCards, shellCardsSignature } from "./store";
import type { BackOfficeCardSummary, TournamentCard } from "@/domain/tournament/types";

/**
 * P3-E: the shell subscribes to a SIGNATURE of what it renders, not to `cards`.
 *
 * Zustand compares with `Object.is`, and `applyResultPatch` necessarily builds a new `cards` array,
 * so subscribing to `cards` re-rendered the whole shell once per SSE result event — measured. These
 * tests pin the property that makes the signature safe: it must ignore a result save and react to a
 * stage change. Get that backwards and either the shell re-renders constantly, or the sidebar's
 * workflow nudge silently stops following the tournament.
 */

function card(over: Partial<TournamentCard> = {}): TournamentCard {
  return {
    id: "c1", tournamentId: "t1", name: "Card", division: "A",
    status: "ACTIVE", runtimeStage: "RESULT_COLLECTION", currentGame: 2, version: 11,
    createdAt: "2026-01-01T00:00:00Z",
    games: [], players: [], rules: [], tables: [], snapshots: [], audit: [],
    ...over,
  } as unknown as TournamentCard;
}

const noSummaries: BackOfficeCardSummary[] = [];

test("a result save does NOT change the signature — version and scores are invisible to the shell", () => {
  const before = shellCardsSignature([card({ version: 11 })], noSummaries);
  const after = shellCardsSignature([card({ version: 12 })], noSummaries);

  assert.equal(before, after,
    "the shell shows no version, so bumping it must not re-render the sidebar mid-scoring");
});

test("a stage change DOES change the signature — the sidebar nudge depends on it", () => {
  const before = shellCardsSignature([card({ runtimeStage: "RESULT_COLLECTION" })], noSummaries);
  const after = shellCardsSignature([card({ runtimeStage: "RESULT_REVIEW" })], noSummaries);

  assert.notEqual(before, after);
});

test("renaming a card changes the signature", () => {
  assert.notEqual(
    shellCardsSignature([card({ name: "Card" })], noSummaries),
    shellCardsSignature([card({ name: "Renamed" })], noSummaries));
  assert.notEqual(
    shellCardsSignature([card({ division: "A" })], noSummaries),
    shellCardsSignature([card({ division: "B" })], noSummaries));
});

test("adding or removing a card changes the signature", () => {
  const one = shellCardsSignature([card()], noSummaries);
  const two = shellCardsSignature([card(), card({ id: "c2", createdAt: "2026-02-01T00:00:00Z" })], noSummaries);

  assert.notEqual(one, two);
  assert.equal(shellCardsSignature([], noSummaries), "", "an empty list has an empty signature");
});

test("selectShellCards exposes only the five fields the shell reads", () => {
  const [row] = selectShellCards([card()], noSummaries);

  assert.deepEqual(Object.keys(row).sort(),
    ["division", "id", "name", "runtimeStage", "tournamentId"],
    "anything more would re-couple the shell to data it does not render");
});
