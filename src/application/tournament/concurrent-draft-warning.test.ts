import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore } from "./store";
import { formatActor, formatScore, hasTypedDraft, selectConflicts } from "@/ui/components/result-entry-grid";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";

/**
 * P4 concurrent-draft warning.
 *
 * The chain under test: staff SSE `result` event -> `noteRemoteResultChange` (which captures the
 * PREVIOUS scores, which is why `use-card-sync.ts` calls it before `applyResultPatch`) ->
 * `selectConflicts` deciding whether this user must be interrupted -> the dialog's copy.
 *
 * Deliberately NOT tested here: that the store ends up holding A's result. That is
 * `applyResultPatch`/resync, covered by sse-gap-recovery and sse-gap-resync, and the warning must
 * never become a second reconciliation path.
 */

const CARD = "card-1";
const X = "g1t1";
const Y = "g1t2";

function pairing(id: string, over: Partial<Pairing> = {}): Pairing {
  return {
    id, gameNumber: 1, tableNumber: Number(id.slice(3)),
    playerOneId: "P001", playerTwoId: "P002", pairingPublished: true, ...over,
  } as unknown as Pairing;
}

function seed(pairings: Pairing[] = [pairing(X), pairing(Y)], username = "b-user") {
  useTournamentStore.setState({
    remoteResult: null,
    auth: { authenticated: true, username, roles: ["ROLE_STAFF"], csrfToken: "x" },
    cards: [{
      id: CARD, tournamentId: "t1", name: "C", division: "D",
      status: "ACTIVE", runtimeStage: "RESULT_COLLECTION", currentGame: 1, version: 10,
      createdAt: "2026-01-01T00:00:00Z",
      games: [], players: [], rules: [], tables: [], audit: [],
      snapshots: [{ id: "s1", gameNumbers: [1], confirmedAt: "", pairings }],
    }] as unknown as TournamentCard[],
  });
}

const note = (changed: Pairing[], actor = "director-a", roles = ["ROLE_DIRECTOR"]) =>
  useTournamentStore.getState().noteRemoteResultChange(CARD, 11, changed, actor, roles);
const notice = () => useTournamentStore.getState().remoteResult!;

// ---------------------------------------------------------------- D: actor propagation

test("D: the actor and role reach the store from the event", () => {
  seed();
  note([pairing(X, { scoreOne: 500, scoreTwo: 433 })]);

  assert.equal(notice().actor, "director-a");
  assert.deepEqual(notice().actorRoles, ["ROLE_DIRECTOR"]);
  assert.equal(notice().changes[0].pairingId, X);
});

test("D: the previous result is captured before the patch replaces it", () => {
  seed([pairing(X, { scoreOne: 300, scoreTwo: 250 }), pairing(Y)]);
  note([pairing(X, { scoreOne: 500, scoreTwo: 433 })]);

  assert.deepEqual(notice().changes[0].before, { scoreOne: 300, scoreTwo: 250 });
  assert.deepEqual(notice().changes[0].after, { scoreOne: 500, scoreTwo: 433 });
});

test("D: a pairing with no previous result reports before = null, not 0:0", () => {
  seed();
  note([pairing(X, { scoreOne: 500, scoreTwo: 433 })]);

  assert.equal(notice().changes[0].before, null);
  assert.equal(formatScore(notice().changes[0].before), "ยังไม่มีผล");
});

test("the user's OWN save raises no notice — that is not a concurrent edit", () => {
  seed(undefined, "b-user");
  note([pairing(X, { scoreOne: 1, scoreTwo: 2 })], "b-user", ["ROLE_STAFF"]);

  assert.equal(useTournamentStore.getState().remoteResult, null);
});

test("each event advances seq so a consumer can tell a new one from a re-render", () => {
  seed();
  note([pairing(X, { scoreOne: 1, scoreTwo: 2 })]);
  const first = notice().seq;
  note([pairing(Y, { scoreOne: 3, scoreTwo: 4 })]);

  assert.equal(notice().seq, first + 1);
});

// ---------------------------------------------------------------- A / B: who gets interrupted

test("A: editing pairing X and A updates X -> warning, with the right pairing and scores", () => {
  seed([pairing(X, { scoreOne: 300, scoreTwo: 250 }), pairing(Y)]);
  note([pairing(X, { scoreOne: 500, scoreTwo: 433 })]);

  const found = selectConflicts(notice(), new Set([X]), {});

  assert.equal(found.length, 1);
  assert.equal(found[0].change.pairingId, X);
  assert.equal(found[0].change.tableNumber, 1);
  assert.equal(formatActor(found[0].actor, found[0].actorRoles), "director-a - DIRECTOR");
  assert.equal(formatScore(found[0].change.before), "300 : 250");
  assert.equal(formatScore(found[0].change.after), "500 : 433");
});

test("B: editing pairing X and A updates Y -> no warning", () => {
  seed();
  note([pairing(Y, { scoreOne: 500, scoreTwo: 433 })]);

  assert.deepEqual(selectConflicts(notice(), new Set([X]), {}), [],
    "an unrelated pairing must sync silently, exactly as before");
});

test("not editing anything -> no warning, however many pairings changed", () => {
  seed();
  note([pairing(X, { scoreOne: 1, scoreTwo: 2 }), pairing(Y, { scoreOne: 3, scoreTwo: 4 })]);

  assert.deepEqual(selectConflicts(notice(), new Set(), {}), []);
});

test("a typed draft on an unsaved row counts as editing", () => {
  seed();
  note([pairing(X, { scoreOne: 500, scoreTwo: 433 })]);

  assert.equal(selectConflicts(notice(), new Set(), { [X]: { one: "12", two: "" } }).length, 1);
  assert.equal(selectConflicts(notice(), new Set(), { [X]: { one: "", two: "" } }).length, 0,
    "an empty draft is not an edit in progress");
  assert.equal(hasTypedDraft({ one: " ", two: "" }), false);
});

test("a pairing already queued is not queued twice — one dialog per decision", () => {
  seed();
  note([pairing(X, { scoreOne: 500, scoreTwo: 433 })]);
  const first = selectConflicts(notice(), new Set([X]), {});

  note([pairing(X, { scoreOne: 501, scoreTwo: 400 })]);
  assert.deepEqual(selectConflicts(notice(), new Set([X]), {}, first), []);
});

test("one event touching two edited pairings queues both", () => {
  seed();
  note([pairing(X, { scoreOne: 1, scoreTwo: 2 }), pairing(Y, { scoreOne: 3, scoreTwo: 4 })]);

  assert.deepEqual(selectConflicts(notice(), new Set([X, Y]), {}).map((c) => c.change.pairingId), [X, Y]);
});

// ---------------------------------------------------------------- dialog copy

test("the actor line degrades safely when a pre-P4 backend sent no identity", () => {
  assert.equal(formatActor(null, []), "ผู้ใช้อื่น");
  assert.equal(formatActor("someone", []), "someone");
  assert.equal(formatActor("someone", ["ROLE_ADMIN", "ROLE_STAFF"]), "someone - ADMIN / STAFF");
});
