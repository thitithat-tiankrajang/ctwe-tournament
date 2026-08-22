import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore } from "./store";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";

/**
 * P4 SSE proof gate, fix A — the staff path must not trust a gapped `result` event.
 *
 * `SseDropReachabilityTest` (backend) proves the loss is reachable: `CardEventPublisher` writes from
 * one bounded thread and can drop a queued send while the stream stays open — no error, no
 * completion, no EventSource reconnect — and the server never reads `Last-Event-ID`, so nothing
 * replays the hole. Before fix A the staff path merged the surviving delta and adopted its version,
 * silently losing every result in between.
 *
 * The guard lives in `applyResultPatch` rather than in `use-card-sync.ts` because that is the only
 * place holding BOTH the version we believe we have (`card.version`) and the version that arrived —
 * and because every caller already treats a `false` return as "pull the whole card". That existing
 * contract is why the fix leaves both frozen sync hooks byte-identical.
 *
 * `false` here therefore means exactly one thing to every caller: **resync**.
 */

const CARD = "card-1";

function pairing(id: string, over: Partial<Pairing> = {}): Pairing {
  return {
    id, tableNumber: Number(id.slice(1)), gameNumber: 1,
    playerOne: "A", playerTwo: "B", scoreOne: null, scoreTwo: null,
    winner: null, published: false, pairingPublished: false, ...over,
  } as unknown as Pairing;
}

function seed(version: number) {
  useTournamentStore.setState({
    cards: [{
      id: CARD, tournamentId: "t1", name: "C", division: "D",
      status: "ACTIVE", runtimeStage: "RESULT_COLLECTION", currentGame: 1, version,
      createdAt: "2026-01-01T00:00:00Z",
      games: [], players: [], rules: [], tables: [], audit: [],
      snapshots: [{ id: "s1", gameNumbers: [1], confirmedAt: "", pairings: [pairing("t1"), pairing("t2")] }],
    }] as unknown as TournamentCard[],
  });
}

const apply = (version: number, changed: Pairing[]) =>
  useTournamentStore.getState().applyResultPatch(CARD, version, changed);
const card = () => useTournamentStore.getState().cards.find((item) => item.id === CARD)!;
const row = (id: string) => card().snapshots[0].pairings.find((item) => item.id === id)!;

test("a dropped event leaves a version gap, which is detected and reported as unpatched", () => {
  seed(10);

  // Versions 11 and 12 were persisted, then discarded by a stalled writer. 13 arrives.
  const patched = apply(13, [pairing("t2", { scoreOne: 300, scoreTwo: 250, winner: "A" } as Partial<Pairing>)]);

  assert.equal(patched, false,
    "false is the resync signal: use-card-sync.ts:84 and submitResult both call syncCard on it");
  assert.equal(card().version, 10,
    "the card must NOT adopt a version whose intermediate deltas it never received");
  assert.equal(row("t2").scoreOne, null,
    "and must not merge a delta it cannot place — the full refetch is the source of truth");
});

test("the local state is left untouched by a gapped event, so nothing is half-applied", () => {
  seed(10);
  const before = card();

  apply(15, [pairing("t1", { scoreOne: 999, scoreTwo: 1, winner: "A" } as Partial<Pairing>)]);

  assert.equal(card(), before,
    "same object reference — a rejected patch must not re-render the grid either");
});

test("the contiguous event still patches in place — the fix must not cost the fast path", () => {
  seed(10);

  const patched = apply(11, [pairing("t1", { scoreOne: 500, scoreTwo: 433, winner: "A" } as Partial<Pairing>)]);

  assert.equal(patched, true, "no refetch: the delta landed exactly on the version we held");
  assert.equal(card().version, 11);
  assert.equal(row("t1").scoreOne, 500);
});

test("a run of consecutive events applies without a single refetch", () => {
  seed(10);

  for (let i = 1; i <= 4; i++) {
    const patched = apply(10 + i, [pairing("t1", { scoreOne: 400 + i, scoreTwo: 100, winner: "A" } as Partial<Pairing>)]);
    assert.equal(patched, true, `event ${10 + i} should patch in place`);
  }

  assert.equal(card().version, 14);
  assert.equal(row("t1").scoreOne, 404, "the last delta wins");
});

test("the writer's own echo is still a no-op, not a gap — no refetch storm on save", () => {
  seed(12);

  const patched = apply(11, [pairing("t1", { scoreOne: 999, scoreTwo: 1, winner: "A" } as Partial<Pairing>)]);

  assert.equal(patched, true, "already at/after this version: handled, so no resync is triggered");
  assert.equal(card().version, 12, "version never goes backwards");
  assert.equal(row("t1").scoreOne, null, "and the stale payload is not applied");
});

test("re-delivery of the exact current version is a no-op too", () => {
  seed(12);

  const patched = apply(12, [pairing("t1", { scoreOne: 777, scoreTwo: 1, winner: "A" } as Partial<Pairing>)]);

  assert.equal(patched, true);
  assert.equal(card().version, 12);
  assert.equal(row("t1").scoreOne, null);
});

test("an unknown card is reported unpatched rather than silently ignored", () => {
  seed(10);

  assert.equal(useTournamentStore.getState().applyResultPatch("nope", 11, []), false,
    "a result for a card we do not hold must not report success");
});
