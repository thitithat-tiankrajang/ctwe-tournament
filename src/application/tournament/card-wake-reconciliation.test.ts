import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore } from "./store";
import { createWakeReconciliationRunner } from "./use-card-wake-reconciliation";
import { selectConflicts } from "@/ui/components/result-entry-grid";
import type { Pairing, TournamentCard } from "@/domain/tournament/types";

const CARD = "card-wake";
const X = "g1t1";
const Y = "g1t2";

function pairing(id: string, over: Partial<Pairing> = {}): Pairing {
  return {
    id,
    gameNumber: 1,
    tableNumber: Number(id.slice(-1)),
    playerOneId: id === X ? "P001" : "P003",
    playerTwoId: id === X ? "P002" : "P004",
    scoreOne: undefined,
    scoreTwo: undefined,
    resultType: undefined,
    winnerId: undefined,
    calculatedDiff: undefined,
    pairingPublished: true,
    ...over,
  } as unknown as Pairing;
}

function card(version: number, pairings: Pairing[]): TournamentCard {
  return {
    id: CARD,
    tournamentId: "tournament-1",
    name: "Wake",
    division: "Division",
    status: "ACTIVE",
    runtimeStage: "RESULT_COLLECTION",
    currentGame: 1,
    version,
    createdAt: "2026-01-01T00:00:00Z",
    games: [],
    players: [],
    rules: [],
    tables: [],
    audit: [],
    snapshots: [{ id: "s1", gameNumbers: [1], confirmedAt: "", pairings }],
  } as unknown as TournamentCard;
}

function seed(version = 10) {
  useTournamentStore.setState({
    cards: [card(version, [pairing(X), pairing(Y)])],
    auth: { authenticated: true, username: "staff-a", roles: ["ROLE_STAFF"], csrfToken: "csrf" },
    remoteResult: null,
    remotePairing: null,
    wakeReconciliation: null,
    error: null,
  });
}

function serverCard(version: number, x: Partial<Pairing> = {}, y: Partial<Pairing> = {}) {
  return card(version, [pairing(X, x), pairing(Y, y)]);
}

async function withServer(response: TournamentCard | Error, run: () => Promise<void>, delay = 0) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (response instanceof Error) throw response;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

test("same-pair wake result is surfaced to the existing draft conflict path before replacement", async () => {
  seed();
  const server = serverCard(11, { scoreOne: 500, scoreTwo: 433, resultType: "WIN", winnerId: "P001", calculatedDiff: 67 });

  await withServer(server, async () => {
    assert.equal(await useTournamentStore.getState().reconcileCard(CARD), "verified");
  });

  const state = useTournamentStore.getState();
  assert.equal(state.cards[0].version, 11);
  assert.equal(state.wakeReconciliation?.status, "verified");
  assert.equal(state.remoteResult?.changes[0].pairingId, X);
  assert.equal(selectConflicts(state.remoteResult!, new Set(), { [X]: { one: "400", two: "300" } }).length, 1);
});

test("a different-pair wake change updates authoritative state without interrupting another draft", async () => {
  seed();
  const server = serverCard(11, {}, { scoreOne: 450, scoreTwo: 300, resultType: "WIN", winnerId: "P003", calculatedDiff: 50 });

  await withServer(server, async () => { await useTournamentStore.getState().reconcileCard(CARD); });

  const state = useTournamentStore.getState();
  assert.equal(state.cards[0].snapshots[0].pairings.find((item) => item.id === Y)?.scoreOne, 450);
  assert.equal(state.remoteResult?.changes[0].pairingId, Y);
  assert.deepEqual(selectConflicts(state.remoteResult!, new Set(), { [X]: { one: "12", two: "34" } }), []);
});

test("a pairing-only wake change raises the existing pairing notice", async () => {
  seed();
  const server = serverCard(11, {}, { playerOneId: "P005", playerTwoId: "P006" });

  await withServer(server, async () => { await useTournamentStore.getState().reconcileCard(CARD); });

  const state = useTournamentStore.getState();
  assert.equal(state.remotePairing?.changedSlots[0].table, 2);
  assert.equal(state.remotePairing?.changedSlots[0].afterOne, "P005");
  assert.equal(state.cards[0].snapshots[0].pairings.find((item) => item.id === Y)?.playerOneId, "P005");
});

test("no server change verifies the card without manufacturing a notice", async () => {
  seed(10);
  const calls = await withServer(serverCard(10), async () => { await useTournamentStore.getState().reconcileCard(CARD); });

  assert.equal(calls, 1);
  assert.equal(useTournamentStore.getState().wakeReconciliation?.status, "verified");
  assert.equal(useTournamentStore.getState().remoteResult, null);
  assert.equal(useTournamentStore.getState().remotePairing, null);
});

test("failed wake read keeps the held card and exposes retry state", async () => {
  seed(10);
  const before = useTournamentStore.getState().cards[0];

  await withServer(new Error("offline"), async () => {
    assert.equal(await useTournamentStore.getState().reconcileCard(CARD), "failed");
  });

  const state = useTournamentStore.getState();
  assert.equal(state.cards[0], before);
  assert.equal(state.cards[0].version, 10);
  assert.equal(state.wakeReconciliation?.status, "failed");
});

test("near-simultaneous reconciliation requests coalesce to one authoritative read", async () => {
  seed();
  const calls = await withServer(serverCard(11), async () => {
    await Promise.all([
      useTournamentStore.getState().reconcileCard(CARD),
      useTournamentStore.getState().reconcileCard(CARD),
      useTournamentStore.getState().reconcileCard(CARD),
    ]);
  }, 20);

  assert.equal(calls, 1);
  assert.equal(useTournamentStore.getState().cards[0].version, 11);
});

test("a newer SSE state wins when an older wake response settles later", async () => {
  seed(10);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const older = serverCard(11, { scoreOne: 400, scoreTwo: 300, resultType: "WIN", winnerId: "P001", calculatedDiff: 50 });
  const newer = serverCard(12, { scoreOne: 500, scoreTwo: 300, resultType: "WIN", winnerId: "P001", calculatedDiff: 100 });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    started();
    await gate;
    return { ok: true, status: 200, text: async () => JSON.stringify(older) } as unknown as Response;
  }) as typeof fetch;
  try {
    const pending = useTournamentStore.getState().reconcileCard(CARD);
    await fetchStarted;
    // Simulate a newer authoritative stream event arriving while the wake read is in flight.
    useTournamentStore.getState().applyCardState(newer);
    release();
    assert.equal(await pending, "verified");
  } finally {
    globalThis.fetch = real;
  }

  const held = useTournamentStore.getState().cards[0];
  assert.equal(held.version, 12);
  assert.equal(held.snapshots[0].pairings.find(item => item.id === X)?.scoreOne, 500);
});

test("a confirmed expired session cannot be reported as a successful wake", async () => {
  seed();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/api/auth/me")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ authenticated: false, username: null, roles: [], csrfToken: "" }),
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
      text: async () => JSON.stringify({ error: "Unauthorized" }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    assert.equal(await useTournamentStore.getState().reconcileCard(CARD), "failed");
  } finally {
    globalThis.fetch = real;
  }

  const state = useTournamentStore.getState();
  assert.equal(state.auth.authenticated, false);
  assert.equal(state.cards.length, 0);
  assert.equal(state.wakeReconciliation?.status, "failed");
});

test("resume signals during a wake read coalesce into exactly one trailing reconciliation", async () => {
  let resolveFirst!: () => void;
  const first = new Promise<void>(resolve => { resolveFirst = resolve; });
  const calls: number[] = [];
  const runner = createWakeReconciliationRunner(async () => {
    calls.push(calls.length + 1);
    if (calls.length === 1) await first;
  }, { delayMs: 0 });
  runner.schedule();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [1]);
  runner.schedule();
  runner.schedule();
  runner.schedule();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [1], "signals must wait behind the active request");
  resolveFirst();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [1, 2], "one trailing request must run after the first settles");
  runner.dispose();
});

test("disposing a wake runner during an active read prevents its trailing request", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  let calls = 0;
  const runner = createWakeReconciliationRunner(async () => { calls += 1; await pending; }, { delayMs: 0 });
  runner.schedule();
  await new Promise(done => setTimeout(done, 5));
  runner.schedule();
  runner.dispose();
  resolve();
  await new Promise(done => setTimeout(done, 5));
  assert.equal(calls, 1);
});

test("switching cards disposes the old wake runner while its read is still active", async () => {
  let releaseOld!: () => void;
  const oldRead = new Promise<void>(resolve => { releaseOld = resolve; });
  let oldCalls = 0;
  let nextCalls = 0;
  const oldRunner = createWakeReconciliationRunner(async () => {
    oldCalls += 1;
    await oldRead;
  }, { delayMs: 0 });
  oldRunner.schedule();
  await new Promise(done => setTimeout(done, 5));
  oldRunner.dispose();

  const nextRunner = createWakeReconciliationRunner(async () => { nextCalls += 1; }, { delayMs: 0 });
  nextRunner.schedule();
  await new Promise(done => setTimeout(done, 5));
  releaseOld();
  await new Promise(done => setTimeout(done, 5));

  assert.equal(oldCalls, 1);
  assert.equal(nextCalls, 1);
  nextRunner.dispose();
});
