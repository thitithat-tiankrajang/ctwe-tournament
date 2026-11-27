import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Pairing, PublicTournamentBundle, TournamentCard } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { useTournamentStore } from "./store";
import { isSpectatorRoute, spectatorCardFromHash } from "./spectator-route";
import { legacyPublicCard, publicDivisionPayload, spectatorDivision, spectatorPairingStats } from "./spectator-read-model";
import { applyPublicDelta, createSpectatorState } from "./spectator-state";

const goldens = JSON.parse(readFileSync("backend/src/test/resources/golden/public-card-projection.json", "utf8")) as Record<string, TournamentCard>;
const fixture = () => structuredClone(goldens["01-running-table-pairing-all-snapshots-confirmed"]);
const bundle = (card = fixture()): PublicTournamentBundle => ({ id: card.tournamentId, name: "Public tournament",
  accessToken: "public-link", cardCount: 1, publishedCardCount: 1, cards: [card] });
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

for (const role of [null, "ROLE_DIRECTOR", "ROLE_STAFF", "ROLE_ADMIN"]) test(`public read is isolated with ${role ?? "anonymous"} operational state`, async () => {
  const original = useTournamentStore.getState();
  const activeTournament = { id: "private-tournament", name: "Operator workspace" };
  useTournamentStore.setState({ activeTournament, auth: { authenticated: role !== null, username: role,
    roles: role ? [role] : [], csrfToken: "private" } });
  const requests: { url: string; credentials: RequestCredentials | undefined }[] = [];
  try {
    const store = createSpectatorState("public-link", { snapshot: async () => null,
      fetch: async (url, options) => { requests.push({ url: String(url), credentials: options?.credentials }); return response(bundle()); } });
    await store.load();
    assert.deepEqual(requests, [{ url: "/api/public/tournaments/public-link/bundle", credentials: "omit" }]);
    assert.equal(store.getSnapshot().tournament?.name, "Public tournament");
    assert.equal(store.getSnapshot().source, "live");
    assert.equal(useTournamentStore.getState().activeTournament, activeTournament);
    assert.equal(useTournamentStore.getState().auth.csrfToken, "private");
    assert.equal(useTournamentStore.getState().cards, original.cards);
  } finally { useTournamentStore.setState(original); }
});

test("both public entry routes and the legacy card fragment resolve without changing operational route classification", () => {
  for (const path of ["/tour/event", "/t/abc123", "/tour/event/"]) assert.equal(isSpectatorRoute(path), true);
  for (const path of ["/", "/cards/abc", "/admin", "/director", "/tour/", "/t/", "/tour/event/unknown"]) assert.equal(isSpectatorRoute(path), false);
  assert.equal(spectatorCardFromHash(`#card=${fixture().id}`), fixture().id);
  assert.equal(spectatorCardFromHash("#card=invalid"), null);
});

test("archive source needs no live origin and uses the same normalized model", async () => {
  const expected = bundle();
  const store = createSpectatorState("legacy-token", { snapshot: async () => expected,
    fetch: async () => { throw new Error("API origin must not be contacted"); } });
  await store.load();
  await store.syncCard(expected.cards[0].id, 900);
  assert.equal(store.getSnapshot().source, "archive");
  assert.deepEqual(store.getSnapshot().divisions[0], spectatorDivision(expected.cards[0]));
});

test("legacy payloads lose operational-only fields at the read seam", () => {
  const source = fixture();
  source.audit = [{ secret: "private" }] as unknown as TournamentCard["audit"];
  const payload = publicDivisionPayload(source);
  assert.equal("audit" in payload, false);
  assert.equal("rules" in payload, false);
  assert.equal("tables" in payload, false);
  assert.equal("screeningPool" in payload, false);
  assert.deepEqual(legacyPublicCard(payload).audit, []);
});

test("seats preserve sparse slots, either vacant side, byes, voids and repaired participants", () => {
  const card = fixture();
  const row = (slot: number, one: string | null, two: string | null): Pairing => ({ id: `g3t${slot}`,
    gameNumber: 3, tableNumber: slot, playerOneId: one, playerTwoId: two, pairingPublished: true });
  card.snapshots = [{ id: "preview-3", gameNumbers: [3], confirmedAt: "", pairings: [
    row(14, "P001", "P002"), row(2, "P001", null), row(20, null, "P002"),
    { ...row(9, null, null), voided: true }, row(23, "P002", "P001"),
  ] }];
  const view = spectatorDivision(card);
  assert.deepEqual(view.contests.map(contest => contest.assignments.map(assignment => assignment.seat)), [[27, 28], [3, 4], [39, 40], [17, 18], [45, 46]]);
  assert.equal(view.contests[2].assignments[0].participantKey, null);
  assert.equal(view.contests[3].state, "void");
  assert.equal(view.contests[4].assignments[0].participantKey, `${card.id}:P002`);
  assert.ok(view.contests.every(contest => !('table' in contest)));
});

test("publication separates recorded and official results, suppresses penalty placeholder scores", () => {
  const card = fixture();
  const official = spectatorDivision(card);
  assert.deepEqual(official.standings, rankingAfterGame(card, official.publication.officialThroughGame!));
  card.snapshots = [{ id: "pending", gameNumbers: [3], confirmedAt: "", pairings: [{
    id: "g3t1", tableNumber: 1, gameNumber: 3, playerOneId: "P001", playerTwoId: "P002",
    pairingPublished: true, scoreOne: 0, scoreTwo: 0, resultType: "PENALTY", calculatedDiff: 50,
  }] }];
  const provisional = spectatorDivision(card);
  assert.equal(provisional.contests[0].state, "recorded");
  assert.equal(provisional.contests[0].result?.scores, null);
  assert.equal(provisional.publication.officialThroughGame, null);
  assert.deepEqual(provisional.standings, []);
  card.snapshots[0].pairings[0].resultWithdrawn = true;
  assert.equal(spectatorDivision(card).contests[0].state, "withdrawn");
  assert.equal(spectatorDivision(card).contests[0].result, null);
});

test("pairing stats count prior wins and meetings in game order, preserving streaks through byes", () => {
  const card = fixture();
  const [a, b, c] = card.players.map(player => player.id);
  const row = (game: number, one: string, two: string | null, type: Pairing["resultType"], winner?: string): Pairing => ({
    id: `g${game}t1`, gameNumber: game, tableNumber: 1, playerOneId: one, playerTwoId: two,
    scoreOne: 450, scoreTwo: 450, resultType: type, winnerId: winner,
  });
  card.snapshots = [{ id: "official", gameNumbers: [1, 2, 3, 4, 5, 6, 7], confirmedAt: "2026-09-16T04:00:00Z", pairings: [
    row(7, a, b, "WIN", b), row(4, b, a, "DRAW"), row(1, a, b, "WIN", a), row(2, c, a, "WIN", a),
    row(3, a, null, "WIN", a), row(5, a, b, "WIN", a), row(6, a, c, "PENALTY"),
  ] }];
  const division = spectatorDivision(card);
  const stats = (game: number) => spectatorPairingStats(division, game);
  assert.equal(stats(1).winStreak(a), 0);
  assert.equal(stats(1).encounterNumber(a, b), null);
  assert.equal(stats(2).winStreak(a), 1);
  assert.equal(stats(4).winStreak(a), 2);
  assert.equal(stats(4).encounterNumber(b, a), 2);
  assert.equal(stats(4).encounterNumber(b, c), null);
  assert.equal(stats(4).encounterNumber(a, null), null);
  assert.equal(stats(5).winStreak(a), 0);
  assert.equal(stats(5).encounterNumber(a, b), 3);
  assert.equal(stats(6).winStreak(a), 1);
  assert.equal(stats(7).winStreak(a), 0);
  assert.equal(stats(7).encounterNumber(a, c), 2);
  assert.deepEqual([stats(8).winStreak(a), stats(8).winStreak(b)], [0, 1]);
});

test("pairing stats ignore provisional, withdrawn and void contests and count duplicate public IDs once", () => {
  const card = fixture();
  const [a, b] = card.players.map(player => player.id);
  const result: Pairing = { id: "g1t1", gameNumber: 1, tableNumber: 1, playerOneId: a, playerTwoId: b,
    resultType: "WIN", scoreOne: 500, scoreTwo: 400, winnerId: a, pairingPublished: true };
  const official = { id: "official", gameNumbers: [1, 2, 3], confirmedAt: "2026-09-16T04:00:00Z", pairings: [
    result, { ...result, id: "g2t1", gameNumber: 2, resultWithdrawn: true },
    { ...result, id: "g3t1", gameNumber: 3, voided: true },
  ] };
  card.snapshots = [official, { ...official, id: "duplicate", pairings: [result] },
    { id: "preview", gameNumbers: [4], confirmedAt: "", pairings: [{ ...result, id: "g4t1", gameNumber: 4, winnerId: b }] }];
  const stats = spectatorPairingStats(spectatorDivision(card), 5);
  assert.equal(stats.winStreak(a), 1);
  assert.equal(stats.winStreak(b), 0);
  assert.equal(stats.winStreak(undefined), 0);
  assert.equal(stats.encounterNumber(a, b), 2);
});

test("finals expose no inferred seat or table, and unexposed pairings stay absent", () => {
  for (const card of Object.values(goldens)) {
    const model = spectatorDivision(card);
    if (model.finals) assert.ok(model.finals.slots.every(slot => !("seat" in slot) && !("table" in slot)));
  }
  const card = fixture();
  card.snapshots.forEach(snapshot => { snapshot.confirmedAt = ""; snapshot.pairings.forEach(pairing => { pairing.pairingPublished = false; }); });
  assert.deepEqual(spectatorDivision(card).contests, []);
});

test("delta version gaps require a read, duplicates are ignored, and input is not mutated", () => {
  const card = publicDivisionPayload(fixture());
  const delta = { type: "pairings" as const, cardId: card.id, version: card.version + 1, gameNumber: 3, pairings: [] };
  assert.equal(applyPublicDelta(card, { ...delta, version: card.version + 2 }), null);
  assert.equal(applyPublicDelta(card, { ...delta, version: card.version }), card);
  const before = structuredClone(card);
  assert.equal(applyPublicDelta(card, delta)?.version, delta.version);
  assert.deepEqual(card, before);
});

test("bundle loading deduplicates and newer catalog reads retain full rosters", async () => {
  let calls = 0;
  const card = fixture();
  const store = createSpectatorState("public-link", { snapshot: async () => null,
    fetch: async url => { calls++; return response(String(url).includes('/bundle') ? bundle(card) : { ...card, version: card.version + 1 }); } });
  await Promise.all([store.load(), store.load()]);
  assert.equal(calls, 1);
  const refreshing = store.syncCard(card.id, card.version + 1);
  assert.equal(store.getSnapshot().divisions[0].participants.length, card.players.length);
  await refreshing;
  assert.equal(store.getSnapshot().cards[0].version, card.version + 1);
  await store.load();
  assert.equal(store.getSnapshot().cards[0].version, card.version + 1, "older bundle must not roll back a newer division");
});

test("removal during a public read cannot resurrect the division", async () => {
  const card = fixture();
  let resolve!: (value: Response) => void;
  const store = createSpectatorState("public-link", { snapshot: async () => null,
    fetch: async url => String(url).includes('/bundle') ? response(bundle(card)) : new Promise<Response>(done => { resolve = done; }) });
  await store.load();
  const pending = store.syncCard(card.id, card.version + 1);
  store.removeCard(card.id);
  resolve(response({ ...card, version: card.version + 1 }));
  await pending;
  assert.deepEqual(store.getSnapshot().cards, []);
});

test("public read failure preserves last-known data and exposes delayed freshness", async () => {
  let fail = false;
  const store = createSpectatorState("public-link", { snapshot: async () => null,
    fetch: async () => { if (fail) throw new Error("offline"); return response(bundle()); } });
  await store.load();
  fail = true;
  await assert.rejects(store.load(), /offline/);
  assert.equal(store.getSnapshot().freshness, "delayed");
  assert.equal(store.getSnapshot().cards.length, 1);
});

test("partial block publication requires an authoritative read rather than confirming future results", () => {
  const card = publicDivisionPayload(fixture());
  card.snapshots = [{ id: "pending", gameNumbers: [1, 2], pairings: [], confirmedAt: "" }];
  assert.equal(applyPublicDelta(card, { type: "publish", cardId: card.id, version: card.version + 1,
    gameNumbers: [1], snapshotId: "s1", confirmedAt: "2026-09-09T00:00:00Z", currentGame: 1, runtimeStage: "RESULT_COLLECTION" }), null);
});

test("a public 404 removes the unavailable division without exposing operational fallback", async () => {
  const card = fixture();
  const requests: string[] = [];
  const store = createSpectatorState("public-link", { snapshot: async () => null, fetch: async url => {
    requests.push(String(url));
    return String(url).includes('/bundle') ? response(bundle(card)) : new Response(null, { status: 404 });
  } });
  await store.load();
  await store.syncCard(card.id, card.version + 1);
  assert.deepEqual(store.getSnapshot().cards, []);
  assert.ok(requests.every(url => url.startsWith('/api/public/')));
});
