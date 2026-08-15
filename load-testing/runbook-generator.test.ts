import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateRunbook } from "./runbook-generator.js";

/**
 * The Phase H section of the report.
 *
 * The report is the deliverable — the plan's acceptance is "all four measurements recorded in
 * `reports/runbook.md`" — so what has to be checked is that it states the truth in each case: that a
 * measurement nobody made is labelled NOT MEASURED rather than omitted or implied, that a failing
 * measurement says so, and that the ④ gate is only reported as satisfied when it actually is.
 */

interface Distribution { count: number; avg: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null }

const dist = (p95: number | null): Distribution =>
  p95 === null
    ? { count: 0, avg: null, p50: null, p95: null, p99: null, max: null }
    : { count: 10, avg: p95, p50: p95, p95, p99: p95, max: p95 };

function snapshotFleet(overrides: Record<string, unknown> = {}) {
  return {
    liveViewers: 0, publishedViewers: 0,
    probes: 0, probesPublished: 0, probesNotPublished: 0, probesTimedOut: 0, probesFailed: 0, probesUnusable: 0,
    liveFleetProbeHits: 0, probeMs: dist(null),
    publishedOriginRequests: 0, publishedSseAttempts: 0, publishedFallbacks: 0, liveOriginRequests: 0,
    cdnRequests: 0, cdnBytes: 0, edgeStatus200: {}, edgeStatus404: {},
    liveFirstDataMs: dist(null), publishedFirstDataMs: dist(null),
    ...overrides,
  };
}

function stage(target: number, options: {
  snapshot?: Record<string, unknown>;
  criteria?: { id: string; label: string; status: string; detail: string }[];
  cacheHitRatio?: number | null;
} = {}) {
  return {
    target,
    startedAt: "2026-08-15T00:00:00Z",
    finishedAt: "2026-08-15T00:02:00Z",
    client: {
      windowSeconds: 90, activeStreams: target, peakActiveStreams: target,
      sseRejected: 0, sseDropped: 0, sseStalled: 0, reconnects: 0, events: 0, heartbeats: 10,
      bytesReceived: 1000, httpRequests: target * 2, httpErrors: 0, httpRequestsPerSecond: 1,
      connectMs: dist(30), bootstrapMs: dist(80), httpRequestMs: dist(40), eventLatencyMs: dist(null),
      writeMs: dist(null), writes: 0, writeErrors: 0,
      snapshot: snapshotFleet(options.snapshot),
    },
    backend: {
      samples: 3, cpuAvg: 0.2, cpuMax: 0.3, systemCpuMax: 0.4, cpuCount: 2,
      heapUsedMaxBytes: 200 * 1024 * 1024, heapMaxBytes: 512 * 1024 * 1024,
      nonHeapUsedMaxBytes: 80 * 1024 * 1024, processRssMaxBytes: 350 * 1024 * 1024,
      directBufferUsedMaxBytes: 10 * 1024 * 1024, gcPauses: 2, gcPauseTotalSec: 0.05, gcPauseMaxSec: 0.03,
      liveThreadsMax: 60, hikariActiveMax: 2, hikariPendingMax: 0, hikariMax: 10,
      tomcatBusyMax: 5, tomcatConnectionsMax: 100, sseStreamsMax: target,
      requestsPerSecond: 5, serverAvgLatencyMs: 12, serverMaxLatencyMs: 40, serverErrors: 0,
      publicCardCacheHits: 900, publicCardCacheMisses: 100,
      publicCardCacheHitRatio: options.cacheHitRatio === undefined ? 0.9 : options.cacheHitRatio,
    },
    evaluation: { verdict: "PASS", breaches: [], warnings: [], snapshotCriteria: options.criteria ?? [] },
  };
}

function writeRun(dir: string, run: Record<string, unknown>): string {
  const runDir = path.join(dir, String(run.runId));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run));
  return runDir;
}

function baseRun(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    startedAt: "2026-08-15T00:00:00Z",
    finishedAt: "2026-08-15T00:10:00Z",
    aborted: null,
    target: {
      tournamentUrl: "https://ct-we.com/tour/live-cup",
      publicApiOrigin: "https://api.example.onrender.com",
      backendOrigin: "https://api.example.onrender.com",
      tournament: { id: "t-1", name: "Stub Cup" },
      cardIds: ["card-1"],
      effectiveCap: 2000,
      heartbeatIntervalMs: 25_000,
    },
    settings: {
      stages: [100], rampSeconds: 30, settleSeconds: 10, holdSeconds: 90, sampleSeconds: 5,
      thresholds: { maxProbeP95Ms: 25, minEdgeHitRatio: 0.95, maxLiveFirstDataRegressionMs: 25 },
      staffActivity: false, backendMetrics: true,
    },
    ...overrides,
  };
}

function withTempDirs(body: (dir: string, reports: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctwe-runbook-"));
  try {
    body(dir, path.join(dir, "reports"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a run with no Phase H configuration reports every measurement as unproven", () => {
  withTempDirs((dir, reports) => {
    const runDir = writeRun(dir, baseRun("run-live", {
      snapshot: {
        fleet: "live", configured: false, origin: null, probeOnLive: false, probeTimeoutMs: 1200,
        publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [], publishedSnapshots: [],
        baselineRunDir: null,
      },
      stages: [stage(100, { snapshot: { liveViewers: 100, liveFirstDataMs: dist(70) } })],
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports), "utf8");

    assert.match(report, /## Phase H — snapshot cutover measurements/);
    // ① is what this run IS; ②–④ have no evidence and must say so.
    assert.match(report, /\| ① \|[^|]+\| \*\*PASS\*\*/);
    assert.match(report, /\| ② \|[^|]+\| \*\*NOT MEASURED\*\*/);
    assert.match(report, /\| ③ \|[^|]+\| \*\*NOT MEASURED\*\*/);
    assert.match(report, /\| ④a \|[^|]+\| \*\*NOT MEASURED\*\*/);
    assert.match(report, /\| ④b \|[^|]+\| \*\*NOT MEASURED\*\*/);
    assert.match(report, /Phase I gate \(④\):\*\* NOT satisfied/);
  });
});

test("a clean published run records ② and ④ and reports the Phase I gate as satisfied", () => {
  withTempDirs((dir, reports) => {
    const criteria = [
      { id: "H2", label: "zero Render", status: "PASS", detail: "500 published viewer(s), 0 Render requests." },
      { id: "H4a", label: "probe p95", status: "PASS", detail: "p95 11 ms over 500 probe(s)." },
      { id: "H4b", label: "edge hits", status: "PASS", detail: "480/500 404 probes were edge HITs (96%)." },
    ];
    // Certifying shape: remote hosts, Actuator metrics present, more than one stage. Only such a run
    // is allowed to clear the gate.
    const runDir = writeRun(dir, baseRun("run-published", {
      settings: { ...baseRun("x").settings, stages: [250, 500] },
      snapshot: {
        fleet: "published", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 1, liveTokens: ["live-cup"], publishedTokens: ["pub-cup"],
        publishedSnapshots: [{ token: "pub-cup", url: "https://snapshot.ct-we.com/s/x.json", edgeStatus: "HIT" }],
        baselineRunDir: null,
      },
      stages: [250, 500].map((target) => stage(target, {
        criteria,
        snapshot: {
          publishedViewers: target, probes: target, probesPublished: target, probeMs: dist(11),
          edgeStatus200: { HIT: target }, edgeStatus404: { HIT: 480, MISS: 20 },
          publishedFirstDataMs: dist(30),
        },
      })),
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports), "utf8");

    assert.match(report, /\| ② \|[^|]+\| \*\*PASS\*\*/);
    assert.match(report, /\| ④a \|[^|]+\| \*\*PASS\*\*/);
    assert.match(report, /\| ④b \|[^|]+\| \*\*PASS\*\*/);
    assert.match(report, /Phase I gate \(④\):\*\* satisfied by this run/);
  });
});

test("one failing stage fails the whole criterion and blocks the gate", () => {
  withTempDirs((dir, reports) => {
    const runDir = writeRun(dir, baseRun("run-regressed", {
      settings: { ...baseRun("x").settings, stages: [100, 500] },
      snapshot: {
        fleet: "published", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 1, liveTokens: ["live-cup"], publishedTokens: ["pub-cup"],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [
        stage(100, { criteria: [{ id: "H4a", label: "probe p95", status: "PASS", detail: "p95 9 ms." }] }),
        stage(500, { criteria: [{ id: "H4a", label: "probe p95", status: "FAIL", detail: "p95 61 ms." }] }),
      ],
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports), "utf8");

    assert.match(report, /\| ④a \|[^|]+\| \*\*FAIL\*\* \|[^|]*Per-viewer added latency: FAIL — p95 61 ms/);
    assert.match(report, /Phase I gate \(④\):\*\* NOT satisfied/);
    assert.match(report, /Worker routing/);
  });
});

test("③ compares the mixed fleet against the baseline run in both directions", () => {
  withTempDirs((dir, reports) => {
    const baselineDir = writeRun(dir, baseRun("run-baseline", {
      snapshot: {
        fleet: "live", configured: false, origin: null, probeOnLive: false, probeTimeoutMs: 1200,
        publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [], publishedSnapshots: [],
        baselineRunDir: null,
      },
      stages: [stage(500, { cacheHitRatio: 0.62, snapshot: { liveViewers: 500, liveFirstDataMs: dist(80) } })],
    }));

    const improved = writeRun(dir, baseRun("run-mixed-good", {
      snapshot: {
        fleet: "mixed", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: ["pub-cup"],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(500, { cacheHitRatio: 0.81, snapshot: { liveViewers: 250, publishedViewers: 250, liveFirstDataMs: dist(84) } })],
    }));
    const goodReport = fs.readFileSync(generateRunbook(improved, reports, baselineDir), "utf8");
    assert.match(goodReport, /\| ③ \|[^|]+\| \*\*PASS\*\*/);
    assert.match(goodReport, /81%.*62%/);

    // Same comparison, worse numbers: a cache ratio that got worse must fail, not be narrated.
    const regressed = writeRun(dir, baseRun("run-mixed-bad", {
      snapshot: {
        fleet: "mixed", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: ["pub-cup"],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(500, { cacheHitRatio: 0.55, snapshot: { liveViewers: 250, publishedViewers: 250, liveFirstDataMs: dist(140) } })],
    }));
    const badReport = fs.readFileSync(generateRunbook(regressed, reports, baselineDir), "utf8");
    assert.match(badReport, /\| ③ \|[^|]+\| \*\*FAIL\*\*/);
    assert.match(badReport, /Δ \+60 ms/);
  });
});

test("④a is the paired live first-data delta when a probe-off baseline exists", () => {
  withTempDirs((dir, reports) => {
    const baselineDir = writeRun(dir, baseRun("run-baseline-probe-off", {
      snapshot: {
        fleet: "live", configured: false, origin: null, probeOnLive: false, probeTimeoutMs: 1200,
        publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [], publishedSnapshots: [],
        baselineRunDir: null,
      },
      stages: [stage(500, { snapshot: { liveViewers: 500, liveFirstDataMs: dist(210) } })],
    }));

    const probeOn = (liveP95: number, runId: string) => writeRun(dir, baseRun(runId, {
      settings: { ...baseRun("x").settings, stages: [250, 500] },
      snapshot: {
        fleet: "live", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [250, 500].map((target) => stage(target, {
        criteria: [{ id: "H4a", label: "added latency", status: "PASS", detail: "p95 9 ms." }],
        snapshot: { liveViewers: target, probes: target, probesNotPublished: target, probeMs: dist(9), liveFirstDataMs: dist(liveP95) },
      })),
    }));

    // Within budget: 218 − 210 = 8 ms.
    const good = fs.readFileSync(generateRunbook(probeOn(218, "run-probe-good"), reports, baselineDir), "utf8");
    assert.match(good, /\| ④a \|[^|]+\| \*\*PASS\*\*[^|]*\| Live p95-to-first-data 218 ms with the probe vs 210 ms without \(Δ \+8 ms, budget 25 ms\)/);

    // Over budget: 250 − 210 = 40 ms. The per-stage probe p95 is still a healthy 9 ms, so this can
    // only be caught by the paired comparison — which is exactly why §2.5(1) is stated as a delta.
    const bad = fs.readFileSync(generateRunbook(probeOn(250, "run-probe-bad"), reports, baselineDir), "utf8");
    assert.match(bad, /\| ④a \|[^|]+\| \*\*FAIL\*\*[^|]*\| Live p95-to-first-data 250 ms .*Δ \+40 ms/);
    assert.match(bad, /Phase I gate \(④\):\*\* NOT satisfied/);
  });
});

test("④a says so plainly when the paired delta could not be computed", () => {
  withTempDirs((dir, reports) => {
    const runDir = writeRun(dir, baseRun("run-no-control", {
      snapshot: {
        fleet: "live", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(500, {
        criteria: [{ id: "H4a", label: "added latency", status: "PASS", detail: "p95 9 ms." }],
        snapshot: { liveViewers: 500, probes: 500, probesNotPublished: 500, probeMs: dist(9), liveFirstDataMs: dist(218) },
      })],
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports), "utf8");
    assert.match(report, /Paired delta not computed\*\* \(no baseline run supplied\)/);
    // The single-run bound still stands on its own, so the row is not downgraded to NOT MEASURED.
    assert.match(report, /\| ④a \|[^|]+\| \*\*PASS\*\*/);
  });
});

test("a baseline that also probed is refused as a control", () => {
  withTempDirs((dir, reports) => {
    const badBaseline = writeRun(dir, baseRun("run-baseline-probe-on", {
      snapshot: {
        fleet: "live", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(500, { snapshot: { liveViewers: 500, liveFirstDataMs: dist(210) } })],
    }));
    const runDir = writeRun(dir, baseRun("run-probe-on", {
      snapshot: {
        fleet: "live", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(500, {
        criteria: [{ id: "H4a", label: "added latency", status: "PASS", detail: "p95 9 ms." }],
        snapshot: { liveViewers: 500, probes: 500, probesNotPublished: 500, probeMs: dist(9), liveFirstDataMs: dist(218) },
      })],
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports, badBaseline), "utf8");
    assert.match(report, /the baseline run also probed, so it is not a probe-off control/);
  });
});

test("③ without a baseline is NOT MEASURED rather than assumed", () => {
  withTempDirs((dir, reports) => {
    const runDir = writeRun(dir, baseRun("run-mixed-alone", {
      snapshot: {
        fleet: "mixed", configured: true, origin: "https://snapshot.ct-we.com", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: ["pub-cup"],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(500, { snapshot: { liveViewers: 250, publishedViewers: 250, liveFirstDataMs: dist(84) } })],
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports), "utf8");
    assert.match(report, /\| ③ \|[^|]+\| \*\*NOT MEASURED\*\*[^|]*\| No baseline run supplied/);
  });
});

test("the CLI writes where RESULTS_DIR/REPORTS_DIR say, not into the committed reports", () => {
  // Regression: cli() used to hardcode ./results and ./reports, so regenerating a report from a
  // scratch run overwrote reports/runbook.md — the committed record of the last real capacity run.
  withTempDirs((dir) => {
    const runDir = writeRun(dir, baseRun("run-cli", {
      snapshot: {
        fleet: "live", configured: false, origin: null, probeOnLive: false, probeTimeoutMs: 1200,
        publishedShare: 0.5, liveTokens: ["live-cup"], publishedTokens: [], publishedSnapshots: [],
        baselineRunDir: null,
      },
      stages: [stage(100, { snapshot: { liveViewers: 100, liveFirstDataMs: dist(70) } })],
    }));
    const reports = path.join(dir, "elsewhere");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const before = fs.readFileSync(path.join(here, "reports", "runbook.md"), "utf8");

    execFileSync(
      process.execPath,
      [path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(here, "runbook-generator.ts"), runDir],
      { env: { ...process.env, RESULTS_DIR: dir, REPORTS_DIR: reports }, stdio: "pipe" },
    );

    assert.ok(fs.existsSync(path.join(reports, "runbook.md")), "the report went to REPORTS_DIR");
    assert.equal(
      fs.readFileSync(path.join(here, "reports", "runbook.md"), "utf8"),
      before,
      "the committed runbook must not be touched",
    );
  });
});

test("a local run is marked as not certifying production", () => {
  withTempDirs((dir, reports) => {
    const runDir = writeRun(dir, baseRun("run-local", {
      target: { ...baseRun("x").target, backendOrigin: "http://localhost:8080", tournamentUrl: "http://localhost:3000/tour/live-cup" },
      snapshot: {
        fleet: "published", configured: true, origin: "http://127.0.0.1:9000", probeOnLive: true,
        probeTimeoutMs: 1200, publishedShare: 1, liveTokens: ["live-cup"], publishedTokens: ["pub-cup"],
        publishedSnapshots: [], baselineRunDir: null,
      },
      stages: [stage(5, {
        // Every gate criterion green — against three local stub servers that chose their own
        // cf-cache-status. The report must still refuse to call the gate satisfied.
        criteria: [
          { id: "H2", label: "zero Render", status: "PASS", detail: "5 published viewer(s)." },
          { id: "H4a", label: "probe p95", status: "PASS", detail: "p95 3 ms." },
          { id: "H4b", label: "edge hits", status: "PASS", detail: "5/5 404 probes were edge HITs (100%)." },
        ],
        snapshot: { publishedViewers: 5, probes: 5, probesPublished: 5, probeMs: dist(3), edgeStatus404: { HIT: 5 } },
      })],
    }));
    const report = fs.readFileSync(generateRunbook(runDir, reports), "utf8");
    assert.match(report, /does not certify anything about production/);
    // Green criteria on a stub stack must not read as clearance for Phase I.
    assert.match(report, /Phase I gate \(④\):\*\* NOT satisfied — ④a and ④b pass here/);
  });
});
