/**
 * In-process metrics for the viewer fleet. One hub is shared by every simulated viewer and the
 * staff-activity writer; the orchestrator resets it at the start of each stage's hold window and
 * snapshots it at the end, so every stage reports only its own steady-state behavior.
 */

/** Bounded reservoir so 10k viewers cannot grow an unbounded latency array. */
class Reservoir {
  private readonly capacity: number;
  private samples: number[] = [];
  private seen = 0;

  constructor(capacity = 20_000) {
    this.capacity = capacity;
  }

  record(value: number): void {
    this.seen += 1;
    if (this.samples.length < this.capacity) {
      this.samples.push(value);
      return;
    }
    const slot = Math.floor(Math.random() * this.seen);
    if (slot < this.capacity) this.samples[slot] = value;
  }

  reset(): void {
    this.samples = [];
    this.seen = 0;
  }

  summary(): { count: number; avg: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null } {
    if (this.samples.length === 0) return { count: this.seen, avg: null, p50: null, p95: null, p99: null, max: null };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    return {
      count: this.seen,
      avg: Math.round(avg * 10) / 10,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted[sorted.length - 1],
    };
  }
}

export type Distribution = ReturnType<Reservoir["summary"]>;

/** Which half of the fleet a measurement belongs to. */
export type FleetRole = "live" | "published";

/**
 * How one snapshot probe ended, in the client's own terms
 * (`src/infrastructure/http/snapshot-api.ts`).
 *
 * `unusable` is the 200-but-unreadable case — an envelope schema this build does not understand, or
 * a malformed body. It is kept apart from `error` because it means the CDN is serving something,
 * which is a different operational problem from the CDN being unreachable.
 */
export type ProbeOutcome = "published" | "not-published" | "timeout" | "error" | "unusable";

export interface ProbeResult {
  fleet: FleetRole;
  outcome: ProbeOutcome;
  durationMs: number;
  /** The `cf-cache-status` response header, or null when no Cloudflare edge answered. */
  edgeStatus: string | null;
  /** The object key probed. Used to tell a cold first lookup from a warm repeat one. */
  key: string;
}

/**
 * Everything Phase H asserts on. Deliberately counted rather than inferred: the zero-Render claim is
 * only meaningful if origin traffic from the published fleet is observed and reported, including the
 * fail-open fallback that a real client performs when a snapshot is missing.
 */
export interface SnapshotFleetSnapshot {
  liveViewers: number;
  publishedViewers: number;
  probes: number;
  probesPublished: number;
  probesNotPublished: number;
  probesTimedOut: number;
  probesFailed: number;
  probesUnusable: number;
  /** A probe on a LIVE-fleet token that returned a snapshot: that token is published after all. */
  liveFleetProbeHits: number;
  probeMs: Distribution;
  /** Requests the published fleet sent to Render. Phase H ② requires this to be zero. */
  publishedOriginRequests: number;
  /** SSE connection attempts by the published fleet. Phase H ② requires this to be zero. */
  publishedSseAttempts: number;
  /** Published viewers that fell through to the live path (each one explains an origin request). */
  publishedFallbacks: number;
  liveOriginRequests: number;
  cdnRequests: number;
  cdnBytes: number;
  /**
   * `cf-cache-status` tallies, kept separate because ④ is specifically about the 404 probes, and
   * split cold/warm because architecture §2.5(2) asks for the edge's behaviour **at steady state**.
   *
   * The first lookup of a given key is the one that populates the edge's negative cache, so it is
   * expected to MISS by design — that is the mechanism working, not failing. Counting it against the
   * hit ratio would make the criterion unsatisfiable at small viewer counts and would misdescribe it
   * at large ones. `…Cold` holds those first-per-key lookups; `…` holds every repeat, and the repeats
   * are what the ratio is computed over.
   */
  edgeStatus200: Record<string, number>;
  edgeStatus404: Record<string, number>;
  edgeStatus200Cold: Record<string, number>;
  edgeStatus404Cold: Record<string, number>;
  liveFirstDataMs: Distribution;
  publishedFirstDataMs: Distribution;
}

export interface StageClientSnapshot {
  windowSeconds: number;
  activeStreams: number;
  peakActiveStreams: number;
  sseAttempts: number;
  sseOpened: number;
  sseRejected: number;
  sseRejectedByStatus: Record<string, number>;
  sseDropped: number;
  sseStalled: number;
  reconnects: number;
  events: number;
  heartbeats: number;
  bytesReceived: number;
  httpRequests: number;
  httpErrors: number;
  httpRequestsPerSecond: number;
  connectMs: ReturnType<Reservoir["summary"]>;
  bootstrapMs: ReturnType<Reservoir["summary"]>;
  httpRequestMs: ReturnType<Reservoir["summary"]>;
  eventLatencyMs: ReturnType<Reservoir["summary"]>;
  writeMs: ReturnType<Reservoir["summary"]>;
  writes: number;
  writeErrors: number;
  snapshot: SnapshotFleetSnapshot;
}

export class MetricsHub {
  // Gauges survive stage resets — they describe the fleet, not the window.
  activeStreams = 0;
  private peakActiveStreams = 0;
  private liveViewers = 0;
  private publishedViewers = 0;

  // Window counters, reset per stage.
  private sseAttempts = 0;
  private sseOpened = 0;
  private sseRejected = 0;
  private sseRejectedByStatus: Record<string, number> = {};
  private sseDropped = 0;
  private sseStalled = 0;
  private reconnects = 0;
  private events = 0;
  private heartbeats = 0;
  private bytesReceived = 0;
  private httpRequests = 0;
  private httpErrors = 0;
  private writes = 0;
  private writeErrors = 0;

  // Phase H window counters.
  private probes = 0;
  private probesPublished = 0;
  private probesNotPublished = 0;
  private probesTimedOut = 0;
  private probesFailed = 0;
  private probesUnusable = 0;
  private liveFleetProbeHits = 0;
  private publishedOriginRequests = 0;
  private publishedSseAttempts = 0;
  private publishedFallbacks = 0;
  private liveOriginRequests = 0;
  private cdnRequests = 0;
  private cdnBytesReceived = 0;
  private edgeStatus200: Record<string, number> = {};
  private edgeStatus404: Record<string, number> = {};
  private edgeStatus200Cold: Record<string, number> = {};
  private edgeStatus404Cold: Record<string, number> = {};
  /** Keys probed at least once in this window; a repeat is a lookup the edge could have cached. */
  private probedKeys = new Set<string>();

  private readonly connectMs = new Reservoir();
  private readonly bootstrapMs = new Reservoir();
  private readonly httpRequestMs = new Reservoir();
  private readonly eventLatencyMs = new Reservoir();
  private readonly writeMs = new Reservoir();
  private readonly probeMs = new Reservoir();
  private readonly liveFirstDataMs = new Reservoir();
  private readonly publishedFirstDataMs = new Reservoir();

  /**
   * Staff-write correlation. There is exactly ONE writer and writes are many seconds apart while
   * fan-out completes in milliseconds-to-seconds, so a `result` event arriving within the write
   * window unambiguously belongs to the latest write — no version bookkeeping needed (the staff
   * response carries the card version while public events carry public_version; they differ).
   */
  private lastWriteAt: number | null = null;
  private readonly writeWindowMs: number;

  private windowStartedAt = Date.now();

  constructor(writeWindowMs = 10_000) {
    this.writeWindowMs = writeWindowMs;
  }

  streamOpened(connectDurationMs: number): void {
    this.activeStreams += 1;
    this.peakActiveStreams = Math.max(this.peakActiveStreams, this.activeStreams);
    this.sseOpened += 1;
    this.connectMs.record(connectDurationMs);
  }

  streamClosed(reason: "dropped" | "stalled" | "stopped"): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
    if (reason === "dropped") this.sseDropped += 1;
    if (reason === "stalled") this.sseStalled += 1;
  }

  attempt(fleet: FleetRole = "live"): void {
    this.sseAttempts += 1;
    // A published viewer must never open a stream. Counting rather than forbidding is deliberate:
    // the scenario is free to behave like the real fail-open client, and the criterion catches it.
    if (fleet === "published") this.publishedSseAttempts += 1;
  }
  rejected(status: number): void {
    this.sseRejected += 1;
    const key = String(status);
    this.sseRejectedByStatus[key] = (this.sseRejectedByStatus[key] ?? 0) + 1;
  }
  reconnect(): void { this.reconnects += 1; }
  heartbeat(): void { this.heartbeats += 1; }
  bytes(count: number): void { this.bytesReceived += count; }
  httpResponse(durationMs: number, ok: boolean): void {
    this.httpRequests += 1;
    this.httpRequestMs.record(durationMs);
    if (!ok) this.httpErrors += 1;
  }
  httpError(): void {
    this.httpRequests += 1;
    this.httpErrors += 1;
  }
  bootstrapTimed(ms: number): void { this.bootstrapMs.record(ms); }

  event(name: string): void {
    this.events += 1;
    if (name !== "result" || this.lastWriteAt === null) return;
    const sinceWrite = Date.now() - this.lastWriteAt;
    if (sinceWrite <= this.writeWindowMs) this.eventLatencyMs.record(sinceWrite);
  }

  registerWrite(completedAt: number, durationMs: number): void {
    this.writes += 1;
    this.writeMs.record(durationMs);
    this.lastWriteAt = completedAt;
  }

  writeFailed(): void { this.writeErrors += 1; }

  // ------------------------------------------------------------------------------------ Phase H

  registerViewer(fleet: FleetRole): void {
    if (fleet === "published") this.publishedViewers += 1;
    else this.liveViewers += 1;
  }

  /** One completed CDN probe, with the edge's own verdict on whether it answered from cache. */
  probeCompleted(result: ProbeResult): void {
    this.probes += 1;
    this.probeMs.record(result.durationMs);
    switch (result.outcome) {
      case "published": this.probesPublished += 1; break;
      case "not-published": this.probesNotPublished += 1; break;
      case "timeout": this.probesTimedOut += 1; break;
      case "unusable": this.probesUnusable += 1; break;
      default: this.probesFailed += 1;
    }
    if (result.fleet === "live" && result.outcome === "published") this.liveFleetProbeHits += 1;

    // An absent header is recorded as "absent", never folded into MISS: no Cloudflare answered, so
    // ④ has no evidence either way and must report "not measured" rather than a ratio.
    const cold = !this.probedKeys.has(result.key);
    this.probedKeys.add(result.key);
    const bucket = result.outcome === "published"
      ? (cold ? this.edgeStatus200Cold : this.edgeStatus200)
      : result.outcome === "not-published"
        ? (cold ? this.edgeStatus404Cold : this.edgeStatus404)
        : null;
    if (bucket) {
      const status = (result.edgeStatus ?? "absent").toUpperCase();
      bucket[status] = (bucket[status] ?? 0) + 1;
    }
  }

  /** Every request that reached Render, attributed to the fleet that issued it. */
  originRequest(fleet: FleetRole): void {
    if (fleet === "published") this.publishedOriginRequests += 1;
    else this.liveOriginRequests += 1;
  }

  cdnRequest(bytes: number): void {
    this.cdnRequests += 1;
    this.cdnBytesReceived += bytes;
  }

  /** A published viewer that could not resolve a snapshot and took the live path instead. */
  publishedFallback(): void { this.publishedFallbacks += 1; }

  /** Page-open to tournament-data-in-hand, whichever path supplied it. */
  firstData(fleet: FleetRole, ms: number): void {
    if (fleet === "published") this.publishedFirstDataMs.record(ms);
    else this.liveFirstDataMs.record(ms);
  }

  private snapshotFleet(): SnapshotFleetSnapshot {
    return {
      liveViewers: this.liveViewers,
      publishedViewers: this.publishedViewers,
      probes: this.probes,
      probesPublished: this.probesPublished,
      probesNotPublished: this.probesNotPublished,
      probesTimedOut: this.probesTimedOut,
      probesFailed: this.probesFailed,
      probesUnusable: this.probesUnusable,
      liveFleetProbeHits: this.liveFleetProbeHits,
      probeMs: this.probeMs.summary(),
      publishedOriginRequests: this.publishedOriginRequests,
      publishedSseAttempts: this.publishedSseAttempts,
      publishedFallbacks: this.publishedFallbacks,
      liveOriginRequests: this.liveOriginRequests,
      cdnRequests: this.cdnRequests,
      cdnBytes: this.cdnBytesReceived,
      edgeStatus200: { ...this.edgeStatus200 },
      edgeStatus404: { ...this.edgeStatus404 },
      edgeStatus200Cold: { ...this.edgeStatus200Cold },
      edgeStatus404Cold: { ...this.edgeStatus404Cold },
      liveFirstDataMs: this.liveFirstDataMs.summary(),
      publishedFirstDataMs: this.publishedFirstDataMs.summary(),
    };
  }

  resetWindow(): void {
    this.sseAttempts = 0;
    this.sseOpened = 0;
    this.sseRejected = 0;
    this.sseRejectedByStatus = {};
    this.sseDropped = 0;
    this.sseStalled = 0;
    this.reconnects = 0;
    this.events = 0;
    this.heartbeats = 0;
    this.bytesReceived = 0;
    this.httpRequests = 0;
    this.httpErrors = 0;
    this.writes = 0;
    this.writeErrors = 0;
    this.probes = 0;
    this.probesPublished = 0;
    this.probesNotPublished = 0;
    this.probesTimedOut = 0;
    this.probesFailed = 0;
    this.probesUnusable = 0;
    this.liveFleetProbeHits = 0;
    this.publishedOriginRequests = 0;
    this.publishedSseAttempts = 0;
    this.publishedFallbacks = 0;
    this.liveOriginRequests = 0;
    this.cdnRequests = 0;
    this.cdnBytesReceived = 0;
    this.edgeStatus200 = {};
    this.edgeStatus404 = {};
    this.edgeStatus200Cold = {};
    this.edgeStatus404Cold = {};
    this.probedKeys.clear();
    this.probeMs.reset();
    this.liveFirstDataMs.reset();
    this.publishedFirstDataMs.reset();
    this.connectMs.reset();
    this.bootstrapMs.reset();
    this.httpRequestMs.reset();
    this.eventLatencyMs.reset();
    this.writeMs.reset();
    this.peakActiveStreams = this.activeStreams;
    this.windowStartedAt = Date.now();
  }

  snapshot(): StageClientSnapshot {
    const windowSeconds = Math.max(1, Math.round((Date.now() - this.windowStartedAt) / 1000));
    return {
      windowSeconds,
      activeStreams: this.activeStreams,
      peakActiveStreams: this.peakActiveStreams,
      sseAttempts: this.sseAttempts,
      sseOpened: this.sseOpened,
      sseRejected: this.sseRejected,
      sseRejectedByStatus: { ...this.sseRejectedByStatus },
      sseDropped: this.sseDropped,
      sseStalled: this.sseStalled,
      reconnects: this.reconnects,
      events: this.events,
      heartbeats: this.heartbeats,
      bytesReceived: this.bytesReceived,
      httpRequests: this.httpRequests,
      httpErrors: this.httpErrors,
      httpRequestsPerSecond: Math.round((this.httpRequests / windowSeconds) * 10) / 10,
      connectMs: this.connectMs.summary(),
      bootstrapMs: this.bootstrapMs.summary(),
      httpRequestMs: this.httpRequestMs.summary(),
      eventLatencyMs: this.eventLatencyMs.summary(),
      writeMs: this.writeMs.summary(),
      writes: this.writes,
      writeErrors: this.writeErrors,
      snapshot: this.snapshotFleet(),
    };
  }
}
