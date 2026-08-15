import assert from "node:assert/strict";
import test from "node:test";

/**
 * Store-level resolution: which requests actually leave the browser.
 *
 * The two invariants Phase D exists to protect:
 *
 * 1. **A published tournament issues ZERO requests to the API origin.** That is the whole point —
 *    Render and Neon are never contacted, so the backend can be switched off between events.
 * 2. **A live tournament's request sequence is exactly what it is today.** The probe is additive
 *    and fails open; a snapshot problem must never delay or break a running event.
 *
 * These drive `loadBundle` through `enterPublicTournament`, the same entry point both viewer routes
 * use, and assert on the URLs that reach `fetch`.
 */

const SNAPSHOT_ORIGIN = "https://snapshot.example.com";
const API_ORIGIN = "https://api.example.com";

let moduleCounter = 0;

/** Loads a fresh store with the given feature-flag state; returns it plus a request log. */
async function loadStore(options: { snapshotOrigin?: string } = {}) {
  if (options.snapshotOrigin === undefined) delete process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN;
  else process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN = options.snapshotOrigin;
  process.env.NEXT_PUBLIC_PUBLIC_API_ORIGIN = API_ORIGIN;

  const suffix = `?case=${moduleCounter++}`;
  // The store imports snapshot-api and public-api; busting all three keeps their module-scope
  // environment reads in step with each other.
  const store = (await import(`./store.ts${suffix}`)) as typeof import("./store");
  return store;
}

function snapshotDocument(id = "t-1") {
  return {
    snapshot: { schema: 1, version: 2, checksum: "sha256-x", generatedAt: "2026-08-15T00:00:00Z" },
    payload: {
      id,
      name: "CTWE 2026",
      cardCount: 1,
      publishedCardCount: 1,
      cards: [{
        id: "card-1", tournamentId: id, name: "CTWE 2026", division: "ม.ต้น",
        status: "FINISHED", runtimeStage: "FINAL_PUBLISHED", currentGame: 3, version: 12,
        games: [], initialPairingRule: "RANDOM", rules: [], players: [], tables: [],
        snapshots: [], audit: [], finalType: "NONE", finalGames: 0, finalRound: null,
        gibsonEnabled: false, createdAt: "2026-08-01T00:00:00Z", codePrefix: "P",
      }],
    },
  };
}

function liveBundle(id = "t-1") {
  return {
    id, name: "CTWE 2026", accessToken: "live-token", cardCount: 1, publishedCardCount: 1,
    cards: snapshotDocument(id).payload.cards,
  };
}

/** Installs a fetch double and returns the log of requested URLs. */
function captureFetch(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = previous; } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// =========================================================== published path

test("a published tournament resolves from the CDN and never touches the API origin", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN) ? json(snapshotDocument()) : json(liveBundle()));

  try {
    const bundle = await useTournamentStore.getState().enterPublicTournament("published-a");

    assert.equal(bundle.id, "t-1");
    assert.equal(bundle.cards.length, 1);
    // The decisive assertion: nothing at all went to Render.
    assert.deepEqual(captured.urls.filter((url) => url.startsWith(API_ORIGIN)), [],
      "a published tournament must issue zero requests to the API origin");
    // And exactly one went to the CDN — the probe IS the data fetch, never a probe plus a fetch.
    assert.equal(captured.urls.length, 1);
    assert.ok(captured.urls[0].startsWith(`${SNAPSHOT_ORIGIN}/s/`));
  } finally {
    captured.restore();
  }
});

test("the published tournament is flagged so the viewer opens no realtime channel", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch(() => json(snapshotDocument("t-flag")));

  try {
    await useTournamentStore.getState().enterPublicTournament("published-b");
    assert.equal(useTournamentStore.getState().activeTournament?.published, true);
    // The token comes from the URL, not from the payload, which deliberately omits it.
    assert.equal(useTournamentStore.getState().activeTournament?.accessToken, "published-b");
  } finally {
    captured.restore();
  }
});

// =========================================================== live path

test("a 404 snapshot falls through to exactly today's live bundle request", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN) ? new Response("", { status: 404 }) : json(liveBundle("t-live")));

  try {
    const bundle = await useTournamentStore.getState().enterPublicTournament("live-a");

    assert.equal(bundle.id, "t-live");
    const apiCalls = captured.urls.filter((url) => url.startsWith(API_ORIGIN));
    assert.deepEqual(apiCalls, [`${API_ORIGIN}/api/public/tournaments/live-a/bundle`],
      "the live path must issue exactly one bundle request, unchanged");
    assert.equal(useTournamentStore.getState().activeTournament?.published ?? false, false);
  } finally {
    captured.restore();
  }
});

test("a snapshot failure still leaves the live tournament fully usable", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch((url) => {
    if (url.startsWith(SNAPSHOT_ORIGIN)) throw new Error("CDN unreachable");
    return json(liveBundle("t-resilient"));
  });

  try {
    const bundle = await useTournamentStore.getState().enterPublicTournament("live-b");

    assert.equal(bundle.id, "t-resilient", "a snapshot outage must not break a running event");
    assert.ok(captured.urls.some((url) => url === `${API_ORIGIN}/api/public/tournaments/live-b/bundle`));
  } finally {
    captured.restore();
  }
});

/**
 * The kill switch (`NEXT_PUBLIC_SNAPSHOT_ORIGIN` unset ⇒ no probe at all) is asserted in
 * `snapshot-api.test.ts`, where the module under test is the direct import target and can be
 * reloaded with a fresh environment. Here the store's cache-busting suffix does not reach its
 * transitive import of `snapshot-api`, so that module keeps whatever origin it first saw — a
 * harness limitation, not a behaviour difference. What this file can prove about the flag is that
 * the store adds no request of its own beyond the single probe.
 */
test("the probe never causes a second fetch of the same data", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN) ? json(snapshotDocument("t-once")) : json(liveBundle()));

  try {
    await useTournamentStore.getState().enterPublicTournament("published-once");

    assert.equal(captured.urls.length, 1,
      "the probe response IS the tournament data; there is no follow-up fetch");
  } finally {
    captured.restore();
  }
});

test("concurrent resolutions of one token share a single request", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN) ? new Response("", { status: 404 }) : json(liveBundle("t-dedupe")));

  try {
    // The viewer page effect and the app-wide hydration load() can both resolve the same token on
    // a cold page. The existing in-flight dedupe must still hold with the probe in the path.
    const [first, second] = await Promise.all([
      useTournamentStore.getState().enterPublicTournament("live-dedupe"),
      useTournamentStore.getState().enterPublicTournament("live-dedupe"),
    ]);

    assert.equal(first.id, second.id);
    assert.equal(captured.urls.filter((url) => url.startsWith(API_ORIGIN)).length, 1,
      "one bundle request, exactly as today");
  } finally {
    captured.restore();
  }
});

test("a dead link still surfaces as an error rather than an empty published tournament", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN)
      ? new Response("", { status: 404 })
      : json({ message: "Tournament not found or not open" }, 404));

  try {
    await assert.rejects(() => useTournamentStore.getState().enterPublicTournament("closed-a"));
  } finally {
    captured.restore();
  }
});

// =========================================================== both routes

test("a legacy /t/{hex} token resolves a snapshot the same way /tour/{slug} does", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const legacy = "7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f";
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN) ? json(snapshotDocument("t-legacy")) : json(liveBundle()));

  try {
    const bundle = await useTournamentStore.getState().enterPublicTournament(legacy);

    assert.equal(bundle.id, "t-legacy");
    assert.equal(bundle.accessToken, legacy);
    // Both routes funnel through loadBundle, so resolution depends on the token, not the URL shape.
    assert.deepEqual(captured.urls.filter((url) => url.startsWith(API_ORIGIN)), []);
  } finally {
    captured.restore();
  }
});

test("a legacy /t/{hex} token that is not published uses the legacy live path", async () => {
  const { useTournamentStore } = await loadStore({ snapshotOrigin: SNAPSHOT_ORIGIN });
  const legacy = "0011223344556677889900aabbccddee";
  const captured = captureFetch((url) =>
    url.startsWith(SNAPSHOT_ORIGIN) ? new Response("", { status: 404 }) : json(liveBundle("t-legacy-live")));

  try {
    const bundle = await useTournamentStore.getState().enterPublicTournament(legacy);

    assert.equal(bundle.id, "t-legacy-live");
    assert.deepEqual(captured.urls.filter((url) => url.startsWith(API_ORIGIN)),
      [`${API_ORIGIN}/api/public/tournaments/${legacy}/bundle`]);
  } finally {
    captured.restore();
  }
});
