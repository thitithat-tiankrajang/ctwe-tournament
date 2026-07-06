#!/usr/bin/env node

/**
 * Production-safe-by-default public viewer soak test.
 *
 * Each simulated viewer performs the same public reads as the tournament page, then keeps one
 * dedicated SSE connection open. There is deliberately no polling fallback. Press Ctrl+C once
 * to stop accepting/reconnecting viewers, close every stream, and write the final summary.
 *
 * No third-party packages are required; this is intentionally runnable when xk6-sse is absent.
 */
import fs from "node:fs";
import https from "node:https";
import { monitorEventLoopDelay } from "node:perf_hooks";
import process from "node:process";

const pageUrl = new URL(process.env.TOURNAMENT_URL
  ?? "https://ct-we.com/t/9810d81d74824fe086daf2266d768eaa");
const apiOrigin = new URL(process.env.PUBLIC_API_ORIGIN ?? "https://api.ct-we.com");
const token = pageUrl.pathname.match(/^\/t\/([^/?#]+)/)?.[1];
const cardOverride = process.env.CARD_ID?.trim();
const reportIntervalMs = numberEnv("REPORT_INTERVAL_MS", 5_000);
const requestTimeoutMs = numberEnv("REQUEST_TIMEOUT_MS", 20_000);
const reconnectBaseMs = numberEnv("RECONNECT_BASE_MS", 2_000);
const reconnectMaxMs = numberEnv("RECONNECT_MAX_MS", 60_000);
const outputDir = process.env.OUTPUT_DIR ?? "load-tests/out/soak";
const preflightOnly = process.argv.includes("--preflight");
const confirmation = process.env.CONFIRM_PRODUCTION_LOAD ?? "";

if (!token) die("TOURNAMENT_URL must be an absolute /t/<token> URL");

const stages = parseStages(process.env.STAGES ?? "30s:100,1m:500,1m:1000,2m:2500,3m:5000");
const target = stages.at(-1)?.target ?? 0;
if (!preflightOnly && pageUrl.hostname === "ct-we.com" && confirmation !== "ct-we.com") {
  die("Production guard: set CONFIRM_PRODUCTION_LOAD=ct-we.com after reading the preflight result");
}

fs.mkdirSync(outputDir, { recursive: true });
const runId = new Date().toISOString().replaceAll(":", "-");
const eventsPath = `${outputDir}/${runId}.jsonl`;
const summaryPath = `${outputDir}/${runId}.summary.json`;
const eventFile = fs.createWriteStream(eventsPath, { flags: "a" });
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const state = {
  startedAt: Date.now(),
  stopping: false,
  desiredViewers: 0,
  createdViewers: 0,
  openingViewers: 0,
  activeStreams: 0,
  peakActiveStreams: 0,
  pageLoads: 0,
  apiReads: 0,
  sseAttempts: 0,
  sseOpened: 0,
  sseRejected: 0,
  sseDropped: 0,
  reconnects: 0,
  events: 0,
  heartbeats: 0,
  bytesReceived: 0,
  statusCounts: {},
  eventTypes: {},
  errors: {},
  durations: {
    pageMs: [],
    tournamentMs: [],
    catalogMs: [],
    configMs: [],
    cardMs: [],
    sseConnectMs: [],
    eventLatencyMs: [],
  },
};

const viewers = new Map();
const timers = new Set();
let reportTimer;
let preflight;

try {
  preflight = await inspectTarget();
  console.log(JSON.stringify({ type: "preflight", ...preflight }, null, 2));
  writeEvent("preflight", preflight);
  if (preflight.cards.length === 0) {
    die(
      "Tournament has no published cards. The exact page currently opens no SSE stream, "
      + "so a 5,000-viewer run would only measure a one-time page load and then idle."
    );
  }
  if (preflightOnly) {
    await closeOutputs();
    process.exit(0);
  }
  resetLoadMetrics();

  console.log(`\nStarting SSE-only soak against card(s): ${preflight.cards.map((card) => card.id).join(", ")}`);
  console.log(`Ramp: ${stages.map((stage) => `${stage.durationLabel}:${stage.target}`).join(" -> ")}`);
  console.log("Hold: unlimited. Press Ctrl+C once to stop and write the summary.\n");

  reportTimer = setInterval(report, reportIntervalMs);
  reportTimer.unref();
  installSignalHandlers();
  await runStages();
  await new Promise(() => {});
} catch (error) {
  if (!state.stopping) {
    recordError("fatal");
    console.error(error instanceof Error ? error.stack : error);
    await shutdown(1);
  }
}

async function inspectTarget() {
  const page = await requestText(pageUrl, "pageMs");
  if (page.status !== 200) die(`Page preflight returned HTTP ${page.status}`);

  const tournamentUrl = apiUrl(`/api/public/tournaments/${encodeURIComponent(token)}`);
  const tournamentResponse = await requestJson(tournamentUrl, "tournamentMs");
  if (tournamentResponse.status !== 200)
    die(`Tournament token returned HTTP ${tournamentResponse.status}`);

  const catalogResponse = await requestJson(apiUrl("/api/public/cards"), "catalogMs");
  if (catalogResponse.status !== 200 || !Array.isArray(catalogResponse.body))
    die(`Public card catalog returned HTTP ${catalogResponse.status}`);

  const configResponse = await requestJson(apiUrl("/api/public/realtime-config"), "configMs");
  const tournament = tournamentResponse.body;
  const cards = catalogResponse.body.filter((card) =>
    card.tournamentId === tournament.id && (!cardOverride || card.id === cardOverride));

  return {
    pageStatus: page.status,
    frontendOrigin: pageUrl.origin,
    apiOrigin: apiOrigin.origin,
    tournament: {
      id: tournament.id,
      name: tournament.name,
      publishedCardCount: tournament.publishedCardCount,
    },
    realtime: configResponse.body,
    cards: cards.map(({ id, name, version, status, playerCount }) =>
      ({ id, name, version, status, playerCount })),
    requestedPeakViewers: target,
    warning: target > 2_000
      ? "Repository currently configures server.tomcat.max-connections=2000; 5000 concurrent SSE streams cannot fit."
      : undefined,
  };
}

async function runStages() {
  let previousTarget = 0;
  for (const stage of stages) {
    if (state.stopping) return;
    const additions = Math.max(0, stage.target - previousTarget);
    const spacingMs = additions > 0 ? stage.durationMs / additions : stage.durationMs;
    for (let index = 0; index < additions && !state.stopping; index += 1) {
      state.desiredViewers += 1;
      const viewerId = state.createdViewers + 1;
      state.createdViewers = viewerId;
      void startViewer(viewerId);
      await delay(spacingMs);
    }
    if (stage.target < previousTarget) {
      const removeCount = previousTarget - stage.target;
      [...viewers.keys()].slice(-removeCount).forEach(stopViewer);
      state.desiredViewers = stage.target;
    }
    previousTarget = stage.target;
    writeEvent("stage", { target: stage.target, duration: stage.durationLabel });
  }
  console.log(`Reached ${target} desired viewers; holding until Ctrl+C.`);
}

async function startViewer(id) {
  const viewer = {
    id,
    stopped: false,
    request: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    frontendAgent: new https.Agent({ keepAlive: true, maxSockets: 1 }),
    apiAgent: new https.Agent({ keepAlive: true, maxSockets: 1 }),
  };
  viewers.set(id, viewer);
  state.openingViewers += 1;
  try {
    const card = preflight.cards[(id - 1) % preflight.cards.length];
    await required(requestText(pageUrl, "pageMs", "page", viewer.frontendAgent), "page");
    await required(
      requestJson(apiUrl(`/api/public/tournaments/${encodeURIComponent(token)}`), "tournamentMs", "api", viewer.apiAgent),
      "tournament",
    );
    await required(requestJson(apiUrl("/api/public/cards"), "catalogMs", "api", viewer.apiAgent), "catalog");
    await required(requestJson(apiUrl("/api/public/realtime-config"), "configMs", "api", viewer.apiAgent), "config");
    await required(
      requestJson(
        apiUrl(`/api/public/cards/${encodeURIComponent(card.id)}?v=${card.version}`),
        "cardMs",
        "api",
        viewer.apiAgent,
      ),
      "card",
    );
    if (!viewer.stopped && !state.stopping) openSse(viewer, card.id);
  } catch {
    recordError("viewer_open");
    scheduleReconnect(viewer, preflight.cards[(id - 1) % preflight.cards.length].id);
  } finally {
    state.openingViewers -= 1;
  }
}

function openSse(viewer, cardId) {
  if (state.stopping || viewer.stopped) return;
  const url = apiUrl(`/api/public/cards/${encodeURIComponent(cardId)}/events`);
  const startedAt = performance.now();
  state.sseAttempts += 1;
  let opened = false;
  let buffer = "";

  const request = https.request(url, {
    method: "GET",
    agent: viewer.apiAgent,
    headers: browserHeaders("text/event-stream"),
  }, (response) => {
    countStatus(response.statusCode);
    if (response.statusCode !== 200) {
      state.sseRejected += 1;
      response.resume();
      scheduleReconnect(viewer, cardId);
      return;
    }

    opened = true;
    viewer.reconnectAttempt = 0;
    state.sseOpened += 1;
    state.activeStreams += 1;
    state.peakActiveStreams = Math.max(state.peakActiveStreams, state.activeStreams);
    state.durations.sseConnectMs.push(performance.now() - startedAt);

    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      state.bytesReceived += Buffer.byteLength(chunk);
      buffer += chunk.replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeSseFrame(frame);
      }
    });
    response.once("end", () => onClosed());
    response.once("error", () => onClosed("sse_response"));
    response.once("aborted", () => onClosed("sse_aborted"));

    let closed = false;
    function onClosed(errorType) {
      if (closed) return;
      closed = true;
      state.activeStreams = Math.max(0, state.activeStreams - 1);
      if (errorType) recordError(errorType);
      if (!state.stopping && !viewer.stopped) {
        state.sseDropped += 1;
        scheduleReconnect(viewer, cardId);
      }
    }
  });

  viewer.request = request;
  request.setTimeout(requestTimeoutMs, () => {
    if (!opened) request.destroy(new Error("SSE connect timeout"));
  });
  request.once("error", () => {
    if (!opened) {
      recordError("sse_connect");
      scheduleReconnect(viewer, cardId);
    }
  });
  request.end();
}

function consumeSseFrame(frame) {
  if (!frame) return;
  if (frame.split("\n").every((line) => line.startsWith(":"))) {
    state.heartbeats += 1;
    return;
  }
  let eventType = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim() || "message";
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  state.events += 1;
  state.eventTypes[eventType] = (state.eventTypes[eventType] ?? 0) + 1;
  try {
    const payload = JSON.parse(dataLines.join("\n"));
    const publishedAt = Date.parse(payload.updatedAt);
    if (Number.isFinite(publishedAt))
      state.durations.eventLatencyMs.push(Math.max(0, Date.now() - publishedAt));
  } catch {
    recordError("malformed_sse_event");
  }
}

function scheduleReconnect(viewer, cardId) {
  if (state.stopping || viewer.stopped || viewer.reconnectTimer) return;
  viewer.reconnectAttempt += 1;
  state.reconnects += 1;
  const exponential = Math.min(
    reconnectMaxMs,
    reconnectBaseMs * (2 ** Math.min(viewer.reconnectAttempt - 1, 8)),
  );
  const waitMs = exponential * (0.75 + Math.random() * 0.5);
  viewer.reconnectTimer = setTimeout(() => {
    viewer.reconnectTimer = null;
    openSse(viewer, cardId);
  }, waitMs);
}

function stopViewer(id) {
  const viewer = viewers.get(id);
  if (!viewer) return;
  viewer.stopped = true;
  if (viewer.reconnectTimer) clearTimeout(viewer.reconnectTimer);
  viewer.request?.destroy();
  viewer.frontendAgent.destroy();
  viewer.apiAgent.destroy();
  viewers.delete(id);
}

function report() {
  const memory = process.memoryUsage();
  const snapshot = {
    elapsed: formatDuration(Date.now() - state.startedAt),
    desired: state.desiredViewers,
    opening: state.openingViewers,
    sseActive: state.activeStreams,
    ssePeak: state.peakActiveStreams,
    rejected: state.sseRejected,
    dropped: state.sseDropped,
    reconnects: state.reconnects,
    events: state.events,
    p95ConnectMs: percentile(state.durations.sseConnectMs, 0.95),
    p95EventMs: percentile(state.durations.eventLatencyMs, 0.95),
    generatorRssMb: round(memory.rss / 1024 / 1024),
    eventLoopP99Ms: round(eventLoop.percentile(99) / 1e6),
  };
  console.log(
    `[${snapshot.elapsed}] desired=${snapshot.desired} opening=${snapshot.opening} `
    + `SSE=${snapshot.sseActive}/${snapshot.ssePeak} reject=${snapshot.rejected} `
    + `drop=${snapshot.dropped} reconnect=${snapshot.reconnects} events=${snapshot.events} `
    + `connect-p95=${snapshot.p95ConnectMs ?? "-"}ms event-p95=${snapshot.p95EventMs ?? "-"}ms `
    + `generator=${snapshot.generatorRssMb}MB loop-p99=${snapshot.eventLoopP99Ms}ms`
  );
  writeEvent("sample", snapshot);
  eventLoop.reset();
}

function installSignalHandlers() {
  let signalCount = 0;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      signalCount += 1;
      if (signalCount === 1) void shutdown(0);
      else process.exit(130);
    });
  }
}

async function shutdown(exitCode) {
  if (state.stopping) return;
  state.stopping = true;
  console.log("\nStopping viewers and writing summary...");
  clearInterval(reportTimer);
  for (const timer of timers) clearTimeout(timer);
  for (const id of [...viewers.keys()]) stopViewer(id);
  eventLoop.disable();

  const summary = {
    runId,
    tournamentUrl: pageUrl.href,
    apiOrigin: apiOrigin.origin,
    startedAt: new Date(state.startedAt).toISOString(),
    stoppedAt: new Date().toISOString(),
    elapsedMs: Date.now() - state.startedAt,
    configuredStages: stages,
    target,
    generator: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      rssMb: round(process.memoryUsage().rss / 1024 / 1024),
    },
    totals: {
      createdViewers: state.createdViewers,
      peakActiveStreams: state.peakActiveStreams,
      pageLoads: state.pageLoads,
      apiReads: state.apiReads,
      sseAttempts: state.sseAttempts,
      sseOpened: state.sseOpened,
      sseRejected: state.sseRejected,
      sseDropped: state.sseDropped,
      reconnects: state.reconnects,
      events: state.events,
      heartbeats: state.heartbeats,
      bytesReceived: state.bytesReceived,
      statusCounts: state.statusCounts,
      eventTypes: state.eventTypes,
      errors: state.errors,
    },
    latencyMs: Object.fromEntries(Object.entries(state.durations).map(([name, values]) =>
      [name, summarize(values)])),
    preflight,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeEvent("summary", summary);
  await closeOutputs();
  console.log(`Summary: ${summaryPath}`);
  console.log(`Timeline: ${eventsPath}`);
  process.exit(exitCode);
}

function requestText(url, metricName, requestType, agent) {
  return request(url, metricName, false, requestType, agent);
}

function requestJson(url, metricName, requestType, agent) {
  return request(url, metricName, true, requestType, agent);
}

function request(url, metricName, parseJson, requestType, agent) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = https.request(url, {
      method: "GET",
      agent: agent ?? false,
      headers: browserHeaders(parseJson ? "application/json" : "text/html"),
    }, (response) => {
      countStatus(response.statusCode);
      if (requestType === "page") state.pageLoads += 1;
      if (requestType === "api") state.apiReads += 1;
      const chunks = [];
      response.on("data", (chunk) => {
        state.bytesReceived += chunk.length;
        chunks.push(chunk);
      });
      response.once("end", () => {
        state.durations[metricName].push(performance.now() - startedAt);
        const text = Buffer.concat(chunks).toString("utf8");
        if (!parseJson) {
          resolve({ status: response.statusCode, headers: response.headers, body: text });
          return;
        }
        try {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("request timeout")));
    request.once("error", reject);
    request.end();
  });
}

function browserHeaders(accept) {
  return {
    Accept: accept,
    "Accept-Encoding": "identity",
    Origin: pageUrl.origin,
    Referer: pageUrl.href,
    "User-Agent": "ctwe-viewer-soak/1.0",
  };
}

async function required(promise, resource) {
  const response = await promise;
  if (response.status !== 200) {
    recordError(`${resource}_http_${response.status}`);
    throw new Error(`${resource} returned HTTP ${response.status}`);
  }
  return response;
}

function resetLoadMetrics() {
  state.bytesReceived = 0;
  state.statusCounts = {};
  state.errors = {};
  Object.keys(state.durations).forEach((name) => {
    state.durations[name] = [];
  });
  state.startedAt = Date.now();
}

function apiUrl(pathname) {
  return new URL(pathname, apiOrigin);
}

function parseStages(value) {
  return value.split(",").map((raw) => {
    const [durationLabel, targetText] = raw.trim().split(":");
    const durationMs = parseDuration(durationLabel);
    const parsedTarget = Number(targetText);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isInteger(parsedTarget) || parsedTarget < 0)
      die(`Invalid STAGES item: ${raw}`);
    return { durationLabel, durationMs, target: parsedTarget };
  });
}

function parseDuration(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]];
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) die(`${name} must be a positive number`);
  return value;
}

function countStatus(status) {
  const key = String(status ?? "unknown");
  state.statusCounts[key] = (state.statusCounts[key] ?? 0) + 1;
}

function recordError(type) {
  state.errors[type] = (state.errors[type] ?? 0) + 1;
}

function summarize(values) {
  return {
    count: values.length,
    avg: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? round(Math.max(...values)) : null,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, Math.max(0, milliseconds));
    timers.add(timer);
  });
}

function writeEvent(type, payload) {
  eventFile.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...payload })}\n`);
}

function closeOutputs() {
  return new Promise((resolve) => eventFile.end(resolve));
}

function die(message) {
  throw new Error(message);
}
