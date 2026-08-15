import assert from "node:assert/strict";
import test from "node:test";

/**
 * The snapshot probe: key derivation, and the fail-open contract.
 *
 * `snapshot-api.ts` reads `NEXT_PUBLIC_SNAPSHOT_ORIGIN` at module load, so each group below imports
 * a fresh copy with the environment already set. The cache-busting query string is what makes that
 * possible without a module-registry reset.
 */

const FIXTURE_ORIGIN = "https://snapshot.example.com";

let moduleCounter = 0;
async function loadModule(origin: string | undefined) {
  if (origin === undefined) delete process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN;
  else process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN = origin;
  return import(`./snapshot-api.ts?case=${moduleCounter++}`) as Promise<
    typeof import("./snapshot-api")
  >;
}

/** A published document as the CDN would serve it. */
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: { schema: 1, version: 3, checksum: "sha256-abc", generatedAt: "2026-08-15T00:00:00Z" },
    payload: {
      id: "f3da7a4d-6fa1-4531-9631-8c96f48fce2f",
      name: "CTWE 2026",
      cardCount: 1,
      publishedCardCount: 1,
      cards: [{ id: "card-1", version: 9 }],
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Each test uses its own token. The session memo is real shared state here (Node exposes
 * `sessionStorage`), so a reused token would let one test's remembered answer short-circuit the
 * next — which is exactly what the memo is supposed to do in a browser.
 */

// =========================================================== key derivation (parity with Java)

/**
 * SHARED FIXTURE VECTORS — byte-identical to `SnapshotKeyTest.java`.
 *
 * If these two implementations ever disagree, the backend publishes to a key no browser will ever
 * request: every published tournament silently becomes unreachable while both sides' own tests keep
 * passing. That is why the expected values are written out rather than computed here.
 */
const VECTORS: Array<[string, string]> = [
  ["bkk-th-ms-championship", "hcjbazc3ehzb4pip6gueijdxv3"],
  ["ctwe", "hh3rgn6lnfxvhmc27hsgfzeiay"],
  ["a1b", "7jpknkgoln7kuq4ay3uvfj2kdo"],
  ["7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f", "xjlkx6owtl3czp4dfbfqel5n67"],
  ["a".repeat(64), "qeo5fga7l3m5xotlstwh2fscwm"],
];

test("snapshotKey matches the Java implementation on the shared vectors", async () => {
  const { snapshotKey } = await loadModule(FIXTURE_ORIGIN);
  for (const [token, expected] of VECTORS) {
    assert.equal(await snapshotKey(token), expected, `vector mismatch for "${token.slice(0, 24)}"`);
  }
});

test("snapshotKey produces 26 lowercase base32 characters", async () => {
  const { snapshotKey } = await loadModule(FIXTURE_ORIGIN);
  for (const [token] of VECTORS) {
    const key = await snapshotKey(token);
    assert.equal(key.length, 26);
    assert.match(key, /^[a-z2-7]{26}$/);
  }
});

test("near-identical tokens derive different keys", async () => {
  const { snapshotKey } = await loadModule(FIXTURE_ORIGIN);
  assert.notEqual(await snapshotKey("ctwe-2026"), await snapshotKey("ctwe-2027"));
  assert.notEqual(await snapshotKey("ctwe"), await snapshotKey("ctwe-"));
});

test("the object URL is one object per tournament under /s/", async () => {
  const { snapshotUrl, snapshotKey } = await loadModule(FIXTURE_ORIGIN);
  const key = await snapshotKey("ctwe-2026");
  assert.equal(await snapshotUrl("ctwe-2026"), `${FIXTURE_ORIGIN}/s/${key}.json`);
});

// =========================================================== the kill switch

test("with the origin unset, the probe never runs and no request is made", async () => {
  const { fetchSnapshotBundle, SNAPSHOT_ORIGIN } = await loadModule(undefined);
  const previous = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return jsonResponse(envelope()); }) as typeof fetch;

  try {
    assert.equal(SNAPSHOT_ORIGIN, "");
    assert.equal(await fetchSnapshotBundle("tok-off"), null);
    assert.equal(called, false, "the live path must be byte-identical to today when the flag is off");
  } finally {
    globalThis.fetch = previous;
  }
});

// =========================================================== published path

test("a 200 snapshot resolves to a bundle, with accessToken taken from the URL", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return jsonResponse(envelope());
  }) as typeof fetch;

  try {
    const bundle = await fetchSnapshotBundle("tok-published");
    assert.ok(bundle, "a published tournament must resolve from the CDN");
    assert.equal(bundle.id, "f3da7a4d-6fa1-4531-9631-8c96f48fce2f");
    assert.equal(bundle.cards.length, 1);
    // The payload deliberately omits accessToken; the client already holds it.
    assert.equal(bundle.accessToken, "tok-published");
    // Exactly ONE request, to the CDN. No second fetch for the same data.
    assert.equal(requested.length, 1);
    assert.ok(requested[0].startsWith(`${FIXTURE_ORIGIN}/s/`));
  } finally {
    globalThis.fetch = previous;
  }
});

test("the same key is derived for a legacy /t/{hex} token", async () => {
  const { fetchSnapshotBundle, snapshotKey } = await loadModule(FIXTURE_ORIGIN);
  const legacy = "7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f";
  const previous = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return jsonResponse(envelope());
  }) as typeof fetch;

  try {
    const bundle = await fetchSnapshotBundle(legacy);
    assert.ok(bundle, "legacy links must resolve snapshots too");
    assert.equal(bundle.accessToken, legacy);
    assert.equal(requested[0], `${FIXTURE_ORIGIN}/s/${await snapshotKey(legacy)}.json`);
  } finally {
    globalThis.fetch = previous;
  }
});

// =========================================================== fail-open

test("a 404 falls through to the live path", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-404"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a network failure falls through to the live path instead of throwing", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("DNS failure"); }) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-network"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a probe slower than the timeout is abandoned and the live path proceeds", async () => {
  const { fetchSnapshotBundle, PROBE_TIMEOUT_MS } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  let aborted = false;

  // Never resolves on its own: only the AbortController can end it, which is the point.
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    });
  })) as typeof fetch;

  try {
    const started = Date.now();
    assert.equal(await fetchSnapshotBundle("tok-timeout"), null);
    const elapsed = Date.now() - started;
    assert.ok(aborted, "the request must be cancelled, not merely raced");
    assert.ok(elapsed >= PROBE_TIMEOUT_MS - 50, `gave up too early: ${elapsed}ms`);
    assert.ok(elapsed < PROBE_TIMEOUT_MS + 1_000, `a live tournament waited too long: ${elapsed}ms`);
  } finally {
    globalThis.fetch = previous;
  }
});

test("an unsupported envelope schema falls through to the live path", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(envelope({ snapshot: { schema: 2 } }))) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-schema"), null,
      "a future document this build cannot read must not be rendered as a tournament");
  } finally {
    globalThis.fetch = previous;
  }
});

test("malformed JSON falls through to the live path", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{not json", { status: 200 })) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-badjson"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a document missing its payload falls through to the live path", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ snapshot: { schema: 1 } })) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-nopayload"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a 5xx from the CDN falls through to the live path", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-5xx"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("an empty token never probes", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return jsonResponse(envelope()); }) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle(""), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previous;
  }
});

// =========================================================== session memo

test("a remembered 'live' answer skips the probe entirely on the next call", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("", { status: 404 }); }) as typeof fetch;

  try {
    assert.equal(await fetchSnapshotBundle("tok-memo"), null);
    assert.equal(calls, 1);
    // The dominant repeat behaviour during a live event is refresh. The second resolution must
    // cost nothing at all — not even the edge-cached 404.
    assert.equal(await fetchSnapshotBundle("tok-memo"), null);
    assert.equal(calls, 1, "a remembered live tournament must not re-probe within the memo window");
  } finally {
    globalThis.fetch = previous;
  }
});

test("a remembered 'published' answer still returns the snapshot", async () => {
  const { fetchSnapshotBundle } = await loadModule(FIXTURE_ORIGIN);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(envelope())) as typeof fetch;

  try {
    assert.ok(await fetchSnapshotBundle("tok-memo-pub"));
    // Published is remembered for the session, but the object is still fetched (and served from
    // the browser/CDN cache) rather than reconstructed from the memo.
    assert.ok(await fetchSnapshotBundle("tok-memo-pub"));
  } finally {
    globalThis.fetch = previous;
  }
});
