import assert from "node:assert/strict";
import test from "node:test";
import type { Tournament } from "@/domain/tournament/types";
import { createTournamentLookup, tournamentStateFor, type TournamentLookupResult } from "./tournament-lookup";

const tournament = (id: string, status: Tournament["status"]): Tournament => ({
  id, name: `Cup ${id}`, status, createdBy: null, createdAt: "", version: 1, directors: [], cardCount: 1, accessToken: id,
});

/** A promise the test settles by hand, to control response ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a failure for one tournament never sticks to a later, successful lookup for another", async () => {
  // Models the mounted component: `settled` is its state; each effect run gets a fresh lookup and
  // cancels the previous one on cleanup, exactly as admin-card-inspection.tsx wires it.
  let settled: TournamentLookupResult | null = null;
  const setSettled = (result: TournamentLookupResult) => { settled = result; };

  const first = createTournamentLookup(() => Promise.reject(new Error("503")), setSettled);
  await first.request("t-closed");
  assert.deepEqual(tournamentStateFor(settled, "t-closed"), { kind: "error" });

  first.cancel(); // card changed → effect cleanup
  const response = deferred<Tournament[]>();
  const second = createTournamentLookup(() => response.promise, setSettled);
  const pending = second.request("t-open");
  assert.deepEqual(tournamentStateFor(settled, "t-open"), { kind: "loading" },
    "while the new request is in flight the old error must not show for the new tournament");
  response.resolve([tournament("t-open", "OPEN"), tournament("t-closed", "CLOSED")]);
  await pending;
  assert.deepEqual(tournamentStateFor(settled, "t-open"), { kind: "ready", name: "Cup t-open", status: "OPEN" });
});

test("only the latest request may settle: an older, slower response is dropped", async () => {
  const results: TournamentLookupResult[] = [];
  const responses = [deferred<Tournament[]>(), deferred<Tournament[]>()];
  let call = 0;
  const lookup = createTournamentLookup(() => responses[call++].promise, (result) => results.push(result));
  const older = lookup.request("t-a");
  const newer = lookup.request("t-b");
  responses[1].resolve([tournament("t-b", "CLOSED")]);
  await newer;
  responses[0].reject(new Error("late failure"));
  await older;
  assert.deepEqual(results, [{ tournamentId: "t-b", state: { kind: "ready", name: "Cup t-b", status: "CLOSED" } }]);
});

test("a cancelled lookup (unmount / card switch) never settles", async () => {
  const results: TournamentLookupResult[] = [];
  const response = deferred<Tournament[]>();
  const lookup = createTournamentLookup(() => response.promise, (result) => results.push(result));
  const pending = lookup.request("t-a");
  lookup.cancel();
  response.resolve([tournament("t-a", "OPEN")]);
  await pending;
  assert.deepEqual(results, []);
});

test("a synchronous throw from the loader is an error for that tournament, not a crash", async () => {
  let settled: TournamentLookupResult | null = null;
  const lookup = createTournamentLookup(() => { throw new Error("boom"); }, (result) => { settled = result; });
  await lookup.request("t-a");
  assert.deepEqual(tournamentStateFor(settled, "t-a"), { kind: "error" });
});

test("a tournament missing from a successful list is 'unavailable', distinct from a failed request", async () => {
  let settled: TournamentLookupResult | null = null;
  const lookup = createTournamentLookup(async () => [tournament("t-other", "OPEN")], (result) => { settled = result; });
  await lookup.request("t-a");
  assert.deepEqual(tournamentStateFor(settled, "t-a"), { kind: "unavailable" });
  assert.deepEqual(tournamentStateFor(null, "t-a"), { kind: "loading" });
  assert.deepEqual(tournamentStateFor(settled, undefined), { kind: "loading" });
});
