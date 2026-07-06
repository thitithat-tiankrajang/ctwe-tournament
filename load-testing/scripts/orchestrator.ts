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
import { MetricsHub } from "../lib/metrics-hub.js";
import { evaluateStage, type Evaluation } from "../lib/evaluate.js";
import { Viewer } from "../scenarios/viewer-sse.js";
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

async function preflight(config: Config, collector: MetricsCollector) {
  const bundleUrl = new URL(
    `/api/public/tournaments/${encodeURIComponent(config.token)}/bundle`, config.publicApiOrigin);
  const response = await fetch(bundleUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Bundle preflight failed: HTTP ${response.status} for ${bundleUrl}`);
  const bundle = await response.json() as { id: string; name: string; cards: { id: string; name: string; division: string }[] };
  if (bundle.cards.length === 0) throw new Error("Tournament has no cards — viewers would idle. Seed a card first.");
  const cardIds = config.cardId ? [config.cardId] : bundle.cards.map((card) => card.id);

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
  return { tournament: { id: bundle.id, name: bundle.name }, cardIds, effectiveCap, heartbeatIntervalMs };
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
  if (info.effectiveCap !== null) {
    console.log(`Effective cap : ${info.effectiveCap} public SSE connections`);
    const top = config.stages[config.stages.length - 1].target;
    if (info.effectiveCap < top) {
      throw new Error(
        `Effective maxPublicSseConnections (${info.effectiveCap}) is below the top stage (${top}). `
        + "Start the backend with LOAD_TEST_MODE=true MAX_SSE_CONNECTIONS=" + top
        + " TOMCAT_MAX_CONNECTIONS=" + Math.ceil(top * 1.2) + " — see load-testing/README.md.",
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

  const viewers: Viewer[] = [];
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
      const viewer = new Viewer(id, { cardId: info.cardIds[id % info.cardIds.length] }, config, hub);
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
    const evaluation = evaluateStage(stage.target, client, backend, config.thresholds);
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

  const runbookPath = generateRunbook(runDir, config.reportsDir);
  console.log(`\nResults : ${runDir}`);
  console.log(`Runbook : ${runbookPath}`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
