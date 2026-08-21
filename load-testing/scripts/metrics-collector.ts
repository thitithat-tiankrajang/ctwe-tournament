/**
 * Samples REAL backend metrics through Spring Boot Actuator (/actuator/metrics/*) using an
 * authenticated admin session — nothing is synthesized. Each sample captures the JVM, the SSE
 * gauges, the Hikari pool, and Tomcat, so every load stage can be judged on what the server
 * actually experienced, not just what clients observed.
 */
import type { Config } from "../config.js";
import { BackendSession } from "../lib/backend-session.js";

export interface BackendSample {
  at: string;
  ssePublicStreams: number | null;
  sseStaffStreams: number | null;
  processCpu: number | null;
  systemCpu: number | null;
  cpuCount: number | null;
  heapUsedBytes: number | null;
  heapMaxBytes: number | null;
  nonHeapUsedBytes: number | null;
  /**
   * Metaspace on its own, NOT folded into `nonHeapUsedBytes`.
   *
   * Aggregate non-heap is metaspace + code cache + compressed class space, so it cannot say which
   * ceiling is the one being approached. That blind spot is what let `-XX:MaxMetaspaceSize=96m` ship
   * against a boot-time reading: every stage reported non-heap pinned at ~140 MB, which looked like
   * a comfortable plateau and was actually metaspace running full against its own cap. Sample the
   * pool directly, and compare `metaspaceUsedBytes` to `metaspaceMaxBytes`, not to non-heap.
   */
  metaspaceUsedBytes: number | null;
  metaspaceMaxBytes: number | null;
  processRssBytes: number | null;
  directBufferUsedBytes: number | null;
  gcPauseCount: number | null;
  gcPauseTotalSec: number | null;
  gcPauseMaxSec: number | null;
  liveThreads: number | null;
  hikariActive: number | null;
  hikariPending: number | null;
  hikariMax: number | null;
  tomcatBusyThreads: number | null;
  tomcatConnections: number | null;
  httpRequestCount: number | null;
  httpRequestTotalSec: number | null;
  httpRequestMaxSec: number | null;
  httpServerErrorCount: number | null;
  /**
   * Caffeine counters for the public card cache (Phase H ③).
   *
   * Micrometer publishes these because `CacheConfiguration` builds every cache with `recordStats()`.
   * They are monotonic counters, so only the delta across a stage means anything — a ratio computed
   * from the absolute values would be dominated by whatever happened before the stage began.
   */
  publicCardCacheHits: number | null;
  publicCardCacheMisses: number | null;
}

export interface BackendWindowSummary {
  samples: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  systemCpuMax: number | null;
  cpuCount: number | null;
  heapUsedMaxBytes: number | null;
  heapMaxBytes: number | null;
  nonHeapUsedMaxBytes: number | null;
  metaspaceUsedMaxBytes: number | null;
  metaspaceMaxBytes: number | null;
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
  /** Public-card cache hits/misses during this stage only, and their ratio (null when unavailable). */
  publicCardCacheHits: number | null;
  publicCardCacheMisses: number | null;
  publicCardCacheHitRatio: number | null;
}

interface MetricResponse {
  measurements?: { statistic: string; value: number }[];
}

export class MetricsCollector {
  private readonly session: BackendSession;
  readonly available: boolean;

  constructor(config: Config) {
    this.available = Boolean(config.adminUser && config.adminPass);
    this.session = new BackendSession(config.backendOrigin, config.adminUser ?? "", config.adminPass ?? "");
  }

  async login(): Promise<void> {
    if (this.available) await this.session.login();
  }

  /** Effective realtime settings as the server sees them (verifies LOAD_TEST_MODE took effect). */
  async realtimeSettings(): Promise<{ maxPublicSseConnections: number; heartbeatIntervalMs: number } | null> {
    if (!this.available) return null;
    const response = await this.session.request("/api/admin/settings/realtime");
    if (!response.ok) return null;
    return await response.json() as { maxPublicSseConnections: number; heartbeatIntervalMs: number };
  }

  private async metric(name: string, statistic: string, tag?: string | string[]): Promise<number | null> {
    try {
      // Actuator selects a meter by repeating `tag`; `cache.gets` needs both the cache name and the
      // hit/miss result, so one tag is not enough.
      const tags = tag === undefined ? [] : Array.isArray(tag) ? tag : [tag];
      const query = tags.length === 0
        ? "" : `?${tags.map((value) => `tag=${encodeURIComponent(value)}`).join("&")}`;
      const response = await this.session.request(`/actuator/metrics/${name}${query}`);
      if (!response.ok) return null;
      const body = await response.json() as MetricResponse;
      return body.measurements?.find((m) => m.statistic === statistic)?.value ?? null;
    } catch {
      return null;
    }
  }

  async sample(): Promise<BackendSample | null> {
    if (!this.available) return null;
    const [
      ssePublicStreams, sseStaffStreams,
      processCpu, systemCpu, cpuCount,
      heapUsedBytes, heapMaxBytes, nonHeapUsedBytes, metaspaceUsedBytes, metaspaceMaxBytes,
      processRssBytes, directBufferUsedBytes,
      gcPauseCount, gcPauseTotalSec, gcPauseMaxSec,
      liveThreads, hikariActive, hikariPending, hikariMax,
      tomcatBusyThreads, tomcatConnections,
      httpRequestCount, httpRequestTotalSec, httpRequestMaxSec, httpServerErrorCount,
      publicCardCacheHits, publicCardCacheMisses,
    ] = await Promise.all([
      this.metric("sse.streams.public", "VALUE"),
      this.metric("sse.streams.staff", "VALUE"),
      this.metric("process.cpu.usage", "VALUE"),
      this.metric("system.cpu.usage", "VALUE"),
      this.metric("system.cpu.count", "VALUE"),
      this.metric("jvm.memory.used", "VALUE", "area:heap"),
      this.metric("jvm.memory.max", "VALUE", "area:heap"),
      this.metric("jvm.memory.used", "VALUE", "area:nonheap"),
      this.metric("jvm.memory.used", "VALUE", "id:Metaspace"),
      this.metric("jvm.memory.max", "VALUE", "id:Metaspace"),
      this.metric("process.memory.rss", "VALUE"),
      this.metric("jvm.buffer.memory.used", "VALUE", "id:direct"),
      this.metric("jvm.gc.pause", "COUNT"),
      this.metric("jvm.gc.pause", "TOTAL_TIME"),
      this.metric("jvm.gc.pause", "MAX"),
      this.metric("jvm.threads.live", "VALUE"),
      this.metric("hikaricp.connections.active", "VALUE"),
      this.metric("hikaricp.connections.pending", "VALUE"),
      this.metric("hikaricp.connections.max", "VALUE"),
      this.metric("tomcat.threads.busy", "VALUE"),
      this.metric("tomcat.connections.current", "VALUE"),
      this.metric("http.server.requests", "COUNT"),
      this.metric("http.server.requests", "TOTAL_TIME"),
      this.metric("http.server.requests", "MAX"),
      this.metric("http.server.requests", "COUNT", "outcome:SERVER_ERROR"),
      this.metric("cache.gets", "COUNT", ["cache:public-card-details", "result:hit"]),
      this.metric("cache.gets", "COUNT", ["cache:public-card-details", "result:miss"]),
    ]);
    return {
      at: new Date().toISOString(),
      ssePublicStreams, sseStaffStreams,
      processCpu, systemCpu, cpuCount,
      heapUsedBytes, heapMaxBytes, nonHeapUsedBytes, metaspaceUsedBytes, metaspaceMaxBytes,
      processRssBytes, directBufferUsedBytes,
      gcPauseCount, gcPauseTotalSec, gcPauseMaxSec,
      liveThreads, hikariActive, hikariPending, hikariMax,
      tomcatBusyThreads, tomcatConnections,
      httpRequestCount, httpRequestTotalSec, httpRequestMaxSec, httpServerErrorCount,
      publicCardCacheHits, publicCardCacheMisses,
    };
  }

  /** Collapse a stage's samples into the numbers the verdict and the runbook need. */
  static summarize(samples: BackendSample[], windowSeconds: number): BackendWindowSummary | null {
    if (samples.length === 0) return null;
    /**
     * CPU is a *rate*, and a stage's first sample cannot measure one.
     *
     * Micrometer derives `process.cpu.usage`/`system.cpu.usage` from the interval since the meter was
     * last read. The orchestrator takes the previous stage's `finalSample()` and then opens the next
     * stage's collect loop with an immediate `sample()`, so that interval is near-zero and the ratio
     * quantizes toward 1.0. A stage with 800/800 streams attached, zero rejections, zero reconnects
     * and a 14% average then reports `cpuMax` 100% and FAILs on it.
     *
     * What proves it is an artifact rather than load: the same 100% first sample appears in a
     * published-fleet stage that sent the backend no requests at all (4.8 rps of Actuator polling,
     * zero SSE), and `system.cpu.usage` spikes on the very same sample — the whole host reads
     * saturated for one reading and idle immediately after.
     *
     * Only the rate-derived readings drop that sample. Level gauges (heap, RSS, threads, pool,
     * Tomcat) and the cumulative counter deltas keep every sample, because they read correctly at
     * any interval. The raw sample still goes to `backendSamples`, so the record hides nothing.
     */
    const rateSamples = samples.length > 1 ? samples.slice(1) : samples;
    const values = (pick: (sample: BackendSample) => number | null, from: BackendSample[] = samples) =>
      from.map(pick).filter((value): value is number => value !== null);
    const max = (pick: (sample: BackendSample) => number | null, from: BackendSample[] = samples) => {
      const list = values(pick, from);
      return list.length ? Math.max(...list) : null;
    };
    const avg = (pick: (sample: BackendSample) => number | null, from: BackendSample[] = samples) => {
      const list = values(pick, from);
      return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
    };
    const first = samples[0];
    const last = samples[samples.length - 1];
    const delta = (pick: (sample: BackendSample) => number | null) => {
      const start = pick(first);
      const end = pick(last);
      return start !== null && end !== null ? Math.max(0, end - start) : null;
    };
    const requestDelta = delta((sample) => sample.httpRequestCount);
    const requestTimeDelta = delta((sample) => sample.httpRequestTotalSec);
    // The outcome:SERVER_ERROR tagged meter does not exist until the first 5xx. Treat an absent
    // first sample as zero when a later sample appears, otherwise the first error in a run would
    // be silently lost.
    const cacheHits = delta((sample) => sample.publicCardCacheHits);
    const cacheMisses = delta((sample) => sample.publicCardCacheMisses);
    const cacheLookups = cacheHits === null || cacheMisses === null ? null : cacheHits + cacheMisses;

    const endingServerErrors = last.httpServerErrorCount;
    const serverErrorDelta = endingServerErrors === null
      ? null : Math.max(0, endingServerErrors - (first.httpServerErrorCount ?? 0));
    return {
      samples: samples.length,
      cpuAvg: avg((sample) => sample.processCpu, rateSamples),
      cpuMax: max((sample) => sample.processCpu, rateSamples),
      systemCpuMax: max((sample) => sample.systemCpu, rateSamples),
      cpuCount: last.cpuCount,
      heapUsedMaxBytes: max((sample) => sample.heapUsedBytes),
      heapMaxBytes: last.heapMaxBytes,
      nonHeapUsedMaxBytes: max((sample) => sample.nonHeapUsedBytes),
      metaspaceUsedMaxBytes: max((sample) => sample.metaspaceUsedBytes),
      metaspaceMaxBytes: max((sample) => sample.metaspaceMaxBytes),
      processRssMaxBytes: max((sample) => sample.processRssBytes),
      directBufferUsedMaxBytes: max((sample) => sample.directBufferUsedBytes),
      gcPauses: delta((sample) => sample.gcPauseCount),
      gcPauseTotalSec: delta((sample) => sample.gcPauseTotalSec),
      gcPauseMaxSec: max((sample) => sample.gcPauseMaxSec),
      liveThreadsMax: max((sample) => sample.liveThreads),
      hikariActiveMax: max((sample) => sample.hikariActive),
      hikariPendingMax: max((sample) => sample.hikariPending),
      hikariMax: last.hikariMax,
      tomcatBusyMax: max((sample) => sample.tomcatBusyThreads),
      tomcatConnectionsMax: max((sample) => sample.tomcatConnections),
      sseStreamsMax: max((sample) => sample.ssePublicStreams),
      requestsPerSecond: requestDelta !== null && windowSeconds > 0
        ? Math.round((requestDelta / windowSeconds) * 10) / 10 : null,
      serverAvgLatencyMs: requestDelta && requestTimeDelta !== null && requestDelta > 0
        ? Math.round((requestTimeDelta / requestDelta) * 10000) / 10 : null,
      serverMaxLatencyMs: max((sample) => sample.httpRequestMaxSec) === null
        ? null : Math.round(max((sample) => sample.httpRequestMaxSec)! * 10_000) / 10,
      serverErrors: serverErrorDelta,
      publicCardCacheHits: cacheHits,
      publicCardCacheMisses: cacheMisses,
      // A stage with no cache lookups at all has no ratio; zero would read as "0% hit rate", which
      // is a different and wrong claim.
      publicCardCacheHitRatio: cacheLookups === null || cacheLookups === 0 || cacheHits === null
        ? null : cacheHits / cacheLookups,
    };
  }
}
