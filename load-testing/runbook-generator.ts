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
  };
  evaluation: { verdict: Verdict; breaches: string[]; warnings: string[] };
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

function renderRunbook(run: RunRecord, runDir: string): string {
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

export function generateRunbook(runDir: string, reportsDir: string): string {
  const runPath = path.join(runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`Missing run artifact: ${runPath}`);
  const run = JSON.parse(fs.readFileSync(runPath, "utf8")) as RunRecord;
  if (!Array.isArray(run.stages) || run.stages.length === 0)
    throw new Error(`Run has no completed stages: ${runPath}`);
  fs.mkdirSync(reportsDir, { recursive: true });
  const content = renderRunbook(run, runDir);
  const latest = path.join(reportsDir, "runbook.md");
  const archived = path.join(reportsDir, `runbook-${run.runId}.md`);
  fs.writeFileSync(latest, content);
  fs.writeFileSync(archived, content);
  return latest;
}

function cli(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const explicit = process.argv[2];
  const runDir = explicit ? path.resolve(explicit) : latestRunDir(path.join(here, "results"));
  const output = generateRunbook(runDir, path.join(here, "reports"));
  console.log(`Runbook generated: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
