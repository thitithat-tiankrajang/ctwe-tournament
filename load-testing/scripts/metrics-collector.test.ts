import assert from "node:assert/strict";
import test from "node:test";

import { MetricsCollector, type BackendSample } from "./metrics-collector.js";

/**
 * Stage summarisation, and specifically the one reading that cannot be trusted.
 *
 * A stage's first CPU sample is taken immediately after the previous stage's final sample, so
 * Micrometer computes the rate over a near-zero interval and returns something close to 1.0. That
 * single reading reached `cpuMax`, breached the 0.75 threshold, and turned stages with every stream
 * attached and zero errors into FAILs — including a published-fleet stage that sent the backend no
 * requests at all. The cases below pin the boundary: rate-derived readings drop that sample, and
 * everything else keeps it.
 */

const sample = (overrides: Partial<BackendSample>): BackendSample => ({
  at: new Date().toISOString(),
  ssePublicStreams: null, sseStaffStreams: null,
  processCpu: null, systemCpu: null, cpuCount: 1,
  heapUsedBytes: null, heapMaxBytes: null, nonHeapUsedBytes: null,
  metaspaceUsedBytes: null, metaspaceMaxBytes: null,
  processRssBytes: null, directBufferUsedBytes: null,
  gcPauseCount: null, gcPauseTotalSec: null, gcPauseMaxSec: null,
  liveThreads: null, hikariActive: null, hikariPending: null, hikariMax: null,
  tomcatBusyThreads: null, tomcatConnections: null,
  httpRequestCount: null, httpRequestTotalSec: null, httpRequestMaxSec: null,
  httpServerErrorCount: null,
  publicCardCacheHits: null, publicCardCacheMisses: null,
  ...overrides,
});

test("the stage's first CPU reading is excluded from cpuMax and cpuAvg", () => {
  // The real shape of the defect: 100% once, then a genuinely idle backend.
  const summary = MetricsCollector.summarize([
    sample({ processCpu: 1.0, systemCpu: 0.87 }),
    sample({ processCpu: 0.09 }),
    sample({ processCpu: 0.08 }),
    sample({ processCpu: 0.43 }),
  ], 130)!;
  assert.equal(summary.cpuMax, 0.43);
  assert.equal(summary.systemCpuMax, null, "the first sample's system reading goes with it");
  assert.equal(summary.cpuAvg, (0.09 + 0.08 + 0.43) / 3);
});

test("a sustained overload still fails — only the first sample is dropped, not high readings", () => {
  // Run 1's 1000-viewer collapse: the boundary artifact AND a real 95% mid-window. The real one
  // must survive, otherwise the fix would hide the only genuine capacity failure observed.
  const summary = MetricsCollector.summarize([
    sample({ processCpu: 1.0 }),
    sample({ processCpu: 0.07 }),
    sample({ processCpu: 0.95 }),
    sample({ processCpu: 0.39 }),
  ], 130)!;
  assert.equal(summary.cpuMax, 0.95);
});

test("level gauges and counter deltas keep every sample", () => {
  const summary = MetricsCollector.summarize([
    sample({ processCpu: 1.0, heapUsedBytes: 300, liveThreads: 70, httpRequestCount: 1000, publicCardCacheHits: 10 }),
    sample({ processCpu: 0.1, heapUsedBytes: 100, liveThreads: 30, httpRequestCount: 1200, publicCardCacheHits: 30 }),
  ], 100)!;
  // The peak heap and thread count occurred on the first sample and are real measurements.
  assert.equal(summary.heapUsedMaxBytes, 300);
  assert.equal(summary.liveThreadsMax, 70);
  // Deltas still span the whole window; starting from the second sample would undercount.
  assert.equal(summary.requestsPerSecond, 2);
  assert.equal(summary.publicCardCacheHits, 20);
});

test("a single-sample stage keeps its only reading rather than reporting nothing", () => {
  const summary = MetricsCollector.summarize([sample({ processCpu: 0.22 })], 10)!;
  assert.equal(summary.cpuMax, 0.22);
  assert.equal(summary.samples, 1);
});

test("no samples at all is null, not a zeroed summary", () => {
  assert.equal(MetricsCollector.summarize([], 10), null);
});
