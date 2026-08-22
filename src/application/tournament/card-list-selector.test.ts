import assert from "node:assert/strict";
import test from "node:test";
import { selectCardList, selectTournamentCardList } from "./store";
import type { BackOfficeCardSummary, TournamentCard } from "@/domain/tournament/types";

/**
 * `selectCardList` merges the two sources P3-A introduced without conflating them.
 *
 * The container stays `TournamentCard[]` (`04_BLOCKERS.md` B1 — turning it into a Record would force
 * rewriting the four frozen SSE patch functions), so the merge happens in a selector rather than in
 * the store shape.
 */

function summary(id: string, over: Partial<BackOfficeCardSummary> = {}): BackOfficeCardSummary {
  return {
    id,
    tournamentId: "t1",
    name: `card-${id}`,
    division: "d",
    status: "ACTIVE",
    runtimeStage: "PLAYER_REGISTRATION",
    currentGame: 1,
    gameCount: 4,
    playerCount: 400,
    publishedGameCount: 0,
    version: 7,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  } as BackOfficeCardSummary;
}

function card(id: string, over: Partial<TournamentCard> = {}): TournamentCard {
  return {
    id,
    tournamentId: "t1",
    name: `card-${id}`,
    division: "d",
    status: "ACTIVE",
    runtimeStage: "RESULT_COLLECTION",
    currentGame: 2,
    version: 11,
    createdAt: "2026-01-01T00:00:00Z",
    games: [],
    players: [],
    rules: [],
    tables: [],
    snapshots: [],
    audit: [],
    ...over,
  } as unknown as TournamentCard;
}

test("a full card wins over a summary for the same id — it is the SSE-patched copy", () => {
  const rows = selectCardList([card("a")], [summary("a")]);

  assert.equal(rows.length, 1, "one row per card, never two");
  assert.equal(rows[0].full, true);
  assert.equal(rows[0].version, 11, "staff version from the live card, not the summary's 7");
  assert.equal(rows[0].runtimeStage, "RESULT_COLLECTION", "the card's real stage");
});

test("summaries fill in cards this client has never opened", () => {
  const rows = selectCardList([card("a")], [summary("a"), summary("b"), summary("c")]);

  assert.deepEqual(rows.map((row) => row.id).sort(), ["a", "b", "c"]);
  assert.equal(rows.find((row) => row.id === "b")?.full, false);
});

test("a summaryOnly card does not displace a real summary", () => {
  // publicSummaryCard() stamps summaryOnly:true on viewer-derived cards. Those carry PUBLIC values
  // — playerCount 0 during registration, public_version — so a back-office summary must win.
  const viewerCard = card("a", { summaryOnly: true, version: 7, playerCount: 0 } as Partial<TournamentCard>);
  const rows = selectCardList([viewerCard], [summary("a", { playerCount: 400, version: 11 })]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].playerCount, 400, "staff truth, not the public projection's 0");
  assert.equal(rows[0].version, 11);
  assert.equal(rows[0].full, false);
});

test("rows are newest first", () => {
  const rows = selectCardList([], [
    summary("old", { createdAt: "2026-01-01T00:00:00Z" }),
    summary("new", { createdAt: "2026-03-01T00:00:00Z" }),
    summary("mid", { createdAt: "2026-02-01T00:00:00Z" }),
  ]);

  assert.deepEqual(rows.map((row) => row.id), ["new", "mid", "old"]);
});

test("the tournament filter keeps a director inside their own tournament", () => {
  const rows = selectTournamentCardList([], [
    summary("a", { tournamentId: "t1" }),
    summary("b", { tournamentId: "t2" }),
  ], "t1");

  assert.deepEqual(rows.map((row) => row.id), ["a"]);
  assert.deepEqual(selectTournamentCardList([], [summary("a")], undefined).map((row) => row.id), ["a"],
    "no tournament selected means no filter, not an empty list");
});

test("empty sources produce an empty list, not a crash", () => {
  assert.deepEqual(selectCardList([], []), []);
});
