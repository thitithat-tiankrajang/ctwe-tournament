/**
 * All tunables for the staged SSE capacity test, read once from the environment.
 *
 * Only TOURNAMENT_URL is mandatory. Everything else has production-shaped defaults, and every
 * value is documented in README.md. Keep this file dependency-free: it is imported by the
 * orchestrator, the scenarios, and the runbook generator.
 */

export interface Stage {
  /** Total concurrent viewers this stage ramps up to (stages only ever grow). */
  target: number;
}

export interface Thresholds {
  /** Highest acceptable JVM process CPU during a stage (0..1). */
  maxProcessCpu: number;
  /** Highest acceptable heap-used / heap-max ratio during the hold. */
  maxHeapRatio: number;
  /** Highest acceptable SSE error rate: (rejected+dropped+stalled)/target, in %. */
  maxErrorRatePct: number;
  /** Highest acceptable finite HTTP request error rate, in %. */
  maxHttpErrorRatePct: number;
  /** Highest acceptable page/bootstrap HTTP p99 in milliseconds. */
  maxHttpP99Ms: number;
  /** Highest acceptable SSE connect p99 in milliseconds. */
  maxConnectP99Ms: number;
  /** Highest acceptable staff-write -> viewer-receive p95 in milliseconds (when measured). */
  maxEventLatencyP95Ms: number;
  /** Minimum share of the stage target that must hold an open stream at the end of the hold. */
  minAttachRatio: number;
  /** Reconnect churn guard: reconnects per minute per 1,000 viewers during the stage. */
  maxReconnectsPerMinPer1k: number;
  /** A stage using more than this share of any threshold is flagged NEAR LIMIT instead of PASS. */
  nearLimitRatio: number;
}

export interface Config {
  /** Public tournament page, e.g. https://ct-we.com/tour/my-cup — the token is parsed from it. */
  tournamentUrl: URL;
  token: string;
  /** Origin serving /api/public/** and SSE (Render or the CDN host in front of it). */
  publicApiOrigin: URL;
  /** Origin serving /actuator/** and /login (the backend itself). */
  backendOrigin: URL;

  /** Fetch the page document once per simulated viewer (mirrors a real first visit). */
  fetchPageDocument: boolean;
  /** Pin every viewer to one card id instead of distributing round-robin. */
  cardId: string | null;

  stages: Stage[];
  rampSeconds: number;
  settleSeconds: number;
  holdSeconds: number;
  sampleSeconds: number;
  stopOnFail: boolean;

  /** Viewer reconnect behavior (mirrors the browser hook: backoff with jitter, capped). */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** No bytes (data or heartbeat) for this long marks the stream stalled and forces a reconnect. */
  heartbeatTimeoutMs: number;
  requestTimeoutMs: number;

  /** Admin credentials for /actuator metrics (real JVM numbers). Optional but strongly advised. */
  adminUser: string | null;
  adminPass: string | null;

  /** Optional staff writer that rewrites one match result so streams carry real events. */
  staffUser: string | null;
  staffPass: string | null;
  activityCardId: string | null;
  activityMatchId: string | null;
  activityIntervalMs: number;

  thresholds: Thresholds;

  resultsDir: string;
  reportsDir: string;
  /** Comma-separated hostname confirmations required before loading non-local targets. */
  confirmProductionLoad: string;
}

const DEFAULT_STAGES = "100,250,500,750,1000,1500,2000,2500,3000,4000,5000,6000,7000,8000,9000,10000";

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function numberEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = env(name);
  return raw === null ? fallback : raw === "true" || raw === "1";
}

function parseStages(raw: string): Stage[] {
  const targets = raw.split(",").map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (targets.length === 0) throw new Error(`STAGES parsed to nothing: "${raw}"`);
  const sorted = [...new Set(targets)].sort((a, b) => a - b);
  return sorted.map((target) => ({ target }));
}

export function loadConfig(): Config {
  const rawUrl = env("TOURNAMENT_URL");
  if (!rawUrl) {
    throw new Error(
      "TOURNAMENT_URL is required, e.g. TOURNAMENT_URL=https://ct-we.com/tour/my-cup "
      + "(or http://localhost:3000/tour/my-cup against a local stack)",
    );
  }
  const tournamentUrl = new URL(rawUrl);
  const token = tournamentUrl.pathname.match(/^\/(?:tour|t)\/([^/?#]+)/)?.[1];
  if (!token) throw new Error("TOURNAMENT_URL must point at /tour/<token> or /t/<token>");

  const publicApiOrigin = new URL(env("PUBLIC_API_ORIGIN") ?? tournamentUrl.origin);
  const backendOrigin = new URL(env("BACKEND_ORIGIN") ?? publicApiOrigin.origin);

  return {
    tournamentUrl,
    token,
    publicApiOrigin,
    backendOrigin,
    fetchPageDocument: boolEnv("FETCH_PAGE_DOCUMENT", true),
    cardId: env("CARD_ID"),
    stages: parseStages(env("STAGES") ?? DEFAULT_STAGES),
    rampSeconds: numberEnv("RAMP_SECONDS", 30),
    settleSeconds: numberEnv("SETTLE_SECONDS", 10),
    holdSeconds: numberEnv("HOLD_SECONDS", 90),
    sampleSeconds: numberEnv("SAMPLE_SECONDS", 5),
    stopOnFail: boolEnv("STOP_ON_FAIL", true),
    reconnectBaseMs: numberEnv("RECONNECT_BASE_MS", 2_000),
    reconnectMaxMs: numberEnv("RECONNECT_MAX_MS", 60_000),
    heartbeatTimeoutMs: numberEnv("HEARTBEAT_TIMEOUT_MS", 90_000),
    requestTimeoutMs: numberEnv("REQUEST_TIMEOUT_MS", 20_000),
    adminUser: env("LOADTEST_ADMIN_USER"),
    adminPass: env("LOADTEST_ADMIN_PASS"),
    staffUser: env("LOADTEST_STAFF_USER") ?? env("LOADTEST_ADMIN_USER"),
    staffPass: env("LOADTEST_STAFF_PASS") ?? env("LOADTEST_ADMIN_PASS"),
    activityCardId: env("ACTIVITY_CARD_ID"),
    activityMatchId: env("ACTIVITY_MATCH_ID"),
    activityIntervalMs: numberEnv("ACTIVITY_INTERVAL_MS", 10_000),
    thresholds: {
      maxProcessCpu: numberEnv("THRESHOLD_MAX_CPU", 0.75),
      maxHeapRatio: numberEnv("THRESHOLD_MAX_HEAP_RATIO", 0.70),
      maxErrorRatePct: numberEnv("THRESHOLD_MAX_ERROR_PCT", 0.5),
      maxHttpErrorRatePct: numberEnv("THRESHOLD_MAX_HTTP_ERROR_PCT", 0.5),
      maxHttpP99Ms: numberEnv("THRESHOLD_MAX_HTTP_P99_MS", 2_000),
      maxConnectP99Ms: numberEnv("THRESHOLD_MAX_CONNECT_P99_MS", 2_000),
      maxEventLatencyP95Ms: numberEnv("THRESHOLD_MAX_EVENT_P95_MS", 3_000),
      minAttachRatio: numberEnv("THRESHOLD_MIN_ATTACH_RATIO", 0.99),
      maxReconnectsPerMinPer1k: numberEnv("THRESHOLD_MAX_RECONNECTS_PER_MIN_PER_1K", 20),
      nearLimitRatio: numberEnv("THRESHOLD_NEAR_LIMIT_RATIO", 0.85),
    },
    resultsDir: env("RESULTS_DIR") ?? new URL("./results", import.meta.url).pathname,
    reportsDir: env("REPORTS_DIR") ?? new URL("./reports", import.meta.url).pathname,
    confirmProductionLoad: env("CONFIRM_PRODUCTION_LOAD") ?? "",
  };
}

/** Local stacks are always fair game; anything else needs an explicit hostname confirmation. */
export function assertProductionGuard(config: Config): void {
  const local = (host: string) =>
    host === "localhost" || host === "127.0.0.1" || host === "::1"
    || host.startsWith("192.168.") || host.startsWith("10.");
  const required = [...new Set([
    config.tournamentUrl.hostname,
    config.publicApiOrigin.hostname,
    config.backendOrigin.hostname,
  ].filter((host) => !local(host)))];
  const confirmed = new Set(config.confirmProductionLoad.split(",").map((host) => host.trim()).filter(Boolean));
  const missing = required.filter((host) => !confirmed.has(host));
  if (missing.length > 0) {
    throw new Error(
      `Production guard: unconfirmed target host(s): ${missing.join(", ")}. Re-run with `
      + `CONFIRM_PRODUCTION_LOAD=${required.join(",")} after checking that no real event is running.`,
    );
  }
}
