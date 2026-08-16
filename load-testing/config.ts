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

  // ------------------------------------------------------------------ Phase H (snapshot cutover)

  /**
   * Highest acceptable p95 snapshot-probe duration on the LIVE path, in milliseconds.
   *
   * Architecture §2.5(1) budgets ≤ 25 ms of added p95-to-first-data. This threshold is applied to the
   * probe itself, which is the latency each live viewer *individually* pays: the client awaits the
   * probe before starting the live bundle fetch (`store.ts loadBundle`), so per viewer the added time
   * is exactly the probe's duration. It is a per-stage signal available from a single run.
   *
   * It is **not** the criterion itself. §2.5(1) is a delta between a probe-on run and a probe-off
   * baseline, and that is computed across two runs by the runbook generator, which treats it as
   * authoritative when a baseline is available. Both must hold. The single-run signal also errs
   * conservative: mitigation M3 overlaps the real probe with hydration, which the harness has no
   * hydration to overlap.
   */
  maxProbeP95Ms: number;
  /** Minimum share of steady-state 404 probes that must be answered by the edge (§2.5(2)). */
  minEdgeHitRatio: number;
  /** Highest acceptable live p95-to-first-data regression against the baseline run, in ms (③). */
  maxLiveFirstDataRegressionMs: number;
}

/**
 * Which kind of viewer a stage's fleet is made of (Phase H).
 *
 * - `live`     — today's viewer: bundle + realtime-config + one SSE stream. Measurement ①.
 * - `published`— static-first viewer: one CDN probe and nothing else. Measurement ②.
 * - `mixed`    — both at once, across several tournaments. Measurement ③.
 */
export type Fleet = "live" | "published" | "mixed";

export interface SnapshotSettings {
  /** CDN origin serving `/s/{h}.json`. Null means every published measurement is unavailable. */
  origin: URL | null;
  /** Tokens of tournaments that really are published — the published half of the fleet views these. */
  publishedTokens: string[];
  /** Tokens of live tournaments. Defaults to the single token parsed from TOURNAMENT_URL. */
  liveTokens: string[];
  fleet: Fleet;
  /** Share of each stage's viewers assigned to published tournaments when `fleet` is `mixed`. */
  publishedShare: number;
  /**
   * Issue the probe on the live path too. This is the cost measurement ④ exists to bound, so it
   * defaults on whenever a snapshot origin is configured; turn it off to record the ① baseline.
   */
  probeOnLive: boolean;
  /** Mirrors `PROBE_TIMEOUT_MS` in `src/infrastructure/http/snapshot-api.ts`. */
  probeTimeoutMs: number;
  /** A previous run directory to compare against for measurements ① and ③. */
  baselineRunDir: string | null;
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
  snapshot: SnapshotSettings;

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

function ratioEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a ratio between 0 and 1, got "${raw}"`);
  }
  return value;
}

function tokenListEnv(name: string): string[] {
  const raw = env(name);
  if (raw === null) return [];
  return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

function parseStages(raw: string): Stage[] {
  const targets = raw.split(",").map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (targets.length === 0) throw new Error(`STAGES parsed to nothing: "${raw}"`);
  const sorted = [...new Set(targets)].sort((a, b) => a - b);
  return sorted.map((target) => ({ target }));
}

/**
 * Phase H settings, validated so an incomplete configuration cannot produce a passing measurement.
 *
 * The rule that matters: a fleet containing published viewers requires BOTH a snapshot origin and at
 * least one published token. Without them the harness would happily ramp viewers that probe nothing,
 * fall through to the live path, and report a fleet that never demonstrated anything. Failing here
 * is the difference between "not measured" and "measured wrong".
 */
function loadSnapshotSettings(liveToken: string): SnapshotSettings {
  const rawOrigin = env("SNAPSHOT_ORIGIN");
  const origin = rawOrigin === null ? null : new URL(rawOrigin);
  const fleet = (env("FLEET") ?? "live") as Fleet;
  if (fleet !== "live" && fleet !== "published" && fleet !== "mixed") {
    throw new Error(`FLEET must be one of live|published|mixed, got "${fleet}"`);
  }
  const publishedTokens = tokenListEnv("PUBLISHED_TOKENS");
  const liveTokens = tokenListEnv("LIVE_TOKENS");

  if (fleet !== "live") {
    if (origin === null) {
      throw new Error(`FLEET=${fleet} needs SNAPSHOT_ORIGIN (e.g. https://snapshot.ct-we.com) — a `
        + "published fleet with no CDN would silently degrade to live viewers and measure nothing");
    }
    if (publishedTokens.length === 0) {
      throw new Error(`FLEET=${fleet} needs PUBLISHED_TOKENS: the access tokens of tournaments that `
        + "are actually PUBLISHED. Check GET /api/admin/tournaments/{id}/public-snapshot/status first");
    }
  }
  const probeOnLive = boolEnv("SNAPSHOT_PROBE_ON_LIVE", origin !== null);
  if (probeOnLive && origin === null) {
    throw new Error("SNAPSHOT_PROBE_ON_LIVE=true needs SNAPSHOT_ORIGIN");
  }
  const overlap = publishedTokens.filter((token) => liveTokens.includes(token) || token === liveToken);
  if (overlap.length > 0) {
    throw new Error(`Token(s) listed as both live and published: ${overlap.join(", ")}. A tournament `
      + "cannot be its own control; the mixed-fleet comparison would be meaningless");
  }

  return {
    origin,
    publishedTokens,
    liveTokens: liveTokens.length > 0 ? liveTokens : [liveToken],
    fleet,
    publishedShare: ratioEnv("PUBLISHED_VIEWER_SHARE", 0.5),
    probeOnLive,
    // Mirrors the browser's PROBE_TIMEOUT_MS. Overridable only so a deliberately degraded-CDN
    // experiment is possible; the default must track the client.
    probeTimeoutMs: numberEnv("SNAPSHOT_PROBE_TIMEOUT_MS", 1_200),
    baselineRunDir: env("BASELINE_RUN_DIR"),
  };
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
      maxProbeP95Ms: numberEnv("THRESHOLD_MAX_PROBE_P95_MS", 25),
      minEdgeHitRatio: ratioEnv("THRESHOLD_MIN_EDGE_HIT_RATIO", 0.95),
      maxLiveFirstDataRegressionMs: numberEnv("THRESHOLD_MAX_LIVE_FIRST_DATA_REGRESSION_MS", 25),
    },
    snapshot: loadSnapshotSettings(token),
    resultsDir: env("RESULTS_DIR") ?? new URL("./results", import.meta.url).pathname,
    reportsDir: env("REPORTS_DIR") ?? new URL("./reports", import.meta.url).pathname,
    confirmProductionLoad: env("CONFIRM_PRODUCTION_LOAD") ?? "",
  };
}

/**
 * The viewer page URL for one token.
 *
 * The configured `TOURNAMENT_URL` is returned untouched for its own token, so single-tournament runs
 * request byte-identical URLs to before. Additional tokens reuse its route shape — `/tour` or the
 * legacy `/t` — because both resolve snapshots from the token, never from the URL shape.
 */
export function pageUrlFor(config: Config, token: string): string {
  if (token === config.token) return config.tournamentUrl.href;
  const path = config.tournamentUrl.pathname.replace(
    /^\/(tour|t)\/[^/?#]+/,
    (_match, prefix: string) => `/${prefix}/${encodeURIComponent(token)}`,
  );
  return new URL(path + config.tournamentUrl.search, config.tournamentUrl).href;
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
    // The CDN carries the published fleet's entire load. It is a real host being loaded, so it needs
    // the same deliberate confirmation as the origin.
    ...(config.snapshot.origin ? [config.snapshot.origin.hostname] : []),
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
