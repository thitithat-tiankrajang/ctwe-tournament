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
}

export class MetricsHub {
  // Gauges survive stage resets — they describe the fleet, not the window.
  activeStreams = 0;
  private peakActiveStreams = 0;

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

  private readonly connectMs = new Reservoir();
  private readonly bootstrapMs = new Reservoir();
  private readonly httpRequestMs = new Reservoir();
  private readonly eventLatencyMs = new Reservoir();
  private readonly writeMs = new Reservoir();

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

  attempt(): void { this.sseAttempts += 1; }
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
    };
  }
}
