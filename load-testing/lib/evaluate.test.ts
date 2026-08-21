import assert from "node:assert/strict";
import test from "node:test";

import type { Thresholds } from "../config.js";
import { evaluateSnapshot } from "./evaluate.js";
import type { Distribution, SnapshotFleetSnapshot } from "./metrics-hub.js";

/**
 * The Phase H verdicts.
 *
 * Every criterion is asserted in **both** directions. A one-sided test here would be worse than no
 * test: "zero Render requests" passes trivially for a harness that makes no requests, so what has to
 * be proven is that the check fails when origin traffic is present, that it fails when the fleet
 * never resolved a snapshot, and that a missing `cf-cache-status` header reports "not measured"
 * rather than quietly counting as a cache hit.
 */

const THRESHOLDS: Thresholds = {
  maxProcessCpu: 0.75,
  maxHeapRatio: 0.7,
  maxMetaspaceRatio: 0.8,
  maxErrorRatePct: 0.5,
  maxHttpErrorRatePct: 0.5,
  maxHttpP99Ms: 2_000,
  maxConnectP99Ms: 2_000,
  maxEventLatencyP95Ms: 3_000,
  minAttachRatio: 0.99,
  maxReconnectsPerMinPer1k: 20,
  nearLimitRatio: 0.85,
  maxProbeP95Ms: 25,
  minEdgeHitRatio: 0.95,
  maxLiveFirstDataRegressionMs: 25,
};

function distribution(p95: number | null): Distribution {
  return p95 === null
    ? { count: 0, avg: null, p50: null, p95: null, p99: null, max: null }
    : { count: 100, avg: p95, p50: p95, p95, p99: p95, max: p95 };
}

function fleet(overrides: Partial<SnapshotFleetSnapshot> = {}): SnapshotFleetSnapshot {
  return {
    liveViewers: 0,
    publishedViewers: 0,
    probes: 0,
    probesPublished: 0,
    probesNotPublished: 0,
    probesTimedOut: 0,
    probesFailed: 0,
    probesUnusable: 0,
    liveFleetProbeHits: 0,
    probeMs: distribution(null),
    publishedOriginRequests: 0,
    publishedSseAttempts: 0,
    publishedFallbacks: 0,
    liveOriginRequests: 0,
    cdnRequests: 0,
    cdnBytes: 0,
    edgeStatus200: {},
    edgeStatus404: {},
    edgeStatus200Cold: {},
    edgeStatus404Cold: {},
    liveFirstDataMs: distribution(null),
    publishedFirstDataMs: distribution(null),
    ...overrides,
  };
}

const statusOf = (criteria: { id: string; status: string }[], id: string) =>
  criteria.find((criterion) => criterion.id === id)?.status;

// ============================================================================ ② zero Render / SSE

test("② passes when a published fleet resolved snapshots and touched neither Render nor SSE", () => {
  const result = evaluateSnapshot("published", true, fleet({
    publishedViewers: 500,
    probes: 500,
    probesPublished: 500,
    probeMs: distribution(9),
    cdnRequests: 500,
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H2"), "PASS");
  assert.deepEqual(result.breaches, []);
});

test("② FAILS on a single Render request from the published fleet", () => {
  const result = evaluateSnapshot("published", true, fleet({
    publishedViewers: 500,
    probes: 500,
    probesPublished: 499,
    probesNotPublished: 1,
    probeMs: distribution(9),
    publishedOriginRequests: 1,
    publishedFallbacks: 1,
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H2"), "FAIL");
  assert.match(result.breaches.join("\n"), /published fleet contacted Render/);
});

test("② FAILS on an SSE attempt even when no other origin request was made", () => {
  const result = evaluateSnapshot("published", true, fleet({
    publishedViewers: 10,
    probes: 10,
    probesPublished: 10,
    probeMs: distribution(9),
    publishedSseAttempts: 1,
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H2"), "FAIL");
});

test("② FAILS rather than passes vacuously when the fleet resolved no snapshot at all", () => {
  // The dangerous shape: viewers that probed, 404'd, and made no further request. Origin traffic is
  // zero, so a naive check would report a triumphant PASS for a fleet that proved nothing.
  const result = evaluateSnapshot("published", true, fleet({
    publishedViewers: 200,
    probes: 200,
    probesNotPublished: 200,
    probeMs: distribution(8),
    edgeStatus404: { HIT: 200 },
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H2"), "FAIL");
  assert.match(result.breaches.join("\n"), /never resolved a snapshot/);
});

test("② is NOT MEASURED — never PASS — for a fleet with no published viewers", () => {
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 100,
    probes: 100,
    probesNotPublished: 100,
    probeMs: distribution(7),
    edgeStatus404: { HIT: 100 },
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H2"), "NOT MEASURED");
});

test("a live control tournament that is itself published breaches, invalidating the baseline", () => {
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 100,
    probes: 100,
    probesPublished: 100,
    liveFleetProbeHits: 100,
    probeMs: distribution(7),
  }), THRESHOLDS);

  assert.match(result.breaches.join("\n"), /not a live baseline/);
});

// ================================================================================ ④a probe cost

test("④a passes at the 25 ms budget and fails one millisecond past it", () => {
  const inside = evaluateSnapshot("live", true, fleet({
    liveViewers: 100, probes: 100, probesNotPublished: 100, probeMs: distribution(25),
    edgeStatus404: { HIT: 100 },
  }), THRESHOLDS);
  assert.equal(statusOf(inside.criteria, "H4a"), "PASS");

  const outside = evaluateSnapshot("live", true, fleet({
    liveViewers: 100, probes: 100, probesNotPublished: 100, probeMs: distribution(26),
    edgeStatus404: { HIT: 100 },
  }), THRESHOLDS);
  assert.equal(statusOf(outside.criteria, "H4a"), "FAIL");
  assert.match(outside.breaches.join("\n"), /exceeds the 25ms live-path budget/);
});

test("④a is NOT MEASURED when no probe was issued", () => {
  const result = evaluateSnapshot("live", true, fleet({ liveViewers: 100 }), THRESHOLDS);
  assert.equal(statusOf(result.criteria, "H4a"), "NOT MEASURED");
});

// ============================================================================= ④b edge caching

test("④b passes when the edge answered the repeat 404 lookups", () => {
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 100, probes: 100, probesNotPublished: 100, probeMs: distribution(6),
    edgeStatus404: { HIT: 98, MISS: 2 },
  }), THRESHOLDS);
  assert.equal(statusOf(result.criteria, "H4b"), "PASS");
});

test("④b excludes the cold first lookup, which is meant to MISS", () => {
  // One key, probed by many viewers: the first populates the edge's negative cache and misses by
  // design. Charging that against the ratio would penalise mitigation M1 for working — and with a
  // handful of viewers it would put the criterion permanently out of reach.
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 20, probes: 20, probesNotPublished: 20, probeMs: distribution(6),
    edgeStatus404: { HIT: 19 },
    edgeStatus404Cold: { MISS: 1 },
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H4b"), "PASS");
  const detail = result.criteria.find((c) => c.id === "H4b")!.detail;
  assert.match(detail, /19\/19 repeat 404 lookups were edge HITs/);
  assert.match(detail, /Excluded 1 cold first-lookup/);
});

test("④b is NOT MEASURED when every key was probed exactly once", () => {
  // Nothing was ever looked up twice, so the edge had no opportunity to answer from cache. That is
  // an absence of evidence, not evidence of a cold edge.
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 4, probes: 4, probesNotPublished: 4, probeMs: distribution(6),
    edgeStatus404Cold: { MISS: 4 },
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H4b"), "NOT MEASURED");
  assert.match(result.criteria.find((c) => c.id === "H4b")!.detail, /never had a repeat to answer from cache/);
  assert.deepEqual(result.breaches, []);
});

test("④b still FAILS when the warm lookups themselves miss the edge", () => {
  // The paired negative for the exclusion above: excluding cold lookups must not become a way for a
  // genuinely uncached edge to pass.
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 100, probes: 100, probesNotPublished: 100, probeMs: distribution(6),
    edgeStatus404: { HIT: 50, MISS: 49 },
    edgeStatus404Cold: { MISS: 1 },
  }), THRESHOLDS);
  assert.equal(statusOf(result.criteria, "H4b"), "FAIL");
});

test("④b FAILS when too many 404 probes reached the origin", () => {
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 100, probes: 100, probesNotPublished: 100, probeMs: distribution(6),
    edgeStatus404: { HIT: 60, MISS: 40 },
  }), THRESHOLDS);
  assert.equal(statusOf(result.criteria, "H4b"), "FAIL");
  assert.match(result.breaches.join("\n"), /edge HITs/);
});

test("④b reports NOT MEASURED when no cf-cache-status header was present", () => {
  // A bare origin (or a local stub) sends no such header. Treating that as a MISS would understate
  // the edge; treating it as a HIT would fabricate the gate's evidence. Neither is acceptable.
  const result = evaluateSnapshot("live", true, fleet({
    liveViewers: 100, probes: 100, probesNotPublished: 100, probeMs: distribution(6),
    edgeStatus404: { ABSENT: 100 },
  }), THRESHOLDS);

  assert.equal(statusOf(result.criteria, "H4b"), "NOT MEASURED");
  assert.deepEqual(result.breaches, []);
  assert.match(result.warnings.join("\n"), /no edge in front of the origin/);
});

// ==================================================================================== plumbing

test("no snapshot origin means no Phase H criteria are claimed at all", () => {
  const result = evaluateSnapshot("live", false, fleet({ liveViewers: 100 }), THRESHOLDS);
  assert.deepEqual(result.criteria, []);
  assert.deepEqual(result.breaches, []);
});
