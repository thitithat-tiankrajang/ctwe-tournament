import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore, type AuthState } from "./store";

/**
 * P3-B: the authenticated card list is served by `GET /api/card-summaries`, and must fall back to
 * `/api/cards` on **400, 404 or 405**.
 *
 * `04_BLOCKERS.md` B3 requires all three, not just 404: if the endpoint were ever routed as a card
 * id, the UUID conversion would fail with a **400**, and a 404-only fallback would render an empty
 * card list instead of falling back. This is what keeps New FE + Old BE working (Invariant D) —
 * a backend from before P1-B has no such route at all.
 */

function installBrowser() {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let cookie = "CTWE_STAFF=1; XSRF-TOKEN=csrf";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/cards", replace: () => undefined }, localStorage: { removeItem: () => undefined, getItem: () => null, setItem: () => undefined } },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { get cookie() { return cookie; }, set cookie(v: string) { cookie = v; } },
  });
  return {
    restore() {
      if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
      else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
      else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    },
  };
}

const authed: AuthState = { authenticated: true, username: "director", roles: ["ROLE_DIRECTOR"], csrfToken: "csrf" };

const summaryRow = {
  id: "card-1", tournamentId: "t1", name: "N", division: "D", status: "ACTIVE",
  runtimeStage: "PLAYER_REGISTRATION", currentGame: 1, gameCount: 4, playerCount: 400,
  publishedGameCount: 0, version: 11, createdAt: "2026-01-01T00:00:00Z",
};
const fullCard = { ...summaryRow, games: [], players: [], rules: [], tables: [], snapshots: [], audit: [] };

/** Runs load() with a stubbed backend and reports which paths were called. */
async function loadWith(summariesStatus: number) {
  const browser = installBrowser();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/auth/me")) {
      return new Response(JSON.stringify(authed), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/card-summaries")) {
      return summariesStatus === 200
        ? new Response(JSON.stringify([summaryRow]), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ status: summariesStatus, error: "nope" }), { status: summariesStatus, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/cards")) {
      return new Response(JSON.stringify([fullCard]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  useTournamentStore.setState({ auth: authed, cards: [], summaries: [] });
  try {
    await useTournamentStore.getState().load();
    return { calls, state: useTournamentStore.getState() };
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
}

test("the happy path uses the lean endpoint and never touches /api/cards", async () => {
  const { calls, state } = await loadWith(200);

  assert.ok(calls.some((url) => url.includes("/api/card-summaries")));
  assert.equal(calls.filter((url) => /\/api\/cards(\?|$)/.test(url)).length, 0,
    "fetching the full list too would throw away the entire point of P3-B");
  assert.equal(state.summaries.length, 1);
  assert.equal(state.summaries[0].playerCount, 400, "staff truth, not the public projection's 0");
  assert.deepEqual(state.cards, [], "no full cards until one is opened");
});

for (const status of [400, 404, 405]) {
  test(`a ${status} from the lean endpoint falls back to /api/cards`, async () => {
    const { calls, state } = await loadWith(status);

    assert.ok(calls.some((url) => url.includes("/api/card-summaries")), "it must try the lean one first");
    assert.ok(calls.some((url) => /\/api\/cards(\?|$)/.test(url)), `a ${status} must fall back`);
    assert.equal(state.cards.length, 1, "the old full-card path still populates the list");
    assert.deepEqual(state.summaries, []);
  });
}

test("an unexpected status is a real error, not a silent fallback", async () => {
  const { calls, state } = await loadWith(500);

  assert.equal(calls.filter((url) => /\/api\/cards(\?|$)/.test(url)).length, 0,
    "a 500 is not 'this backend has no endpoint' — masking it would hide a broken server");
  assert.ok(state.error, "the failure is surfaced");
});
