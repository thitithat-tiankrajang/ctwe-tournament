import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

/**
 * Shared flows for the certification suite. `main.js` passes the xk6-sse module in; the
 * polling-only variant passes null and every viewer degrades exactly like a browser whose
 * EventSource was refused (503) — the same code path production relies on.
 *
 * Concurrent SSE occupancy is read server-side (actuator gauge `sse.streams.public` via
 * monitor.sh) — a k6 Gauge cannot aggregate across VUs, so client metrics here are counters.
 */

// --- custom metrics (all exported into the per-step summary) ---
export const sseConnected = new Counter("sse_connected_total");
export const sseRejected = new Counter("sse_rejected_total");
export const sseErrors = new Counter("sse_errors_total");
export const pollingUsers = new Counter("polling_users_total");
export const sseConnectMs = new Trend("sse_connect_ms", true);
export const sseEventLatencyMs = new Trend("sse_event_latency_ms", true);
export const cacheHits = new Rate("edge_cache_hits");
export const staffSaves = new Counter("staff_saves_total");

const base = (__ENV.TOURNAMENT_URL || "").replace(/\/+$/, "");
if (!base) fail("Set TOURNAMENT_URL=https://host/t/<token> (the public tournament link)");
const originMatch = base.match(/^(https?:\/\/[^/]+)/);
export const origin = originMatch ? originMatch[1] : fail("TOURNAMENT_URL must be absolute");
const tokenMatch = base.match(/\/t\/([^/?#]+)/);
export const token = tokenMatch ? tokenMatch[1] : "";
// SSE may target the backend origin directly (Vercel buffers/limits proxied streams).
export const sseOrigin = (__ENV.SSE_BASE_URL || origin).replace(/\/+$/, "");

const holdMs = durationMs(__ENV.HOLD || "4m");
const jsonHeaders = { Accept: "application/json" };

export function durationMs(text) {
  const match = String(text).match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return 240_000;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] || "s"];
  return Number(match[1]) * unit;
}

function trackCache(response) {
  const header = response.headers["X-Vercel-Cache"] || response.headers["X-Vercel-Cache".toLowerCase()];
  if (header) cacheHits.add(["HIT", "STALE"].includes(header));
}

/** Resolve the tournament once for every VU: token -> tournamentId -> its published cards. */
export function suiteSetup() {
  if (!token) fail("TOURNAMENT_URL must contain /t/<token>");
  const tournament = http.get(`${origin}/api/public/tournaments/${token}`, { headers: jsonHeaders });
  check(tournament, { "tournament token resolves": (r) => r.status === 200 })
    || fail(`Tournament link is closed or wrong (${tournament.status})`);
  const tournamentId = tournament.json("id");

  const catalog = http.get(`${origin}/api/public/cards`, { headers: jsonHeaders });
  check(catalog, { "catalog loads": (r) => r.status === 200 }) || fail("catalog failed");
  const cards = catalog.json().filter((card) => card.tournamentId === tournamentId);
  if (cards.length === 0) fail("Tournament has no published cards to watch");

  const config = http.get(`${origin}/api/public/realtime-config`, { headers: jsonHeaders });
  const realtime = config.status === 200 ? config.json() : {
    realtimeEnabled: true, sseEnabled: true, pollingEnabled: true,
    pollingIntervalMs: 60_000, reconnectDelayMs: 2_000,
  };
  return { tournamentId, cardIds: cards.map((card) => card.id), realtime };
}

/** One browser opening the tournament page: catalog + config + one card detail. */
function openPage(data) {
  const cardId = data.cardIds[Math.floor(Math.random() * data.cardIds.length)];
  const responses = http.batch([
    ["GET", `${origin}/api/public/cards`, null, { headers: jsonHeaders, tags: { resource: "catalog" } }],
    ["GET", `${origin}/api/public/realtime-config`, null, { headers: jsonHeaders, tags: { resource: "config" } }],
  ]);
  responses.forEach(trackCache);
  check(responses[0], { "catalog 200": (r) => r.status === 200 });
  const card = http.get(`${origin}/api/public/cards/${cardId}`, { headers: jsonHeaders, tags: { resource: "card" } });
  trackCache(card);
  check(card, { "card 200": (r) => r.status === 200 });
  const version = card.status === 200 ? Number(card.json("version")) : -1;
  return { cardId, version };
}

function refetchCard(cardId, version) {
  const card = http.get(`${origin}/api/public/cards/${cardId}?v=${version}`,
    { headers: jsonHeaders, tags: { resource: "card" } });
  trackCache(card);
  check(card, { "card 200": (r) => r.status === 200 });
  return card.status === 200 ? Number(card.json("version")) : version;
}

/** Version polling — the automatic fallback when SSE is refused, disabled, or unsupported. */
function pollLoop(data, page, deadline) {
  pollingUsers.add(1);
  const interval = Math.max(5_000, Number(__ENV.POLL_MS || data.realtime.pollingIntervalMs || 60_000));
  let version = page.version;
  while (Date.now() < deadline) {
    const jitter = interval / 3;
    sleep((interval - jitter / 2 + Math.random() * jitter) / 1000);
    if (Date.now() >= deadline) break;
    const versions = http.get(`${origin}/api/public/cards/versions`,
      { headers: jsonHeaders, tags: { resource: "versions" } });
    trackCache(versions);
    if (!check(versions, { "versions 200": (r) => r.status === 200 })) continue;
    const current = versions.json().find((item) => item.id === page.cardId);
    if (current && current.version !== version) version = refetchCard(page.cardId, current.version);
  }
}

/** Live stream via xk6-sse; falls back to polling on refusal/error, like the real frontend. */
function sseLoop(sse, data, page, deadline) {
  const url = `${sseOrigin}/api/public/cards/${page.cardId}/events`;
  const startedAt = Date.now();
  let opened = false;
  let version = page.version;
  const response = sse.open(url, { headers: { Accept: "text/event-stream" } }, (client) => {
    client.on("open", () => {
      opened = true;
      sseConnected.add(1);
      sseConnectMs.add(Date.now() - startedAt);
    });
    client.on("event", (event) => {
      if (Date.now() >= deadline) { client.close(); return; }
      let payload = {};
      try { payload = JSON.parse(event.data || "{}"); } catch { /* heartbeat/comment */ }
      if (payload.updatedAt) {
        const publishedAt = Date.parse(payload.updatedAt);
        if (!Number.isNaN(publishedAt)) sseEventLatencyMs.add(Math.max(0, Date.now() - publishedAt));
      }
      // "result" events patch in place client-side (no HTTP); anything else invalidates the card.
      if (event.name && event.name !== "result" && payload.version !== undefined && payload.version !== version) {
        version = refetchCard(page.cardId, payload.version);
      }
    });
    client.on("error", () => {
      sseErrors.add(1);
      client.close();
    });
  });
  if (!opened || (response && response.status && response.status >= 400)) sseRejected.add(1);
  return { streamed: opened, version };
}

/**
 * Viewer VU body. Holds the user "on the page" for the whole stage: streaming when the server
 * admits the stream, polling otherwise, exactly mirroring use-public-sync.ts.
 */
export function viewerFlow(sse, data) {
  const deadline = Date.now() + holdMs;
  const page = openPage(data);
  if (page.version < 0) { sleep(5); return; }

  const wantSse = sse && String(__ENV.SSE_MODE || "auto") !== "off"
    && data.realtime.realtimeEnabled && data.realtime.sseEnabled;
  if (wantSse) {
    const outcome = sseLoop(sse, data, page, deadline);
    page.version = outcome.version;
    // Refused or dropped early -> remain a viewer via polling (automatic fallback).
    if (Date.now() < deadline) pollLoop(data, page, deadline);
    return;
  }
  if (data.realtime.pollingEnabled) pollLoop(data, page, deadline);
  else sleep(Math.min(30, Math.max(1, (deadline - Date.now()) / 1000)));
}

// --- staff scenario -------------------------------------------------------------------------

// Accounts allow at most two concurrent sessions (Spring maximumSessions(2)), so run ONE VU per
// account. Preferred: STAFF_USERS="user1:pass1,user2:pass2,...". STAFF_USER/STAFF_PASS works for
// a single writer.
export function staffAccounts() {
  const list = (__ENV.STAFF_USERS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return { username: entry.slice(0, separator), password: entry.slice(separator + 1) };
    });
  if (list.length === 0 && __ENV.STAFF_USER && __ENV.STAFF_PASS)
    list.push({ username: __ENV.STAFF_USER, password: __ENV.STAFF_PASS });
  return list;
}

const staffState = { csrf: "", loggedIn: false };

function staffLogin() {
  const accounts = staffAccounts();
  const credential = accounts[(__VU - 1) % accounts.length];
  const bootstrap = http.get(`${origin}/api/auth/me`, { headers: jsonHeaders, tags: { resource: "auth" } });
  if (bootstrap.status !== 200) fail("auth/me failed");
  const csrf = bootstrap.json("csrfToken");
  const login = http.post(`${origin}/login`, {
    username: credential.username, password: credential.password, _csrf: csrf,
  }, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, tags: { resource: "login" } });
  check(login, { "staff login 204": (r) => r.status === 204 }) || fail("staff login failed");
  staffState.csrf = http.get(`${origin}/api/auth/me`, { headers: jsonHeaders }).json("csrfToken");
  staffState.loggedIn = true;
}

/**
 * Staff VU body: normal result entry against a RESULT_COLLECTION card while viewers watch.
 * Re-saves existing rows (editExisting) so the load is repeatable without exhausting open matches.
 */
export function staffFlow() {
  if (staffAccounts().length === 0 || !__ENV.STAFF_CARD_ID) {
    sleep(5);
    return;
  }
  if (!staffState.loggedIn) staffLogin();
  const cardId = __ENV.STAFF_CARD_ID;
  const card = http.get(`${origin}/api/cards/${cardId}`, { headers: jsonHeaders, tags: { resource: "staff-card" } });
  if (!check(card, { "staff card 200": (r) => r.status === 200 })) { sleep(5); return; }
  const snapshots = card.json("snapshots") || [];
  const editable = [];
  snapshots.forEach((snapshot) => {
    if (snapshot.confirmedAt) return;
    (snapshot.pairings || []).forEach((pairing) => {
      if (pairing.playerOneId && pairing.playerTwoId) editable.push(pairing);
    });
  });
  if (editable.length === 0) { sleep(10); return; }
  const target = editable[Math.floor(Math.random() * editable.length)];
  const win = Math.random() < 0.5;
  const save = http.put(`${origin}/api/cards/${cardId}/matches/${target.id}/result`, JSON.stringify({
    scoreOne: win ? 380 + Math.floor(Math.random() * 100) : 320,
    scoreTwo: win ? 320 : 380 + Math.floor(Math.random() * 100),
    editExisting: Boolean(target.resultType),
  }), {
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": staffState.csrf },
    tags: { resource: "result-save" },
  });
  if (check(save, { "result save 200": (r) => r.status === 200 })) staffSaves.add(1);
  sleep(Number(__ENV.STAFF_PACE_SECONDS || 6) * (0.75 + Math.random() * 0.5));
}

/** Options shared by both entrypoints; stages come from env so the runner controls each step. */
export function suiteOptions() {
  const viewers = Number(__ENV.VIEWERS || 500);
  const ramp = __ENV.RAMP || "90s";
  const hold = __ENV.HOLD || "4m";
  const scenarios = {
    viewers: {
      executor: "ramping-vus",
      exec: "viewers",
      startVUs: 0,
      stages: [
        { duration: ramp, target: viewers },
        { duration: hold, target: viewers },
      ],
      gracefulRampDown: "15s",
      gracefulStop: "30s",
    },
  };
  const accounts = staffAccounts();
  if (accounts.length > 0 && __ENV.STAFF_CARD_ID) {
    scenarios.staff = {
      executor: "constant-vus",
      exec: "staff",
      // One VU per account: accounts allow only two concurrent sessions server-side.
      vus: Math.min(Number(__ENV.STAFF_VUS || accounts.length), accounts.length),
      duration: `${Math.round((durationMs(ramp) + durationMs(hold)) / 1000)}s`,
      gracefulStop: "15s",
    };
  }
  return {
    scenarios,
    summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
    thresholds: {
      http_req_failed: [`rate<${__ENV.ERROR_BUDGET || 0.01}`],
      "http_req_duration{resource:card}": [`p(95)<${__ENV.P95_BUDGET_MS || 1000}`],
      "http_req_duration{resource:versions}": [`p(95)<${__ENV.P95_BUDGET_MS || 1000}`],
    },
    // Thresholds report pass/fail; aborting mid-step would skew the max-stable verdict.
    noConnectionReuse: false,
    userAgent: "ctwe-loadtest/1.0 (k6)",
  };
}
