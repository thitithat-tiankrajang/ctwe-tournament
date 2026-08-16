/**
 * Converts one real staged run into reports/runbook.md.
 *
 * Recommendation policy is deliberately conservative and explicit:
 * - maximum observed = highest stage that did not FAIL;
 * - production SSE cap = highest clean PASS (NEAR LIMIT is evidence, not headroom);
 * - operating range = 80–100% of that cap;
 * - Render size = first current Render web-service shape keeping measured CPU and RSS below 70%.
 *
 * Local runs and runs without Actuator metrics are marked non-certifying instead of inventing a
 * server recommendation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Verdict = "PASS" | "NEAR LIMIT" | "FAIL";

interface Distribution {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

interface SnapshotFleetRecord {
  liveViewers: number;
  publishedViewers: number;
  probes: number;
  probesPublished: number;
  probesNotPublished: number;
  probesTimedOut: number;
  probesFailed: number;
  probesUnusable: number;
  liveFleetProbeHits: number;
  probeMs: Distribution;
  publishedOriginRequests: number;
  publishedSseAttempts: number;
  publishedFallbacks: number;
  liveOriginRequests: number;
  cdnRequests: number;
  cdnBytes: number;
  edgeStatus200: Record<string, number>;
  edgeStatus404: Record<string, number>;
  liveFirstDataMs: Distribution;
  publishedFirstDataMs: Distribution;
}

interface SnapshotCriterionRecord {
  id: string;
  label: string;
  status: "PASS" | "FAIL" | "NOT MEASURED";
  detail: string;
}

interface StageRecord {
  target: number;
  client: {
    windowSeconds: number;
    activeStreams: number;
    peakActiveStreams: number;
    sseRejected: number;
    sseDropped: number;
    sseStalled: number;
    reconnects: number;
    events: number;
    heartbeats: number;
    bytesReceived: number;
    httpRequests: number;
    httpErrors: number;
    httpRequestsPerSecond: number;
    connectMs: Distribution;
    bootstrapMs: Distribution;
    httpRequestMs: Distribution;
    eventLatencyMs: Distribution;
    writeMs: Distribution;
    writes: number;
    writeErrors: number;
    /** Absent in runs recorded before Phase H. */
    snapshot?: SnapshotFleetRecord;
  };
  backend: null | {
    samples: number;
    cpuAvg: number | null;
    cpuMax: number | null;
    systemCpuMax: number | null;
    cpuCount: number | null;
    heapUsedMaxBytes: number | null;
    heapMaxBytes: number | null;
    nonHeapUsedMaxBytes: number | null;
    processRssMaxBytes: number | null;
    directBufferUsedMaxBytes: number | null;
    gcPauses: number | null;
    gcPauseTotalSec: number | null;
    gcPauseMaxSec: number | null;
    liveThreadsMax: number | null;
    hikariActiveMax: number | null;
    hikariPendingMax: number | null;
    hikariMax: number | null;
    tomcatBusyMax: number | null;
    tomcatConnectionsMax: number | null;
    sseStreamsMax: number | null;
    requestsPerSecond: number | null;
    serverAvgLatencyMs: number | null;
    serverMaxLatencyMs: number | null;
    serverErrors: number | null;
    publicCardCacheHits?: number | null;
    publicCardCacheMisses?: number | null;
    publicCardCacheHitRatio?: number | null;
  };
  evaluation: {
    verdict: Verdict;
    breaches: string[];
    warnings: string[];
    snapshotCriteria?: SnapshotCriterionRecord[];
  };
}

interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  aborted: string | null;
  target: {
    tournamentUrl: string;
    publicApiOrigin: string;
    backendOrigin: string;
    tournament: { id: string; name: string };
    cardIds: string[];
    effectiveCap: number | null;
    heartbeatIntervalMs: number | null;
  };
  /** Absent in runs recorded before Phase H. */
  snapshot?: {
    fleet: "live" | "published" | "mixed";
    configured: boolean;
    origin: string | null;
    probeOnLive: boolean;
    probeTimeoutMs: number;
    publishedShare: number;
    liveTokens: string[];
    publishedTokens: string[];
    publishedSnapshots: { token: string; url: string; edgeStatus: string | null }[];
    baselineRunDir: string | null;
  };
  settings: {
    stages: number[];
    rampSeconds: number;
    settleSeconds?: number;
    holdSeconds: number;
    sampleSeconds: number;
    thresholds: Record<string, number>;
    staffActivity: boolean;
    backendMetrics: boolean;
  };
  stages: StageRecord[];
}

interface RenderShape {
  name: string;
  cpu: number;
  ramMb: number;
}

// Current Render web-service instance types:
// https://render.com/docs/compute-plans (checked 2026-07-06).
const RENDER_SHAPES: RenderShape[] = [
  { name: "Starter", cpu: 0.5, ramMb: 512 },
  { name: "Standard", cpu: 1, ramMb: 2_048 },
  { name: "Pro", cpu: 2, ramMb: 4_096 },
  { name: "Pro Plus", cpu: 4, ramMb: 8_192 },
  { name: "Pro Max", cpu: 4, ramMb: 16_384 },
  { name: "Pro Ultra", cpu: 8, ramMb: 32_768 },
];

const mb = (bytes: number | null | undefined) => bytes == null ? null : bytes / 1_048_576;
const fmt = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const ms = (value: number | null | undefined) => value == null ? "—" : `${fmt(value, 0)} ms`;
const pct = (value: number | null | undefined) => value == null ? "—" : `${fmt(value * 100, 1)}%`;
const localHost = (raw: string) => {
  const host = new URL(raw).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
};

function latestRunDir(resultsDir: string): string {
  if (!fs.existsSync(resultsDir)) throw new Error(`Results directory does not exist: ${resultsDir}`);
  const candidates = fs.readdirSync(resultsDir)
    .map((name) => path.join(resultsDir, name))
    .filter((entry) => fs.existsSync(path.join(entry, "run.json")))
    .sort();
  const latest = candidates.at(-1);
  if (!latest) throw new Error(`No run.json found under ${resultsDir}`);
  return latest;
}

function recommendShape(stage: StageRecord | undefined): { shape: RenderShape | null; reason: string } {
  const backend = stage?.backend;
  if (!backend || backend.cpuMax == null || backend.cpuCount == null) {
    return { shape: null, reason: "Actuator CPU metrics were unavailable." };
  }
  const measuredCores = backend.cpuMax * backend.cpuCount;
  const requiredCpu = measuredCores / 0.70;
  const measuredRamMb = mb(backend.processRssMaxBytes)
    ?? ((mb(backend.heapUsedMaxBytes) ?? 0) + (mb(backend.nonHeapUsedMaxBytes) ?? 0)
      + (mb(backend.directBufferUsedMaxBytes) ?? 0));
  if (!measuredRamMb) return { shape: null, reason: "A real process/JVM memory sample was unavailable." };
  // RSS is complete process memory; JVM-only fallback receives extra native-memory headroom.
  const requiredRamMb = backend.processRssMaxBytes != null ? measuredRamMb / 0.70 : measuredRamMb / 0.55;
  const shape = RENDER_SHAPES.find((candidate) =>
    candidate.cpu >= requiredCpu && candidate.ramMb >= requiredRamMb) ?? null;
  const source = backend.processRssMaxBytes != null ? "process RSS" : "JVM memory fallback";
  return {
    shape,
    reason: `Measured ${measuredCores.toFixed(2)} CPU cores and ${measuredRamMb.toFixed(0)} MiB ${source}; sizing keeps both below 70%.`,
  };
}

function stageTable(run: RunRecord): string[] {
  const lines = [
    "| Viewers | Active SSE | CPU max | Process RAM | Heap max | HTTP avg / p95 / p99 | SSE connect p95 / p99 | HTTP errors | Reconnects | Viewer HTTP RPS | Verdict |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|",
  ];
  for (const stage of run.stages) {
    const errors = stage.client.sseRejected + stage.client.sseDropped + stage.client.sseStalled;
    const ram = mb(stage.backend?.processRssMaxBytes);
    lines.push(`| ${stage.target} | ${stage.client.activeStreams} | ${pct(stage.backend?.cpuMax)} | ${ram == null ? "—" : `${fmt(ram, 0)} MiB`} | ${stage.backend?.heapUsedMaxBytes == null ? "—" : `${fmt(mb(stage.backend.heapUsedMaxBytes), 0)} MiB`} | ${ms(stage.client.httpRequestMs.avg)} / ${ms(stage.client.httpRequestMs.p95)} / ${ms(stage.client.httpRequestMs.p99)} | ${ms(stage.client.connectMs.p95)} / ${ms(stage.client.connectMs.p99)} | ${stage.client.httpErrors + errors} | ${stage.client.reconnects} | ${fmt(stage.client.httpRequestsPerSecond)} | **${stage.evaluation.verdict}** |`);
  }
  return lines;
}

function resourceTable(run: RunRecord): string[] {
  const lines = [
    "| Viewers | GC pauses / total | Longest GC | Threads | Tomcat busy / conn | Hikari active / pending / max | Events | Fan-out p95 |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const stage of run.stages) {
    const b = stage.backend;
    lines.push(`| ${stage.target} | ${fmt(b?.gcPauses, 0)} / ${b?.gcPauseTotalSec == null ? "—" : `${fmt(b.gcPauseTotalSec, 3)} s`} | ${b?.gcPauseMaxSec == null ? "—" : ms(b.gcPauseMaxSec * 1_000)} | ${fmt(b?.liveThreadsMax, 0)} | ${fmt(b?.tomcatBusyMax, 0)} / ${fmt(b?.tomcatConnectionsMax, 0)} | ${fmt(b?.hikariActiveMax, 0)} / ${fmt(b?.hikariPendingMax, 0)} / ${fmt(b?.hikariMax, 0)} | ${stage.client.events} | ${ms(stage.client.eventLatencyMs.p95)} |`);
  }
  return lines;
}

function details(run: RunRecord): string[] {
  const lines: string[] = [];
  for (const stage of run.stages) {
    if (stage.evaluation.breaches.length === 0 && stage.evaluation.warnings.length === 0) continue;
    lines.push(`- **${stage.target} viewers — ${stage.evaluation.verdict}:**`);
    for (const item of stage.evaluation.breaches) lines.push(`  - Breach: ${item}`);
    for (const item of stage.evaluation.warnings) lines.push(`  - Warning: ${item}`);
  }
  return lines.length ? lines : ["- No threshold breaches or near-limit warnings were recorded."];
}

// ------------------------------------------------------------------ Phase H (snapshot cutover)

type CriterionStatus = "PASS" | "FAIL" | "NOT MEASURED";

/** The worst status any stage recorded for one criterion — a single failing stage fails it. */
function worstCriterion(run: RunRecord, id: string): SnapshotCriterionRecord | null {
  const found = run.stages
    .flatMap((stage) => stage.evaluation.snapshotCriteria ?? [])
    .filter((criterion) => criterion.id === id);
  if (found.length === 0) return null;
  return found.find((c) => c.status === "FAIL")
    ?? found.find((c) => c.status === "NOT MEASURED")
    ?? found[found.length - 1];
}

/** The stage of `run` that best corresponds to `stage`, preferring an identical viewer target. */
function pairedStage(run: RunRecord, target: number): StageRecord | undefined {
  return run.stages.find((stage) => stage.target === target) ?? run.stages.at(-1);
}

function loadBaseline(baselineRunDir: string | null): RunRecord | null {
  if (!baselineRunDir) return null;
  const runPath = path.join(baselineRunDir, "run.json");
  if (!fs.existsSync(runPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(runPath, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

/**
 * Measurement ③ — the mixed fleet.
 *
 * Two claims, both compared against the baseline run rather than against intuition: publishing some
 * tournaments must improve the public-card cache hit ratio for the tournaments still live (fewer
 * distinct cards competing for a cache whose maximum size is 8), and it must not make the live
 * viewers slower.
 */
function mixedFleetFinding(run: RunRecord, baseline: RunRecord | null, thresholds: Record<string, number>) {
  if (run.snapshot?.fleet !== "mixed") {
    return { status: "NOT MEASURED" as CriterionStatus, detail: `This run's fleet is \`${run.snapshot?.fleet ?? "live"}\`; ③ needs FLEET=mixed.` };
  }
  if (!baseline) {
    return { status: "NOT MEASURED" as CriterionStatus, detail: "No baseline run supplied (set BASELINE_RUN_DIR to a ① run) — there is nothing to compare against." };
  }
  const stage = run.stages.at(-1);
  const control = stage ? pairedStage(baseline, stage.target) : undefined;
  if (!stage || !control) {
    return { status: "NOT MEASURED" as CriterionStatus, detail: "The mixed run or the baseline has no comparable stage." };
  }

  const mixedP95 = stage.client.snapshot?.liveFirstDataMs.p95 ?? null;
  const baseP95 = control.client.snapshot?.liveFirstDataMs.p95 ?? control.client.bootstrapMs.p95 ?? null;
  const mixedRatio = stage.backend?.publicCardCacheHitRatio ?? null;
  const baseRatio = control.backend?.publicCardCacheHitRatio ?? null;
  const budget = thresholds.maxLiveFirstDataRegressionMs ?? 25;

  const parts: string[] = [];
  let status: CriterionStatus = "PASS";
  if (mixedP95 === null || baseP95 === null) {
    parts.push("live p95-to-first-data could not be compared (one side has no sample)");
    status = "NOT MEASURED";
  } else {
    const delta = mixedP95 - baseP95;
    parts.push(`live p95-to-first-data ${mixedP95} ms vs baseline ${baseP95} ms (Δ ${delta >= 0 ? "+" : ""}${delta} ms, budget ${budget} ms)`);
    if (delta > budget) status = "FAIL";
  }
  if (mixedRatio === null || baseRatio === null) {
    parts.push("Caffeine hit ratio unavailable (Actuator metrics absent)");
    if (status !== "FAIL") status = "NOT MEASURED";
  } else {
    parts.push(`public-card cache hit ratio ${pct(mixedRatio)} vs baseline ${pct(baseRatio)}`);
    if (mixedRatio < baseRatio && status !== "FAIL") status = "FAIL";
  }
  return { status, detail: `${parts.join("; ")}. Baseline run: \`${baseline.runId}\`.` };
}

/**
 * Measurement ④a — the probe's cost on the live path, as §2.5(1) states it.
 *
 * The criterion is a **delta**: live p95-to-first-data with the probe, against the same load without
 * it. That needs two runs, so it is computed here and treated as authoritative whenever a probe-off
 * baseline is available. The per-stage signal (the probe's own p95, which is exactly what each live
 * viewer additionally waits for) is a single-run proxy and is reported alongside; both must hold,
 * because either one failing means the live path got slower.
 */
function probeCostFinding(
  run: RunRecord,
  baseline: RunRecord | null,
  thresholds: Record<string, number>,
  perStage: SnapshotCriterionRecord | null,
) {
  const budget = thresholds.maxProbeP95Ms ?? 25;
  const stage = run.stages.at(-1);
  const control = stage ? pairedStage(baseline ?? run, stage.target) : undefined;
  const runP95 = stage?.client.snapshot?.liveFirstDataMs.p95 ?? null;
  const baseP95 = baseline ? control?.client.snapshot?.liveFirstDataMs.p95 ?? null : null;

  const proxy = perStage
    ? `Per-viewer added latency: ${perStage.status} — ${perStage.detail}`
    : "Per-viewer added latency was not measured.";

  // A paired delta needs a probe-on run with live viewers and a probe-off baseline. Anything else
  // would be comparing two different things and calling the difference a cost.
  const comparable = baseline !== null
    && run.snapshot?.probeOnLive === true
    && baseline.snapshot?.probeOnLive !== true
    && runP95 !== null
    && baseP95 !== null;

  if (!comparable) {
    const why = baseline === null
      ? "no baseline run supplied"
      : run.snapshot?.probeOnLive !== true
        ? "this run issued no probe on the live path"
        : baseline.snapshot?.probeOnLive === true
          ? "the baseline run also probed, so it is not a probe-off control"
          : "one side recorded no live-path first-data sample (a fleet with no live viewers)";
    return {
      status: (perStage?.status ?? "NOT MEASURED") as CriterionStatus,
      detail: `**Paired delta not computed** (${why}), so only the single-run bound is available. ${proxy}`,
    };
  }

  const delta = runP95! - baseP95!;
  const failed = delta > budget || perStage?.status === "FAIL";
  return {
    status: (failed ? "FAIL" : "PASS") as CriterionStatus,
    detail: `Live p95-to-first-data ${runP95} ms with the probe vs ${baseP95} ms without `
      + `(Δ ${delta >= 0 ? "+" : ""}${delta} ms, budget ${budget} ms), baseline run \`${baseline!.runId}\`. ${proxy}`,
  };
}

function phaseHSection(run: RunRecord, baseline: RunRecord | null, certifying: boolean): string[] {
  const snapshot = run.snapshot;
  if (!snapshot) {
    return [
      "## Phase H — snapshot cutover measurements",
      "",
      "This run predates Phase H instrumentation; none of the four measurements are present.",
      "",
    ];
  }

  const rows: { id: string; measurement: string; status: CriterionStatus; detail: string }[] = [];

  // ① the live baseline
  const isBaselineRun = snapshot.fleet === "live" && !snapshot.probeOnLive;
  const last = run.stages.at(-1);
  rows.push({
    id: "①",
    measurement: "Baseline — live tournament, today's numbers",
    status: isBaselineRun ? "PASS" : baseline ? "PASS" : "NOT MEASURED",
    detail: isBaselineRun
      ? `This run is the baseline: FLEET=live with no probe. Live p95-to-first-data ${ms(last?.client.snapshot?.liveFirstDataMs.p95)}, ${last?.client.activeStreams ?? 0} active SSE at ${last?.target ?? 0} viewers.`
      : baseline
        ? `Taken from baseline run \`${baseline.runId}\`: live p95-to-first-data ${ms(pairedStage(baseline, last?.target ?? 0)?.client.snapshot?.liveFirstDataMs.p95)}.`
        : "No baseline recorded in or referenced by this run. Run once with SNAPSHOT_ORIGIN unset and pass that directory as BASELINE_RUN_DIR.",
  });

  // ② published fleet
  const h2 = worstCriterion(run, "H2");
  rows.push({
    id: "②",
    measurement: "Published fleet — zero Render requests, zero SSE connections",
    status: h2?.status ?? "NOT MEASURED",
    detail: h2?.detail ?? "No published viewers were run.",
  });

  // ③ mixed fleet
  const h3 = mixedFleetFinding(run, baseline, run.settings.thresholds);
  rows.push({
    id: "③",
    measurement: "Mixed fleet — live cache hit ratio improves, live p95 does not regress",
    status: h3.status,
    detail: h3.detail,
  });

  // ④ probe cost — the hard gate on Phase I
  const h4a = worstCriterion(run, "H4a");
  const h4b = worstCriterion(run, "H4b");
  const probeCost = probeCostFinding(run, baseline, run.settings.thresholds, h4a);
  rows.push({
    id: "④a",
    measurement: "Live-path p95-to-first-data does not regress (hard gate on Phase I)",
    status: probeCost.status,
    detail: probeCost.detail,
  });
  rows.push({
    id: "④b",
    measurement: "404 probes served from the Cloudflare edge (hard gate on Phase I)",
    status: h4b?.status ?? "NOT MEASURED",
    detail: h4b?.detail ?? "No 404 probes were observed.",
  });

  const gateBlocked = rows.filter((row) => row.id.startsWith("④") && row.status !== "PASS");
  const anyFail = rows.some((row) => row.status === "FAIL");

  const lines = [
    "## Phase H — snapshot cutover measurements",
    "",
    `- **Fleet:** \`${snapshot.fleet}\`${snapshot.fleet === "mixed" ? ` (${Math.round(snapshot.publishedShare * 100)}% published viewers)` : ""}`,
    `- **Snapshot origin:** ${snapshot.origin ?? "not configured"}`,
    `- **Probe on the live path:** ${snapshot.probeOnLive ? `yes, ${snapshot.probeTimeoutMs} ms timeout` : "no"}`,
    `- **Live tournaments:** ${snapshot.liveTokens.map((token) => `\`${token}\``).join(", ") || "—"}`,
    `- **Published tournaments:** ${snapshot.publishedTokens.map((token) => `\`${token}\``).join(", ") || "—"}`,
    `- **Baseline run:** ${baseline ? `\`${baseline.runId}\`` : "none supplied"}`,
    "",
    "| # | Measurement | Status | Evidence |",
    "|:--|:--|:--|:--|",
    ...rows.map((row) => `| ${row.id} | ${row.measurement} | **${row.status}** | ${row.detail} |`),
    "",
    // A non-certifying run can never clear the gate, however green its criteria look. A local stub
    // decides for itself what `cf-cache-status` to send, so ④b passing there says nothing about any
    // edge; letting that read as "satisfied" is precisely the misreading this line exists to stop.
    `**Phase I gate (④):** ${gateBlocked.length > 0
      ? `NOT satisfied — ${gateBlocked.map((row) => `${row.id} is ${row.status}`).join(", ")}. Phase I must not proceed on this evidence.`
      : certifying
        ? "satisfied by this run."
        : "NOT satisfied — ④a and ④b pass here, but this run is local or metrics-incomplete, so it "
          + "cannot clear a gate about production edge behaviour. Re-run against staging behind the "
          + "real CDN."}`,
    "",
  ];

  if (!certifying) {
    lines.push(
      "> **This run does not certify anything about production.** It targets a local or "
      + "metrics-incomplete stack, so the numbers above validate the harness and the client's request "
      + "behaviour, not the capacity or edge behaviour of the real deployment. Measurement ④b in "
      + "particular can only be answered by a real Cloudflare edge in front of the public bucket.",
      "",
    );
  }
  if (anyFail) {
    lines.push(
      "> A **FAIL** above is a measurement result, not a harness error. Architecture §2.5 makes ④ a "
      + "precondition for the cutover: if the probe regresses the live path, the documented fallback "
      + "is Worker routing (§2.2 option C), which reuses the identical client change and only moves "
      + "the signal's source.",
      "",
    );
  }

  lines.push(
    "### Per-stage snapshot metrics",
    "",
    "| Viewers | Live / published | Probes (200 / 404 / timeout / error) | Probe p95 | Live first data p95 | Published first data p95 | Published Render req | Published SSE | Edge status (404) | Cache hit ratio |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|:--|---:|",
  );
  for (const stage of run.stages) {
    const s = stage.client.snapshot;
    if (!s) continue;
    const edge = Object.entries(s.edgeStatus404).map(([key, count]) => `${key}=${count}`).join(", ") || "—";
    lines.push(`| ${stage.target} | ${s.liveViewers} / ${s.publishedViewers} | ${s.probesPublished} / ${s.probesNotPublished} / ${s.probesTimedOut} / ${s.probesFailed + s.probesUnusable} | ${ms(s.probeMs.p95)} | ${ms(s.liveFirstDataMs.p95)} | ${ms(s.publishedFirstDataMs.p95)} | ${s.publishedOriginRequests} | ${s.publishedSseAttempts} | ${edge} | ${stage.backend?.publicCardCacheHitRatio == null ? "—" : pct(stage.backend.publicCardCacheHitRatio)} |`);
  }
  lines.push("");
  return lines;
}

function renderRunbook(run: RunRecord, runDir: string, baseline: RunRecord | null): string {
  const nonFail = run.stages.filter((stage) => stage.evaluation.verdict !== "FAIL");
  const clean = run.stages.filter((stage) => stage.evaluation.verdict === "PASS");
  const maximumObserved = nonFail.at(-1);
  const recommended = clean.at(-1);
  const firstFailure = run.stages.find((stage) => stage.evaluation.verdict === "FAIL");
  const local = localHost(run.target.backendOrigin) || localHost(run.target.tournamentUrl);
  const certifying = !local && run.settings.backendMetrics && run.stages.length >= 2;
  const cap = certifying ? recommended?.target ?? null : null;
  const operatingLow = cap == null ? null : Math.max(1, Math.floor(cap * 0.8));
  const sizing = recommendShape(recommended);
  const sizingReason = certifying
    ? sizing.reason
    : "Render sizing and production SSE recommendations are intentionally withheld for local or metrics-incomplete runs.";
  const reachedBoundary = Boolean(firstFailure || run.stages.some((stage) => stage.evaluation.verdict === "NEAR LIMIT"));
  const maxWording = maximumObserved
    ? `${maximumObserved.target} viewers / ${maximumObserved.client.activeStreams} active SSE`
    : "No safe stage observed";
  const shapeWording = !certifying
    ? "Not certifiable from this run"
    : sizing.shape
      ? `${sizing.shape.name} — ${sizing.shape.cpu} CPU / ${fmt(sizing.shape.ramMb / 1024, 1)} GB RAM`
      : "Larger/custom instance or another measured run required";

  const lines = [
    "# CTWE production performance runbook",
    "",
    `Generated from real run \`${run.runId}\` on ${run.finishedAt}.`,
    "",
    "## Executive recommendation",
    "",
    `- **Run classification:** ${certifying ? "production/staging capacity evidence" : "LOCAL/INCOMPLETE SMOKE RUN — validates the harness, not production capacity"}`,
    `- **Maximum concurrent viewers observed without hard failure:** ${maxWording}`,
    `- **Recommended \`maxSseConnections\`:** ${cap ?? "not available"}`,
    `- **Recommended operating range:** ${operatingLow != null && cap != null ? `${operatingLow}–${cap} concurrent SSE viewers` : "not available"}`,
    `- **Recommended minimum Render instance:** ${shapeWording}`,
    `- **Boundary confidence:** ${reachedBoundary ? "A near-limit or failing boundary was observed." : "Only a lower bound was measured; extend STAGES until NEAR LIMIT/FAIL before treating this as a maximum."}`,
    `- **Test stopped early:** ${run.aborted ?? "no"}`,
    "",
    "Reasoning:",
    "",
    `- The SSE recommendation uses the highest clean PASS stage; NEAR LIMIT stages are intentionally excluded from production headroom.`,
    `- ${sizingReason}`,
    `- CPU, heap, GC, threads, Hikari, Tomcat, and SSE occupancy come from authenticated Spring Boot Actuator metrics. Process RAM uses Linux kernel RSS when available.`,
    "",
    "## Stage results",
    "",
    ...stageTable(run),
    "",
    "Errors in the table combine finite HTTP failures with SSE rejections, drops, and stalls.",
    "",
    "## Backend resource detail",
    "",
    ...resourceTable(run),
    "",
    ...phaseHSection(run, baseline, certifying),
    "## Threshold findings",
    "",
    ...details(run),
    "",
    "## Test identity and method",
    "",
    `- Tournament: **${run.target.tournament.name}** (\`${run.target.tournament.id}\`)`,
    `- Viewer page: \`${run.target.tournamentUrl}\``,
    `- Public API: \`${run.target.publicApiOrigin}\``,
    `- Backend metrics origin: \`${run.target.backendOrigin}\``,
    `- Cards distributed across viewers: ${run.target.cardIds.map((id) => `\`${id}\``).join(", ")}`,
    `- Effective backend SSE cap at preflight: ${run.target.effectiveCap ?? "not observable (admin metrics credentials absent)"}`,
    `- Heartbeat interval: ${run.target.heartbeatIntervalMs == null ? "not observable" : `${run.target.heartbeatIntervalMs} ms`}`,
    `- Stages: ${run.settings.stages.join(" → ")}`,
    `- Per-stage timing: ${run.settings.rampSeconds}s ramp + ${run.settings.settleSeconds ?? 0}s settle + ${run.settings.holdSeconds}s hold`,
    `- Staff result activity: ${run.settings.staffActivity ? "enabled (real result events and fan-out latency)" : "disabled"}`,
    `- Raw result directory: \`${runDir}\``,
    "",
    "Each viewer fetches the real tournament document, realtime config, and one-shot tournament bundle, then holds one EventSource-compatible SSE connection for its selected card. The harness parses SSE frames, honors server retry hints, watches heartbeats, and reconnects with capped jittered backoff.",
    "",
    "## Production operating procedure",
    "",
    "### Before an event",
    "",
    "1. Run the full suite against a staging deployment with the same Render instance type, JVM flags, database plan, cache settings, and network path as production.",
    "2. Set `LOAD_TEST_MODE=true`, `MAX_SSE_CONNECTIONS` at least 20% above the highest stage, and `TOMCAT_MAX_CONNECTIONS` at least 20% above that. Never enable load-test mode on an event currently serving real viewers.",
    "3. Use an OPEN tournament with published cards. If fan-out latency is required, use a dedicated `RESULT_COLLECTION` card and dedicated staff account.",
    "4. Confirm Render, Neon, and application dashboards are open. Record deployment ID, instance type, DB plan, region, and test-generator location.",
    "5. Run `npm run loadtest`. Do not certify from a local smoke run or a run without Actuator metrics.",
    "",
    "### Production configuration",
    "",
    `- Start with \`maxPublicSseConnections=${cap ?? "<highest clean PASS>"}\`.`,
    `- Set Tomcat max connections to at least \`${cap == null ? "ceil(maxSseConnections × 1.20)" : Math.ceil(cap * 1.2)}\` so staff/API/health traffic retains headroom.`,
    "- Keep heartbeat below proxy idle timeouts and above the level that creates excessive fan-out work; the measured value is shown above.",
    "- Keep `LOAD_TEST_MODE=false` in normal production. The admin-managed cap and its production ceiling remain authoritative.",
    "",
    "### Live stop conditions",
    "",
    "- CPU remains above 75%, process RAM above 70%, or heap above 70% of max for two samples.",
    "- Any sustained HTTP 5xx, growing SSE drops/stalls, or reconnect churn above the configured threshold.",
    "- Hikari pending connections become non-zero, GC pauses exceed 1 second, or Tomcat busy threads/connections stop recovering.",
    "- Active SSE no longer reaches 99% of target after the settle window.",
    "",
    "### Incident response",
    "",
    "1. **Reconnect storm:** stop result-generating traffic, confirm heartbeats and proxy timeouts, then lower admission cap only for new streams. Do not restart repeatedly.",
    "2. **SSE capacity rejection:** viewers retry automatically; preserve capacity for staff writes and raise the cap only when Tomcat, CPU, and RAM headroom all permit it.",
    "3. **Memory pressure:** capture heap/native-memory diagnostics, reduce the admission cap, and vertically scale. RSS materially above heap+nonheap usually indicates native buffers, thread stacks, or libraries.",
    "4. **Database pressure:** if Hikari pending is non-zero, inspect Neon latency/connections before increasing the pool. More pool connections can amplify database contention.",
    "5. **Backend replacement/redeploy:** drain gracefully; established EventSource clients reconnect. Watch reconnect rate and 5xx until active streams recover.",
    "",
    "## Interpretation limits",
    "",
    "- One load generator represents one source region/IP and can itself become the bottleneck at very high socket counts; repeat from a suitably sized runner or distributed runners.",
    "- Render dashboard host metrics and Neon metrics should corroborate Actuator. This report never fabricates missing values.",
    "- A highest PASS with no following NEAR LIMIT/FAIL is a tested lower bound, not the true maximum.",
    "- Render instance names/specs are based on the official compute-plan table checked 2026-07-06; verify the current table before purchasing.",
    "",
  ];
  return lines.join("\n");
}

export function generateRunbook(runDir: string, reportsDir: string, baselineRunDir: string | null = null): string {
  const runPath = path.join(runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`Missing run artifact: ${runPath}`);
  const run = JSON.parse(fs.readFileSync(runPath, "utf8")) as RunRecord;
  if (!Array.isArray(run.stages) || run.stages.length === 0)
    throw new Error(`Run has no completed stages: ${runPath}`);
  fs.mkdirSync(reportsDir, { recursive: true });
  const baseline = loadBaseline(baselineRunDir ?? run.snapshot?.baselineRunDir ?? null);
  const content = renderRunbook(run, runDir, baseline);
  const latest = path.join(reportsDir, "runbook.md");
  const archived = path.join(reportsDir, `runbook-${run.runId}.md`);
  fs.writeFileSync(latest, content);
  fs.writeFileSync(archived, content);
  return latest;
}

/**
 * `RESULTS_DIR` and `REPORTS_DIR` are honoured here for the same reason the orchestrator honours
 * them: without that, regenerating a report from a scratch run silently overwrites
 * `reports/runbook.md` — the committed record of the last real capacity run. That is not a
 * hypothetical; it happened while Phase H was being built.
 */
function cli(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resultsDir = process.env.RESULTS_DIR ?? path.join(here, "results");
  const reportsDir = process.env.REPORTS_DIR ?? path.join(here, "reports");
  const explicit = process.argv[2];
  const runDir = explicit ? path.resolve(explicit) : latestRunDir(resultsDir);
  const baseline = process.argv[3] ? path.resolve(process.argv[3]) : process.env.BASELINE_RUN_DIR ?? null;
  const output = generateRunbook(runDir, reportsDir, baseline);
  console.log(`Runbook generated: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
