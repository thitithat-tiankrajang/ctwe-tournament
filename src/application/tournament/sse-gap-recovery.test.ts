import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore } from "./store";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";

/**
 * P4 SSE PROOF GATE — what happens to the STAFF path when a `result` event is lost?
 *
 * `SseDropReachabilityTest` (backend) proves the loss is reachable: `CardEventPublisher` writes from
 * one bounded thread under `DiscardOldestPolicy`, so a single stalled socket makes the queue overflow
 * and events are discarded **while the stream stays open** — no error, no completion, no EventSource
 * reconnect. The server also never reads `Last-Event-ID`, so there is no replay.
 *
 * That leaves the client as the only line of defence, and the two clients do not agree:
 *
 * - **Viewer** (`use-public-sync.ts` `applyDelta`) — "apply exactly `known + 1`, resync on any gap".
 * - **Staff** (`use-card-sync.ts` `result` handler) — applies whatever version arrives and refetches
 *   only when `applyResultPatch` returns false.
 *
 * These are CHARACTERIZATION tests. They pin what the code does today, and today's staff behaviour
 * is a defect, not a design: they are written so that fixing it makes the intent obvious rather than
 * making a green test look like approval. Do not "fix" the tests to keep them passing — fix the
 * client and rewrite the expectations.
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

const card = () => useTournamentStore.getState().cards.find((item) => item.id === CARD)!;
const row = (id: string) => card().snapshots[0].pairings.find((item) => item.id === id)!;

/** The viewer's guard, quoted from `use-public-sync.ts` so the asymmetry is pinned, not described. */
const viewerWouldResync = (known: number, incoming: number) => incoming !== known + 1;

test("KNOWN DEFECT: a gapped result patch is applied instead of triggering a resync", () => {
  seed(10);

  // Versions 11 and 12 were persisted and then discarded by the stalled writer. 13 arrives.
  const patched = useTournamentStore.getState().applyResultPatch(CARD, 13, [
    pairing("t2", { scoreOne: 300, scoreTwo: 250, winner: "A" } as Partial<Pairing>),
  ]);

  assert.equal(patched, true,
    "applyResultPatch reports success, so use-card-sync.ts:84 does NOT call syncCard()");
  assert.equal(card().version, 13,
    "the card jumps 10 -> 13, adopting a version whose intermediate deltas it never received");
  assert.equal(row("t1").scoreOne, null,
    "table 1's persisted v11 result is absent from the client and nothing will ever fetch it");
  assert.equal(row("t2").scoreOne, 300, "only the surviving v13 delta was applied");
});

test("the viewer path WOULD have resynced on the same sequence — the guard exists in this repo", () => {
  assert.equal(viewerWouldResync(10, 13), true,
    "known + 1 = 11, incoming = 13: use-public-sync.ts syncs the whole card instead of patching");
  assert.equal(viewerWouldResync(10, 11), false, "the contiguous case still patches in place");
});

test("a contiguous result patch applies cleanly — the defect is the gap, not the patching", () => {
  seed(10);

  const patched = useTournamentStore.getState().applyResultPatch(CARD, 11, [
    pairing("t1", { scoreOne: 500, scoreTwo: 433, winner: "A" } as Partial<Pairing>),
  ]);

  assert.equal(patched, true);
  assert.equal(card().version, 11);
  assert.equal(row("t1").scoreOne, 500, "the delta that was actually delivered is applied");
});

test("an already-seen version is a no-op — the writer's own echo must not double-apply", () => {
  seed(12);

  const patched = useTournamentStore.getState().applyResultPatch(CARD, 11, [
    pairing("t1", { scoreOne: 999, scoreTwo: 1, winner: "A" } as Partial<Pairing>),
  ]);

  assert.equal(patched, true, "reported handled, so no refetch storm on the writer's own echo");
  assert.equal(card().version, 12, "version never goes backwards");
  assert.equal(row("t1").scoreOne, null, "and the stale payload is not applied");
});
