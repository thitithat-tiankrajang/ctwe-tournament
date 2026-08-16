import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { loadConfig, type Config } from "../config.js";
import { MetricsHub } from "../lib/metrics-hub.js";
import { snapshotKey } from "../lib/snapshot-key.js";
import { SnapshotViewer } from "./snapshot-viewer.js";
import { Viewer } from "./viewer-sse.js";

/**
 * The zero-Render claim, exercised end to end against stub hosts.
 *
 * These tests run the real `SnapshotViewer` and the real `Viewer` — not a model of them — against
 * three separate HTTP servers standing in for the Worker, the CDN and Render. Each server counts
 * what it was actually asked for, so the assertions compare the harness's own ledger against an
 * independent observation of the wire.
 *
 * The pairing matters more than either half. "A published viewer makes no Render request" is easy to
 * satisfy by accident, so every such case is paired with a case where the snapshot is missing: the
 * same viewer code then falls open onto the live path, Render records the requests, and the ledger
 * records them too. That is what makes the passing case evidence rather than a tautology.
 *
 * This is a simulation of the client's request behaviour. It says nothing about Cloudflare, R2, or
 * production capacity — no edge is involved, so `cf-cache-status` is whatever these stubs send.
 */

interface Stub {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

async function listen(handler: http.RequestListener): Promise<Stub> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function envelope(cardIds: string[]) {
  return JSON.stringify({
    snapshot: { schema: 1, version: 3, checksum: "sha256-stub", generatedAt: "2026-08-15T00:00:00Z" },
    payload: {
      id: "8b0c2c5e-1f1a-4a0a-8d0e-1c0a2b3c4d5e",
      name: "Stub Cup",
      cardCount: cardIds.length,
      publishedCardCount: cardIds.length,
      cards: cardIds.map((id) => ({ id, version: 4 })),
    },
  });
}

/** A CDN that serves snapshots for `published` and an edge-cached 404 for everything else. */
async function cdnStub(published: Record<string, string[]>, options: { delayMs?: number } = {}) {
  const keys = new Map(Object.entries(published).map(([token, cards]) => [snapshotKey(token), cards]));
  return listen((req, res) => {
    const send = () => {
      const key = (req.url ?? "").replace(/^\/s\//, "").replace(/\.json$/, "");
      const cards = keys.get(key);
      if (!cards) {
        res.writeHead(404, { "cf-cache-status": "HIT", "cache-control": "public, max-age=60" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cf-cache-status": "HIT" });
      res.end(envelope(cards));
    };
    if (options.delayMs) setTimeout(send, options.delayMs);
    else send();
  });
}

/** Render: the bundle, the realtime config, and a real (if minimal) SSE stream. */
async function originStub(cardIds: string[]) {
  return listen((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/public/realtime-config")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ realtimeEnabled: true, sseEnabled: true, pollingEnabled: false, pollingIntervalMs: 60_000, reconnectDelayMs: 2_000 }));
      return;
    }
    if (url.includes("/bundle")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "live-id", name: "Live Cup", accessToken: "live-token", cards: cardIds.map((id) => ({ id, name: "A", division: "OPEN" })) }));
      return;
    }
    if (url.includes("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      return; // deliberately held open, like the real stream
    }
    res.writeHead(404);
    res.end();
  });
}

async function frontendStub() {
  return listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>stub</title>");
  });
}

function configFor(env: Record<string, string>): Config {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(TOURNAMENT_URL|PUBLIC_API_ORIGIN|BACKEND_ORIGIN|SNAPSHOT_ORIGIN|PUBLISHED_TOKENS|LIVE_TOKENS|FLEET|FETCH_PAGE_DOCUMENT|SNAPSHOT_PROBE_ON_LIVE|SNAPSHOT_PROBE_TIMEOUT_MS|STAGES)$/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return loadConfig();
  } finally {
    process.env = previous;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================== ② the published path costs Render 0

test("a published viewer resolves from the CDN and never touches Render", async () => {
  const cdn = await cdnStub({ "pub-cup": ["card-1", "card-2"] });
  const origin = await originStub(["card-1"]);
  const frontend = await frontendStub();
  try {
    const config = configFor({
      TOURNAMENT_URL: `${frontend.origin}/tour/live-cup`,
      PUBLIC_API_ORIGIN: origin.origin,
      BACKEND_ORIGIN: origin.origin,
      SNAPSHOT_ORIGIN: cdn.origin,
      PUBLISHED_TOKENS: "pub-cup",
      FLEET: "published",
      FETCH_PAGE_DOCUMENT: "true",
    });
    const hub = new MetricsHub();
    const viewer = new SnapshotViewer(0, "pub-cup", config, hub);
    await viewer.start();
    await sleep(50);
    viewer.stop();

    const snapshot = hub.snapshot().snapshot;
    // Observed on the wire, independently of the harness's own bookkeeping.
    assert.deepEqual(origin.requests, [], "Render received a request on the published path");
    assert.equal(cdn.requests.length, 1);
    assert.equal(frontend.requests.length, 1, "the document still comes from the Worker");

    // ...and the ledger agrees.
    assert.equal(snapshot.publishedOriginRequests, 0);
    assert.equal(snapshot.publishedSseAttempts, 0);
    assert.equal(snapshot.probesPublished, 1);
    assert.equal(snapshot.publishedFallbacks, 0);
    assert.equal(snapshot.cdnRequests, 1);
    // A single viewer's probe is the first lookup of that key, so it is a cold one.
    assert.deepEqual(snapshot.edgeStatus200Cold, { HIT: 1 });
    assert.deepEqual(snapshot.edgeStatus200, {});
    assert.equal(snapshot.publishedFirstDataMs.count, 1);
  } finally {
    await Promise.all([cdn.close(), origin.close(), frontend.close()]);
  }
});

test("the same viewer DOES touch Render when the snapshot is missing, and the ledger records it", async () => {
  // The paired negative. Without this, the test above proves only that some code path made no
  // request — not that a request would have been counted had one been made.
  const cdn = await cdnStub({});
  const origin = await originStub(["card-1"]);
  const frontend = await frontendStub();
  try {
    const config = configFor({
      TOURNAMENT_URL: `${frontend.origin}/tour/live-cup`,
      PUBLIC_API_ORIGIN: origin.origin,
      BACKEND_ORIGIN: origin.origin,
      SNAPSHOT_ORIGIN: cdn.origin,
      PUBLISHED_TOKENS: "pub-cup",
      FLEET: "published",
      FETCH_PAGE_DOCUMENT: "true",
    });
    const hub = new MetricsHub();
    const viewer = new SnapshotViewer(0, "pub-cup", config, hub);
    await viewer.start();
    await sleep(150);
    viewer.stop();

    const snapshot = hub.snapshot().snapshot;
    assert.ok(origin.requests.some((url) => url.includes("/bundle")), "expected the fail-open bundle fetch");
    assert.ok(origin.requests.some((url) => url.includes("/events")), "expected the fail-open SSE stream");
    assert.equal(snapshot.probesPublished, 0);
    assert.equal(snapshot.probesNotPublished, 1);
    assert.equal(snapshot.publishedFallbacks, 1);
    assert.ok(snapshot.publishedOriginRequests >= 3, `expected ≥3 origin requests, got ${snapshot.publishedOriginRequests}`);
    assert.equal(snapshot.publishedSseAttempts, 1);
    // The ledger's count is not lower than what the origin actually saw.
    assert.ok(snapshot.publishedOriginRequests >= origin.requests.length);
  } finally {
    await Promise.all([cdn.close(), origin.close(), frontend.close()]);
  }
});

test("a probe that outlives the client's timeout falls open to the live path", async () => {
  const cdn = await cdnStub({ "pub-cup": ["card-1"] }, { delayMs: 300 });
  const origin = await originStub(["card-1"]);
  const frontend = await frontendStub();
  try {
    const config = configFor({
      TOURNAMENT_URL: `${frontend.origin}/tour/live-cup`,
      PUBLIC_API_ORIGIN: origin.origin,
      BACKEND_ORIGIN: origin.origin,
      SNAPSHOT_ORIGIN: cdn.origin,
      PUBLISHED_TOKENS: "pub-cup",
      FLEET: "published",
      FETCH_PAGE_DOCUMENT: "false",
      SNAPSHOT_PROBE_TIMEOUT_MS: "60",
    });
    const hub = new MetricsHub();
    const viewer = new SnapshotViewer(0, "pub-cup", config, hub);
    await viewer.start();
    await sleep(150);
    viewer.stop();

    const snapshot = hub.snapshot().snapshot;
    assert.equal(snapshot.probesTimedOut, 1);
    assert.equal(snapshot.publishedFallbacks, 1);
    assert.ok(snapshot.publishedOriginRequests > 0, "a timed-out probe must not silently drop the viewer");
  } finally {
    await Promise.all([cdn.close(), origin.close(), frontend.close()]);
  }
});

// ================================================================ ④ the probe's cost on the live path

test("a live viewer probes first, then takes today's exact live path", async () => {
  const cdn = await cdnStub({});
  const origin = await originStub(["card-1"]);
  const frontend = await frontendStub();
  try {
    const config = configFor({
      TOURNAMENT_URL: `${frontend.origin}/tour/live-cup`,
      PUBLIC_API_ORIGIN: origin.origin,
      BACKEND_ORIGIN: origin.origin,
      SNAPSHOT_ORIGIN: cdn.origin,
      FLEET: "live",
      FETCH_PAGE_DOCUMENT: "true",
    });
    const hub = new MetricsHub();
    const viewer = new Viewer(0, { token: "live-cup", cardId: "card-1" }, config, hub);
    await viewer.start();
    await sleep(100);
    viewer.stop();

    const snapshot = hub.snapshot().snapshot;
    assert.equal(cdn.requests.length, 1, "exactly one probe, not one per request");
    assert.equal(snapshot.probesNotPublished, 1);
    assert.deepEqual(snapshot.edgeStatus404Cold, { HIT: 1 });
    assert.deepEqual(snapshot.edgeStatus404, {}, "one viewer cannot produce a warm repeat");
    assert.equal(snapshot.liveViewers, 1);
    assert.equal(snapshot.publishedViewers, 0);
    // The live path is unchanged: realtime-config, bundle, SSE.
    assert.ok(origin.requests.some((url) => url.includes("realtime-config")));
    assert.ok(origin.requests.some((url) => url.includes("/bundle")));
    assert.ok(origin.requests.some((url) => url.includes("/events")));
    assert.ok(snapshot.probeMs.p95 !== null, "the probe's cost must be measured, not assumed");
    assert.equal(snapshot.liveFirstDataMs.count, 1);
    // The 404 is the designed answer for an unpublished tournament. Counting it as an HTTP error
    // would put a permanent ~17% error rate on every live viewer and fail stages for correctness.
    assert.equal(hub.snapshot().httpErrors, 0, "an expected 404 probe must not count as an HTTP error");
  } finally {
    await Promise.all([cdn.close(), origin.close(), frontend.close()]);
  }
});

test("the first lookup of a key is recorded cold and every repeat warm", async () => {
  // A real edge MISSes the first negative lookup while it populates its cache, then HITs. The split
  // is what lets ④b be judged "at steady state" instead of being dragged down by the warm-up.
  const seen = new Map<string, number>();
  const cdn = await listen((req, res) => {
    const key = req.url ?? "";
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    res.writeHead(404, { "cf-cache-status": count === 1 ? "MISS" : "HIT" });
    res.end("not found");
  });
  const origin = await originStub(["card-1"]);
  const frontend = await frontendStub();
  try {
    const config = configFor({
      TOURNAMENT_URL: `${frontend.origin}/tour/live-cup`,
      PUBLIC_API_ORIGIN: origin.origin,
      BACKEND_ORIGIN: origin.origin,
      SNAPSHOT_ORIGIN: cdn.origin,
      FLEET: "live",
      FETCH_PAGE_DOCUMENT: "false",
    });
    const hub = new MetricsHub();
    const viewers = [0, 1, 2, 3].map((id) => new Viewer(id, { token: "live-cup", cardId: "card-1" }, config, hub));
    for (const viewer of viewers) await viewer.start();
    await sleep(80);
    for (const viewer of viewers) viewer.stop();

    const snapshot = hub.snapshot().snapshot;
    assert.deepEqual(snapshot.edgeStatus404Cold, { MISS: 1 }, "exactly one cold first lookup");
    assert.deepEqual(snapshot.edgeStatus404, { HIT: 3 }, "the repeats are warm and hit the edge");
  } finally {
    await Promise.all([cdn.close(), origin.close(), frontend.close()]);
  }
});

test("with no snapshot origin the live viewer issues no probe at all", async () => {
  const origin = await originStub(["card-1"]);
  const frontend = await frontendStub();
  try {
    const config = configFor({
      TOURNAMENT_URL: `${frontend.origin}/tour/live-cup`,
      PUBLIC_API_ORIGIN: origin.origin,
      BACKEND_ORIGIN: origin.origin,
      FETCH_PAGE_DOCUMENT: "true",
    });
    const hub = new MetricsHub();
    const viewer = new Viewer(0, { token: "live-cup", cardId: "card-1" }, config, hub);
    await viewer.start();
    await sleep(50);
    viewer.stop();

    // This is the ① baseline shape: byte-for-byte the request sequence the harness made before
    // Phase H existed.
    assert.equal(hub.snapshot().snapshot.probes, 0);
    assert.equal(origin.requests.filter((url) => !url.includes("/events")).length, 2);
  } finally {
    await Promise.all([origin.close(), frontend.close()]);
  }
});

// ======================================================================== configuration refusals

test("a published fleet without a CDN origin is refused rather than degraded", () => {
  assert.throws(
    () => configFor({
      TOURNAMENT_URL: "http://127.0.0.1:1/tour/live-cup",
      PUBLIC_API_ORIGIN: "http://127.0.0.1:1",
      FLEET: "published",
      PUBLISHED_TOKENS: "pub-cup",
    }),
    /needs SNAPSHOT_ORIGIN/,
  );
});

test("a published fleet with no published tokens is refused", () => {
  assert.throws(
    () => configFor({
      TOURNAMENT_URL: "http://127.0.0.1:1/tour/live-cup",
      PUBLIC_API_ORIGIN: "http://127.0.0.1:1",
      SNAPSHOT_ORIGIN: "http://127.0.0.1:2",
      FLEET: "published",
    }),
    /needs PUBLISHED_TOKENS/,
  );
});

test("a tournament cannot be both the live control and the published subject", () => {
  assert.throws(
    () => configFor({
      TOURNAMENT_URL: "http://127.0.0.1:1/tour/live-cup",
      PUBLIC_API_ORIGIN: "http://127.0.0.1:1",
      SNAPSHOT_ORIGIN: "http://127.0.0.1:2",
      FLEET: "mixed",
      PUBLISHED_TOKENS: "live-cup",
    }),
    /cannot be its own control/,
  );
});
