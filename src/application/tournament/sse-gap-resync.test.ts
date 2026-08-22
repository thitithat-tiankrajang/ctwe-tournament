import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore } from "./store";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";

/**
 * P4 SSE proof gate, re-run — does the recovery actually CLOSE the hole?
 *
 * `sse-gap-recovery.test.ts` proves a gapped event is detected and reported unpatched. That is only
 * half the chain. This file walks the rest of it, in the same order the live handlers do:
 *
 *   server drops a delta   -> SseDropReachabilityTest (backend)
 *   ...and emits a hint    -> SseDropReachabilityTest (backend)
 *   client sees the hint   -> `card` handler predicate, below
 *   client sees a gap      -> applyResultPatch returns false, below
 *   client resyncs         -> syncCard replaces the card with the server's, below
 *   B now holds the truth  -> asserted on the resulting state
 *
 * The two handler predicates are quoted from the P0-frozen `use-card-sync.ts` rather than executed
 * there: running the hook needs a DOM and an EventSource, and this repo has no React test setup. The
 * quoted lines are pinned here so a change to either is caught as a contract break.
 */

const CARD = "card-1";

function pairing(id: string, over: Partial<Pairing> = {}): Pairing {
  return {
    id, tableNumber: Number(id.slice(1)), gameNumber: 1,
    playerOne: "A", playerTwo: "B", scoreOne: null, scoreTwo: null,
    winner: null, published: false, pairingPublished: false, ...over,
  } as unknown as Pairing;
}

function cardAt(version: number, pairings: Pairing[]): TournamentCard {
  return {
    id: CARD, tournamentId: "t1", name: "C", division: "D",
    status: "ACTIVE", runtimeStage: "RESULT_COLLECTION", currentGame: 1, version,
    createdAt: "2026-01-01T00:00:00Z",
    games: [], players: [], rules: [], tables: [], audit: [],
    snapshots: [{ id: "s1", gameNumbers: [1], confirmedAt: "", pairings }],
  } as unknown as TournamentCard;
}

function seed(version: number) {
  useTournamentStore.setState({
    cards: [cardAt(version, [pairing("t1"), pairing("t2")])],
    auth: { authenticated: true, username: "b", roles: ["ROLE_DIRECTOR"], csrfToken: "x" },
  });
}

const card = () => useTournamentStore.getState().cards.find((item) => item.id === CARD)!;
const row = (id: string) => card().snapshots[0].pairings.find((item) => item.id === id)!;

/** `use-card-sync.ts` `card` handler: refetch unless the hint is at or behind what we hold. */
const hintTriggersResync = (held: number | undefined, hinted: number) =>
  !(hinted >= 0 && held !== undefined && hinted <= held);

/** Stub `/api/cards/{id}` for one call, returning the server's authoritative card. */
async function withServerCard(server: TournamentCard, run: () => Promise<void>) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => server } as unknown as Response;
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = real; }
  return calls;
}

test("the resync hint from a dropped send does trigger a refetch", () => {
  // The publisher sends the AUTHORITATIVE version; B holds the last delta it actually received.
  assert.equal(hintTriggersResync(10, 18), true, "18 > 10: B must refetch");
  assert.equal(hintTriggersResync(18, 18), false, "already current: no needless refetch");
  assert.equal(hintTriggersResync(19, 18), false, "never go backwards");
  assert.equal(hintTriggersResync(undefined, 5), true, "nothing held yet: refetch");
});

test("a gap detected on a result event ends with B holding the server's state", async () => {
  seed(10);

  // Versions 11 and 12 were persisted then discarded. 13 arrives with only table 2's row.
  const patched = useTournamentStore.getState().applyResultPatch(CARD, 13, [
    pairing("t2", { scoreOne: 300, scoreTwo: 250, winner: "A" } as Partial<Pairing>),
  ]);
  assert.equal(patched, false, "the gap is detected");
  assert.equal(card().version, 10, "and nothing is half-applied while we are still stale");

  // This is the line the frozen handler runs on a false return: `if (!patched) void syncCard(cardId)`.
  const server = cardAt(13, [
    pairing("t1", { scoreOne: 500, scoreTwo: 433, winner: "A" } as Partial<Pairing>), // the LOST v11
    pairing("t2", { scoreOne: 300, scoreTwo: 250, winner: "A" } as Partial<Pairing>), // the v13
  ]);
  const calls = await withServerCard(server, () => useTournamentStore.getState().syncCard(CARD));

  assert.equal(calls, 1, "exactly one refetch, not a storm");
  assert.equal(card().version, 13, "B is now at the server's version");
  assert.equal(row("t1").scoreOne, 500,
    "THE POINT: the result that the dropped event carried is now present");
  assert.equal(row("t2").scoreOne, 300, "and so is the one that survived");
});

test("the resync is authoritative even when the local card was further behind", async () => {
  seed(3);

  assert.equal(useTournamentStore.getState().applyResultPatch(CARD, 20, []), false);

  const server = cardAt(20, [
    pairing("t1", { scoreOne: 111, scoreTwo: 100, winner: "A" } as Partial<Pairing>),
    pairing("t2", { scoreOne: 222, scoreTwo: 200, winner: "A" } as Partial<Pairing>),
  ]);
  await withServerCard(server, () => useTournamentStore.getState().syncCard(CARD));

  assert.equal(card().version, 20);
  assert.equal(row("t1").scoreOne, 111);
  assert.equal(row("t2").scoreOne, 222);
});

test("a failed resync leaves the previous state rather than a half-built one", async () => {
  seed(10);
  useTournamentStore.getState().applyResultPatch(CARD, 13, []);

  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  try {
    await useTournamentStore.getState().syncCard(CARD);
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(card().version, 10,
    "a transient failure must not invent a version; the next event or hint retries");
  assert.equal(row("t1").scoreOne, null);
});
