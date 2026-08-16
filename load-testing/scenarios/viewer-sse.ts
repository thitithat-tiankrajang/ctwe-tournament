/**
 * One simulated public viewer, faithful to the real /tour page:
 *
 *  1. (optional) GET the page document — what a first visit costs the frontend host.
 *  2. (Phase H) the CDN probe, when a snapshot origin is configured — issued *before* the bundle,
 *     because the real client awaits it before starting the live fetch.
 *  3. GET /api/public/realtime-config and the tournament bundle — the page's only data requests.
 *  4. Open ONE EventSource-equivalent SSE stream to the assigned card and keep it open.
 *
 * The SSE client reproduces browser EventSource semantics: incremental frame parsing, `retry:`
 * hints, automatic reconnect with exponential backoff + full jitter, and a heartbeat watchdog
 * that kills silently-dead sockets exactly like a mobile browser losing radio.
 *
 * With no snapshot origin configured, step 2 does not exist and the request sequence is identical to
 * what it was before Phase H — that is what makes a run in this mode the ① baseline.
 */
import http from "node:http";
import https from "node:https";
import { pageUrlFor, type Config } from "../config.js";
import type { FleetRole, MetricsHub } from "../lib/metrics-hub.js";
import type { CountedHttp } from "../lib/request-ledger.js";
import { httpFor, probeSnapshot } from "../lib/snapshot-probe.js";

export interface ViewerTarget {
  token: string;
  cardId: string;
}

export interface ViewerOptions {
  /** Which half of the fleet this viewer's traffic is charged to. */
  fleet?: FleetRole;
  /** False when a caller has already performed the page-load requests (the fail-open fallback). */
  bootstrap?: boolean;
}

interface SseFrame {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}

function requester(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

export class Viewer {
  private readonly id: number;
  private readonly config: Config;
  private readonly hub: MetricsHub;
  private readonly target: ViewerTarget;
  private readonly fleet: FleetRole;
  private readonly doBootstrap: boolean;
  private readonly http: CountedHttp;

  private stopped = false;
  private request: http.ClientRequest | null = null;
  private response: http.IncomingMessage | null = null;
  private streamOpen = false;
  private lastActivityAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private serverRetryMs: number | null = null;

  constructor(
    id: number,
    target: ViewerTarget,
    config: Config,
    hub: MetricsHub,
    options: ViewerOptions = {},
  ) {
    this.id = id;
    this.target = target;
    this.config = config;
    this.hub = hub;
    this.fleet = options.fleet ?? "live";
    this.doBootstrap = options.bootstrap ?? true;
    this.http = httpFor(config, hub, this.fleet);
    // A viewer created as somebody else's fail-open fallback is already counted by its owner.
    if (this.doBootstrap) hub.registerViewer(this.fleet);
  }

  async start(): Promise<void> {
    if (this.doBootstrap) await this.bootstrap();
    if (!this.stopped) this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.streamOpen) {
      this.streamOpen = false;
      this.hub.streamClosed("stopped");
    }
    this.teardownSocket("stopped");
  }

  /** The page-load requests a real browser makes before its stream opens. */
  private async bootstrap(): Promise<void> {
    const started = Date.now();
    try {
      if (this.config.fetchPageDocument) {
        await this.timedFetch(pageUrlFor(this.config, this.target.token), "text/html");
      }
      // Phase H ④: the client awaits the probe before it starts the live fetch, so the probe's own
      // duration is exactly what a live viewer pays. Ordering it here rather than in parallel is
      // what makes that measurement faithful.
      if (this.config.snapshot.probeOnLive) {
        await probeSnapshot(this.config, this.hub, this.http, this.target.token, this.fleet);
      }
      await this.timedFetch(new URL("/api/public/realtime-config", this.config.publicApiOrigin).href, "application/json");
      await this.timedFetch(
        new URL(`/api/public/tournaments/${encodeURIComponent(this.target.token)}/bundle`, this.config.publicApiOrigin).href,
        "application/json",
      );
      this.hub.firstData(this.fleet, Date.now() - started);
      this.hub.bootstrapTimed(Date.now() - started);
    } catch {
      this.hub.httpError();
    }
  }

  private async timedFetch(url: string, accept: string): Promise<void> {
    const response = await this.http.fetch(url, accept);
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  }

  private connect(): void {
    if (this.stopped) return;
    this.hub.attempt(this.fleet);
    // An SSE stream is a Render request and is charged as one. A published viewer opening a stream
    // is therefore visible twice over in the ② criterion — as an attempt and as origin traffic.
    this.hub.originRequest(this.fleet);
    const url = new URL(
      `/api/public/cards/${encodeURIComponent(this.target.cardId)}/events`,
      this.config.publicApiOrigin,
    );
    const startedAt = Date.now();
    const request = requester(url).request(url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "cache-control": "no-cache",
        "user-agent": "ctwe-load-testing/1.0",
      },
    });
    this.request = request;

    request.setTimeout(this.config.requestTimeoutMs, () => {
      // No response headers in time: treat as a failed attempt.
      request.destroy(new Error("connect timeout"));
    });

    request.on("response", (response) => {
      this.response = response;
      // ClientRequest#setTimeout is only the response-header deadline. Once the stream opens,
      // heartbeatTimeoutMs owns inactivity detection; leaving this timer active would kill every
      // healthy stream whose heartbeat interval exceeds requestTimeoutMs.
      request.setTimeout(0);
      if (response.statusCode !== 200) {
        this.hub.rejected(response.statusCode ?? 0);
        response.resume();
        response.on("end", () => this.scheduleReconnect(true));
        response.on("error", () => this.scheduleReconnect(true));
        return;
      }
      // Stream established. From here every disconnect is a drop or a stall.
      this.streamOpen = true;
      this.consecutiveFailures = 0;
      this.hub.streamOpened(Date.now() - startedAt);
      this.lastActivityAt = Date.now();
      this.startWatchdog();

      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        this.lastActivityAt = Date.now();
        this.hub.bytes(Buffer.byteLength(chunk));
        // EventSource accepts CRLF and LF. Normalize incrementally so proxies cannot break frame
        // parsing by changing line endings.
        buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          this.handleFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      });
      const closed = () => this.handleStreamClosed("dropped");
      response.on("end", closed);
      response.on("error", closed);
      response.on("close", closed);
    });

    request.on("error", () => {
      if (this.streamOpen) {
        this.handleStreamClosed("dropped");
      } else {
        this.hub.rejected(0);
        this.scheduleReconnect(true);
      }
    });

    request.end();
  }

  private handleFrame(raw: string): void {
    const frame: SseFrame = { event: "message", data: "", id: null, retry: null };
    let sawField = false;
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      if (line.startsWith(":")) {
        // Comment frame — the server heartbeat.
        this.hub.heartbeat();
        continue;
      }
      sawField = true;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") frame.event = value;
      else if (field === "data") frame.data += (frame.data ? "\n" : "") + value;
      else if (field === "id") frame.id = value;
      else if (field === "retry") frame.retry = Number(value) || null;
    }
    if (!sawField) return;
    if (frame.retry) this.serverRetryMs = frame.retry;
    this.hub.event(frame.event);
  }

  /** Detects silently dead sockets the way a browser tab on flaky wifi experiences them. */
  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!this.streamOpen || this.stopped) return;
      if (Date.now() - this.lastActivityAt > this.config.heartbeatTimeoutMs) {
        this.handleStreamClosed("stalled");
      }
    }, Math.min(10_000, this.config.heartbeatTimeoutMs / 3));
    this.watchdog.unref?.();
  }

  private handleStreamClosed(reason: "dropped" | "stalled"): void {
    if (!this.streamOpen) return;
    this.streamOpen = false;
    this.hub.streamClosed(this.stopped ? "stopped" : reason);
    this.teardownSocket(reason);
    if (!this.stopped) {
      this.scheduleReconnect(false);
    }
  }

  private teardownSocket(_reason: string): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.response?.removeAllListeners();
    this.request?.destroy();
    this.request = null;
    this.response = null;
  }

  /** EventSource-style retry: server `retry:` hint when present, else backoff with full jitter. */
  private scheduleReconnect(failedAttempt: boolean): void {
    if (this.stopped || this.reconnectTimer) return;
    this.hub.reconnect();
    if (failedAttempt) this.consecutiveFailures += 1;
    const base = this.serverRetryMs ?? this.config.reconnectBaseMs;
    const backoff = Math.min(base * 2 ** this.consecutiveFailures, this.config.reconnectMaxMs);
    const delay = base + Math.random() * Math.max(0, backoff - base);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
