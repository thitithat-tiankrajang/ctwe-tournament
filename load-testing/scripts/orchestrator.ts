/**
 * The staged capacity run:
 *
 *   preflight -> for each stage: ramp viewers -> settle -> measure the hold window -> verdict
 *             -> results/<run>/run.json -> reports/runbook.md
 *
 * Stages only ever grow the fleet (a real audience does not disconnect between milestones), each
 * hold window is judged in isolation, and by default the run stops at the first FAILing stage —
 * numbers gathered while the server is already melting would only pollute the runbook.
 */
import fs from "node:fs";
import path from "node:path";
import { assertProductionGuard, loadConfig, type Config } from "../config.js";
import { snapshotUrl } from "../lib/snapshot-key.js";
import { MetricsHub } from "../lib/metrics-hub.js";
import { evaluateStage, type Evaluation } from "../lib/evaluate.js";
import { Viewer } from "../scenarios/viewer-sse.js";
import { SnapshotViewer } from "../scenarios/snapshot-viewer.js";
import { StaffActivity } from "../scenarios/staff-activity.js";
import { MetricsCollector, type BackendSample, type BackendWindowSummary } from "./metrics-collector.js";
import { generateRunbook } from "../runbook-generator.js";

interface StageRecord {
  target: number;
  startedAt: string;
  finishedAt: string;
  client: ReturnType<MetricsHub["snapshot"]>;
  backend: BackendWindowSummary | null;
  backendSamples: BackendSample[];
  evaluation: Evaluation;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One live tournament a live viewer can be assigned to. */
interface LiveTarget {
  token: string;
  id: string;
  name: string;
  cardIds: string[];
}

async function liveTarget(config: Config, token: string): Promise<LiveTarget> {
  const bundleUrl = new URL(
    `/api/public/tournaments/${encodeURIComponent(token)}/bundle`, config.publicApiOrigin);
  const response = await fetch(bundleUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Bundle preflight failed: HTTP ${response.status} for ${bundleUrl}`);
  const bundle = await response.json() as { id: string; name: string; cards: { id: string; name: string; division: string }[] };
  if (bundle.cards.length === 0) {
    throw new Error(`Tournament ${token} has no cards — viewers would idle. Seed a card first.`);
  }
  return {
    token,
    id: bundle.id,
    name: bundle.name,
    cardIds: config.cardId && token === config.token ? [config.cardId] : bundle.cards.map((card) => card.id),
  };
}

/**
 * Prove, before any load starts, that every token named as published really resolves a snapshot from
 * the CDN.
 *
 * Without this the most likely Phase H failure is also the quietest: a mistyped token, a retracted
 * tournament, or a key derivation that drifted from the browser's. Every viewer would 404, fail open
 * onto the live path, and the run would report a "published fleet" that was never published. Refusing
 * to start is the only way that mistake surfaces as a mistake.
 */
async function snapshotPreflight(config: Config): Promise<{ token: string; url: string; edgeStatus: string | null }[]> {
  const origin = config.snapshot.origin;
  if (!origin || config.snapshot.publishedTokens.length === 0) return [];
  const resolved: { token: string; url: string; edgeStatus: string | null }[] = [];
  for (const token of config.snapshot.publishedTokens) {
    const url = snapshotUrl(origin, token);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(
        `Snapshot preflight failed for "${token}": HTTP ${response.status} at ${url}. `
        + "PUBLISHED_TOKENS must list tournaments whose snapshot is actually published and reachable "
        + "through the public hostname — otherwise every published viewer falls through to the live "
        + "path and the zero-Render measurement is meaningless.",
      );
    }
    const envelope = await response.json() as { snapshot?: { schema?: number }; payload?: { cards?: unknown[] } };
    if (envelope?.snapshot?.schema !== 1 || !Array.isArray(envelope.payload?.cards)) {
      throw new Error(`Snapshot preflight failed for "${token}": ${url} is not a schema-1 snapshot envelope.`);
    }
    resolved.push({ token, url, edgeStatus: response.headers.get("cf-cache-status") });
  }
  return resolved;
}

async function preflight(config: Config, collector: MetricsCollector) {
  const liveTargets = await Promise.all(config.snapshot.liveTokens.map((token) => liveTarget(config, token)));
  const bundle = liveTargets[0];
  const cardIds = liveTargets.flatMap((target) => target.cardIds);
  const publishedSnapshots = await snapshotPreflight(config);

  // One probe stream proves SSE actually opens before we commit thousands of sockets.
  const probeUrl = new URL(`/api/public/cards/${cardIds[0]}/events`, config.publicApiOrigin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const probe = await fetch(probeUrl, { headers: { accept: "text/event-stream" }, signal: controller.signal });
  if (!probe.ok || !probe.body) throw new Error(`SSE preflight failed: HTTP ${probe.status} for ${probeUrl}`);
  const reader = probe.body.getReader();
  await reader.read(); // first bytes = the "connected" event
  await reader.cancel(); // actively close the probe instead of waiting for the next heartbeat
  clearTimeout(timer);
  controller.abort();

  let effectiveCap: number | null = null;
  let heartbeatIntervalMs: number | null = null;
  if (collector.available) {
    await collector.login();
    const settings = await collector.realtimeSettings();
    effectiveCap = settings?.maxPublicSseConnections ?? null;
    heartbeatIntervalMs = settings?.heartbeatIntervalMs ?? null;
  }
  return {
    tournament: { id: bundle.id, name: bundle.name },
    cardIds,
    liveTargets,
    publishedSnapshots,
    effectiveCap,
    heartbeatIntervalMs,
  };
}

/**
 * Which fleet the n-th viewer belongs to.
 *
 * Interleaved rather than blocked, so the mix holds throughout the ramp instead of appearing only
 * once the last viewer has joined — a stage that is aborted mid-ramp still describes a mixed fleet.
 */
function fleetFor(index: number, config: Config): "live" | "published" {
  if (config.snapshot.fleet === "live") return "live";
  if (config.snapshot.fleet === "published") return "published";
  const share = config.snapshot.publishedShare;
  return Math.floor((index + 1) * share) > Math.floor(index * share) ? "published" : "live";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  return `${Math.round(bytes / 1024 ** 2)}MB`;
}

function stageRow(record: StageRecord): string {
  const backend = record.backend;
  const cpu = backend?.cpuMax !== null && backend?.cpuMax !== undefined ? `${Math.round(backend.cpuMax * 100)}%` : "n/a";
  const heap = formatBytes(backend?.heapUsedMaxBytes ?? null);
  const errors = record.client.sseRejected + record.client.sseDropped + record.client.sseStalled;
  return [
    String(record.target).padStart(6),
    String(record.client.activeStreams).padStart(7),
    cpu.padStart(5),
    heap.padStart(8),
    String(errors).padStart(7),
    String(record.client.reconnects).padStart(6),
    `${record.client.connectMs.p95 ?? "-"}/${record.client.connectMs.p99 ?? "-"}ms`.padStart(13),
    record.evaluation.verdict,
  ].join("  ");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const preflightOnly = process.argv.includes("--preflight");
  const runId = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  const runDir = path.join(config.resultsDir, runId);

  console.log(`Target page   : ${config.tournamentUrl.href}`);
  console.log(`Public API    : ${config.publicApiOrigin.href}`);
  console.log(`Backend       : ${config.backendOrigin.href}`);
  console.log(`Stages        : ${config.stages.map((stage) => stage.target).join(" -> ")}`);
  console.log(`Stage timing  : ${config.rampSeconds}s ramp, ${config.settleSeconds}s settle, ${config.holdSeconds}s hold`);
  console.log(`Metric sample : every ${config.sampleSeconds}s (ramp + settle + hold)`);

  const hub = new MetricsHub(config.activityIntervalMs);
  const collector = new MetricsCollector(config);
  if (!collector.available) {
    console.warn("\nWARN: LOADTEST_ADMIN_USER/PASS not set — backend CPU/RAM/GC/pool metrics will be missing"
      + " and the runbook can only judge client-side signals.\n");
  }

  const info = await preflight(config, collector);
  console.log(`Tournament    : ${info.tournament.name} (${info.cardIds.length} card(s))`);
  console.log(`Fleet         : ${config.snapshot.fleet}`
    + (config.snapshot.fleet === "mixed" ? ` (${Math.round(config.snapshot.publishedShare * 100)}% published)` : ""));
  if (config.snapshot.origin) {
    console.log(`Snapshot CDN  : ${config.snapshot.origin.href} (probe on live path: ${config.snapshot.probeOnLive})`);
    for (const snapshot of info.publishedSnapshots) {
      console.log(`  published   : ${snapshot.token} -> ${snapshot.url}`
        + (snapshot.edgeStatus ? ` (cf-cache-status: ${snapshot.edgeStatus})` : " (no cf-cache-status header)"));
    }
  } else {
    console.log("Snapshot CDN  : not configured — this run is the Phase H ① live baseline");
  }
  const topStage = config.stages[config.stages.length - 1].target;
  // Only live viewers hold a stream, so only they consume the admission cap.
  const topLiveViewers = Array.from({ length: topStage }, (_, index) => fleetFor(index, config))
    .filter((fleet) => fleet === "live").length;
  if (info.effectiveCap !== null && topLiveViewers > 0) {
    console.log(`Effective cap : ${info.effectiveCap} public SSE connections`);
    if (info.effectiveCap < topLiveViewers) {
      throw new Error(
        `Effective maxPublicSseConnections (${info.effectiveCap}) is below the top stage's live viewer `
        + `count (${topLiveViewers}). Start the backend with LOAD_TEST_MODE=true MAX_SSE_CONNECTIONS=`
        + topLiveViewers + " TOMCAT_MAX_CONNECTIONS=" + Math.ceil(topLiveViewers * 1.2)
        + " — see load-testing/README.md.",
      );
    }
  }
  if (preflightOnly) {
    console.log("\nPreflight OK.");
    return;
  }
  assertProductionGuard(config);
  fs.mkdirSync(runDir, { recursive: true });

  const activity = new StaffActivity(config, hub);
  if (activity.enabled) {
    await activity.start();
    console.log(`Staff activity: rewriting match ${config.activityMatchId} every ${config.activityIntervalMs / 1000}s (fan-out latency measured)`);
  } else {
    console.log("Staff activity: disabled (set ACTIVITY_CARD_ID + ACTIVITY_MATCH_ID to measure fan-out latency)");
  }

  const viewers: (Viewer | SnapshotViewer)[] = [];
  // Round-robin over every (tournament, card) pair so a mixed fleet spreads across all live cards.
  const liveSlots = info.liveTargets.flatMap((target) =>
    target.cardIds.map((cardId) => ({ token: target.token, cardId })));
  const stopAll = () => {
    activity.stop();
    for (const viewer of viewers) viewer.stop();
  };
  process.on("SIGINT", () => {
    console.log("\nInterrupted — closing streams…");
    stopAll();
    process.exit(130);
  });

  const stageRecords: StageRecord[] = [];
  let aborted: string | null = null;
  console.log(`\n${"users".padStart(6)}  ${"active".padStart(7)}  ${"cpu".padStart(5)}  ${"heap".padStart(8)}  ${"errors".padStart(7)}  ${"reconn".padStart(6)}  ${"conn p95/p99".padStart(13)}  verdict`);

  for (const stage of config.stages) {
    // Reset before the ramp so connect p95/p99, bootstrap HTTP latency, rejections, and backend
    // resource spikes all belong to this stage. Resetting after the ramp would hide the exact
    // overload signals a capacity test is meant to find.
    hub.resetWindow();
    const samples: BackendSample[] = [];
    let collecting = true;
    const collect = (async () => {
      while (collecting) {
        const sample = await collector.sample();
        if (sample) samples.push(sample);
        if (collecting) await sleep(config.sampleSeconds * 1000);
      }
    })();
    const startedAt = new Date().toISOString();

    const toAdd = stage.target - viewers.length;
    const spacingMs = toAdd > 0 ? (config.rampSeconds * 1000) / toAdd : 0;
    for (let added = 0; added < toAdd; added += 1) {
      const id = viewers.length;
      const viewer = fleetFor(id, config) === "published"
        ? new SnapshotViewer(
          id,
          config.snapshot.publishedTokens[id % config.snapshot.publishedTokens.length],
          config,
          hub,
        )
        : new Viewer(id, liveSlots[id % liveSlots.length], config, hub);
      viewers.push(viewer);
      void viewer.start();
      if (spacingMs > 0) await sleep(spacingMs);
    }

    await sleep(config.settleSeconds * 1000);
    await sleep(config.holdSeconds * 1000);
    collecting = false;
    await collect;
    const finalSample = await collector.sample();
    if (finalSample) samples.push(finalSample);

    const client = hub.snapshot();
    const backend = MetricsCollector.summarize(samples, client.windowSeconds);
    const evaluation = evaluateStage(stage.target, client, backend, config.thresholds, {
      fleet: config.snapshot.fleet,
      configured: config.snapshot.origin !== null,
    });
    const record: StageRecord = {
      target: stage.target,
      startedAt,
      finishedAt: new Date().toISOString(),
      client,
      backend,
      backendSamples: samples,
      evaluation,
    };
    stageRecords.push(record);
    fs.writeFileSync(path.join(runDir, `stage-${String(stage.target).padStart(6, "0")}.json`), JSON.stringify(record, null, 2));
    console.log(stageRow(record));
    for (const breach of evaluation.breaches) console.log(`        ✗ ${breach}`);
    for (const warning of evaluation.warnings) console.log(`        ! ${warning}`);
    for (const criterion of evaluation.snapshotCriteria) {
      console.log(`        ${criterion.status === "PASS" ? "✓" : criterion.status === "FAIL" ? "✗" : "·"} `
        + `${criterion.id} ${criterion.status}: ${criterion.detail}`);
    }

    if (evaluation.verdict === "FAIL" && config.stopOnFail) {
      aborted = `stopped after first failing stage (${stage.target} viewers); set STOP_ON_FAIL=false to continue`;
      console.log(`\n${aborted}`);
      break;
    }
  }

  stopAll();
  await sleep(1_000);

  const run = {
    runId,
    startedAt: stageRecords[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    target: {
      tournamentUrl: config.tournamentUrl.href,
      publicApiOrigin: config.publicApiOrigin.href,
      backendOrigin: config.backendOrigin.href,
      tournament: info.tournament,
      cardIds: info.cardIds,
      effectiveCap: info.effectiveCap,
      heartbeatIntervalMs: info.heartbeatIntervalMs,
    },
    snapshot: {
      fleet: config.snapshot.fleet,
      configured: config.snapshot.origin !== null,
      origin: config.snapshot.origin?.href ?? null,
      probeOnLive: config.snapshot.probeOnLive,
      probeTimeoutMs: config.snapshot.probeTimeoutMs,
      publishedShare: config.snapshot.publishedShare,
      liveTokens: config.snapshot.liveTokens,
      publishedTokens: config.snapshot.publishedTokens,
      publishedSnapshots: info.publishedSnapshots,
      baselineRunDir: config.snapshot.baselineRunDir,
    },
    settings: {
      stages: config.stages.map((stage) => stage.target),
      rampSeconds: config.rampSeconds,
      settleSeconds: config.settleSeconds,
      holdSeconds: config.holdSeconds,
      sampleSeconds: config.sampleSeconds,
      thresholds: config.thresholds,
      staffActivity: activity.enabled,
      backendMetrics: collector.available,
    },
    aborted,
    stages: stageRecords,
  };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));

  const runbookPath = generateRunbook(runDir, config.reportsDir, config.snapshot.baselineRunDir);
  console.log(`\nResults : ${runDir}`);
  console.log(`Runbook : ${runbookPath}`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
