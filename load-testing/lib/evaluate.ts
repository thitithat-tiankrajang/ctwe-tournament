/**
 * Stage verdicts. A stage PASSes when the server AND the viewer fleet both stayed healthy for the
 * whole hold window; it is NEAR LIMIT when any signal used most of its budget; it FAILs on any
 * hard breach. The runbook derives the safe operating limit from these verdicts.
 */
import type { Fleet, Thresholds } from "../config.js";
import type { SnapshotFleetSnapshot, StageClientSnapshot } from "./metrics-hub.js";
import type { BackendWindowSummary } from "../scripts/metrics-collector.js";

export type Verdict = "PASS" | "NEAR LIMIT" | "FAIL";

export interface Evaluation {
  verdict: Verdict;
  breaches: string[];
  warnings: string[];
  /** Phase H criteria judged on this stage. Empty when no snapshot origin was configured. */
  snapshotCriteria: SnapshotCriterion[];
}

/**
 * A Phase H acceptance criterion, judged per stage.
 *
 * `NOT MEASURED` is a first-class outcome and is never silently promoted to PASS. Measurement ④ in
 * particular depends on a Cloudflare edge being in front of the bucket; against a bare origin the
 * `cf-cache-status` header simply does not exist, and reporting "no evidence" is the only honest
 * answer available to a run that has no edge.
 */
export interface SnapshotCriterion {
  id: string;
  label: string;
  status: "PASS" | "FAIL" | "NOT MEASURED";
  detail: string;
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

const tally = (counts: Record<string, number>) =>
  Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(", ") || "none";

/**
 * Phase H measurements ② and ④, judged on one stage's hold window.
 *
 * ① and ③ are cross-run comparisons — a published run against a baseline run — so they are computed
 * by the runbook generator, which is the only place that holds two runs at once.
 */
export function evaluateSnapshot(
  fleet: Fleet,
  snapshotConfigured: boolean,
  snapshot: SnapshotFleetSnapshot,
  thresholds: Thresholds,
): { breaches: string[]; warnings: string[]; criteria: SnapshotCriterion[] } {
  const breaches: string[] = [];
  const warnings: string[] = [];
  const criteria: SnapshotCriterion[] = [];
  if (!snapshotConfigured) return { breaches, warnings, criteria };

  const hasPublished = snapshot.publishedViewers > 0;
  const originRequests = snapshot.publishedOriginRequests;
  const sseAttempts = snapshot.publishedSseAttempts;

  // ---------------------------------------------------------------- ② zero Render, zero SSE
  if (!hasPublished) {
    criteria.push({
      id: "H2",
      label: "Published fleet issues zero Render requests and zero SSE connections",
      status: "NOT MEASURED",
      detail: `No published viewers in this fleet (FLEET=${fleet}).`,
    });
  } else if (snapshot.probesPublished === 0) {
    // The trap this guards: a fleet whose tokens are not actually published probes, 404s, falls
    // through to the live path, and would otherwise be reported as "a published fleet under load".
    const detail = `${snapshot.publishedViewers} published viewer(s) resolved no snapshot at all `
      + `(404=${snapshot.probesNotPublished}, timeout=${snapshot.probesTimedOut}, `
      + `error=${snapshot.probesFailed}, unusable=${snapshot.probesUnusable}). `
      + "Nothing about the published path was exercised.";
    breaches.push(`published fleet never resolved a snapshot — ${detail}`);
    criteria.push({ id: "H2", label: "Published fleet issues zero Render requests and zero SSE connections", status: "FAIL", detail });
  } else if (originRequests > 0 || sseAttempts > 0) {
    const detail = `${originRequests} Render request(s) and ${sseAttempts} SSE attempt(s) from the `
      + `published fleet; ${snapshot.publishedFallbacks} viewer(s) fell through to the live path.`;
    breaches.push(`published fleet contacted Render — ${detail}`);
    criteria.push({ id: "H2", label: "Published fleet issues zero Render requests and zero SSE connections", status: "FAIL", detail });
  } else {
    criteria.push({
      id: "H2",
      label: "Published fleet issues zero Render requests and zero SSE connections",
      status: "PASS",
      detail: `${snapshot.publishedViewers} published viewer(s) in the fleet, ${snapshot.probesPublished} `
        + "snapshot(s) resolved from the CDN during this window (viewers added in earlier stages do "
        + "not re-probe, exactly as the browser's session memo prevents), 0 Render requests, 0 SSE "
        + "connections.",
    });
  }

  // A live-fleet token that answers 200 is published, which silently invalidates the baseline it is
  // supposed to provide.
  if (snapshot.liveFleetProbeHits > 0) {
    breaches.push(
      `${snapshot.liveFleetProbeHits} live-fleet probe(s) returned a published snapshot — the live `
      + "control tournament is itself published, so its numbers are not a live baseline",
    );
  }

  // ------------------------------------------------------------------------ ④a probe cost
  const probeP95 = snapshot.probeMs.p95;
  if (snapshot.probes === 0 || probeP95 === null) {
    criteria.push({
      id: "H4a",
      label: `Live-path added latency per viewer p95 ≤ ${thresholds.maxProbeP95Ms} ms`,
      status: "NOT MEASURED",
      detail: "No probes were issued (SNAPSHOT_PROBE_ON_LIVE is off).",
    });
  } else if (probeP95 > thresholds.maxProbeP95Ms) {
    breaches.push(`snapshot probe p95 ${probeP95}ms exceeds the ${thresholds.maxProbeP95Ms}ms live-path budget`);
    criteria.push({
      id: "H4a",
      label: `Live-path added latency per viewer p95 ≤ ${thresholds.maxProbeP95Ms} ms`,
      status: "FAIL",
      detail: `p95 ${probeP95} ms over ${snapshot.probes} probe(s); the client awaits the probe `
        + "before the live bundle, so per viewer this is exactly the added time-to-first-data.",
    });
  } else {
    nearLimit(probeP95, thresholds.maxProbeP95Ms, "snapshot probe p95", warnings, thresholds);
    criteria.push({
      id: "H4a",
      label: `Live-path added latency per viewer p95 ≤ ${thresholds.maxProbeP95Ms} ms`,
      status: "PASS",
      detail: `p95 ${probeP95} ms (avg ${snapshot.probeMs.avg ?? "—"} ms, max ${snapshot.probeMs.max ?? "—"} ms) `
        + `over ${snapshot.probes} probe(s).`,
    });
  }

  // ------------------------------------------------------------------- ④b 404s served by the edge
  //
  // Judged on the WARM lookups only. §2.5(2) asks about the edge "at steady state", and the first
  // lookup of a key is the one that populates the negative cache — it is supposed to MISS. Including
  // it would penalise the mechanism for working, and at small viewer counts would make the criterion
  // impossible to satisfy at all.
  const edge404 = snapshot.edgeStatus404;
  const cold404 = snapshot.edgeStatus404Cold;
  const coldTotal = Object.values(cold404).reduce((sum, count) => sum + count, 0);
  const total404 = Object.values(edge404).reduce((sum, count) => sum + count, 0);
  const hits404 = edge404.HIT ?? 0;
  const absent404 = edge404.ABSENT ?? 0;
  const label4b = `404 probes served from the edge ≥ ${pct(thresholds.minEdgeHitRatio)} (steady state)`;
  if (total404 === 0) {
    criteria.push({
      id: "H4b",
      label: label4b,
      status: "NOT MEASURED",
      detail: coldTotal > 0
        ? `Only ${coldTotal} cold first-lookup(s) were observed (${tally(cold404)}); every key was `
          + "probed exactly once, so the edge never had a repeat to answer from cache. Raise the "
          + "viewer count or lengthen the hold so keys are looked up more than once."
        : "No 404 probes were observed.",
    });
  } else if (absent404 === total404) {
    const detail = "No `cf-cache-status` header on any 404 probe: nothing proves a Cloudflare edge "
      + "answered. This measurement needs the CDN in front of the public bucket.";
    warnings.push("snapshot 404 probes carried no cf-cache-status header (no edge in front of the origin)");
    criteria.push({ id: "H4b", label: label4b, status: "NOT MEASURED", detail });
  } else {
    const ratio = hits404 / total404;
    const detail = `${hits404}/${total404} repeat 404 lookups were edge HITs (${pct(ratio)}); `
      + `statuses: ${tally(edge404)}. Excluded ${coldTotal} cold first-lookup(s) (${tally(cold404)}), `
      + "which populate the negative cache and are expected to MISS.";
    if (ratio < thresholds.minEdgeHitRatio) {
      breaches.push(`only ${pct(ratio)} of 404 probes were edge HITs (need ${pct(thresholds.minEdgeHitRatio)})`);
      criteria.push({ id: "H4b", label: label4b, status: "FAIL", detail });
    } else {
      criteria.push({ id: "H4b", label: label4b, status: "PASS", detail });
    }
  }

  return { breaches, warnings, criteria };
}

function nearLimit(value: number, limit: number, label: string, warnings: string[], thresholds: Thresholds): void {
  if (value >= limit * thresholds.nearLimitRatio) {
    warnings.push(`${label} at ${Math.round((value / limit) * 100)}% of its budget`);
  }
}

export function evaluateStage(
  target: number,
  client: StageClientSnapshot,
  backend: BackendWindowSummary | null,
  thresholds: Thresholds,
  snapshotContext: { fleet: Fleet; configured: boolean } | null = null,
): Evaluation {
  const breaches: string[] = [];
  const warnings: string[] = [];
  const near = (value: number, limit: number, label: string) => {
    if (value >= limit * thresholds.nearLimitRatio) warnings.push(`${label} at ${Math.round((value / limit) * 100)}% of its budget`);
  };

  // Only live viewers are supposed to hold a stream. A published viewer that resolved its snapshot
  // holds none *by design*, so measuring it against the attach ratio would turn Phase H's central
  // success into a failure. In a live-only fleet this is exactly the previous denominator.
  const streamTarget = snapshotContext?.configured ? client.snapshot.liveViewers : target;
  if (streamTarget > 0) {
    const attachRatio = client.activeStreams / streamTarget;
    if (attachRatio < thresholds.minAttachRatio) {
      breaches.push(`only ${client.activeStreams}/${streamTarget} streams attached (${pct(attachRatio)})`);
    }
  }

  const errorRatePct = ((client.sseRejected + client.sseDropped + client.sseStalled) / Math.max(1, streamTarget)) * 100;
  if (errorRatePct > thresholds.maxErrorRatePct) {
    breaches.push(`SSE error rate ${errorRatePct.toFixed(2)}% (rejected=${client.sseRejected}, dropped=${client.sseDropped}, stalled=${client.sseStalled})`);
  } else {
    near(errorRatePct, thresholds.maxErrorRatePct, "SSE error rate");
  }

  const httpErrorRatePct = (client.httpErrors / Math.max(1, client.httpRequests)) * 100;
  if (httpErrorRatePct > thresholds.maxHttpErrorRatePct) {
    breaches.push(`HTTP error rate ${httpErrorRatePct.toFixed(2)}% (${client.httpErrors}/${client.httpRequests})`);
  } else {
    near(httpErrorRatePct, thresholds.maxHttpErrorRatePct, "HTTP error rate");
  }

  if (client.httpRequestMs.p99 !== null) {
    if (client.httpRequestMs.p99 > thresholds.maxHttpP99Ms)
      breaches.push(`HTTP response p99 ${client.httpRequestMs.p99}ms`);
    else near(client.httpRequestMs.p99, thresholds.maxHttpP99Ms, "HTTP response p99");
  }

  if (client.connectMs.p99 !== null) {
    if (client.connectMs.p99 > thresholds.maxConnectP99Ms) breaches.push(`SSE connect p99 ${client.connectMs.p99}ms`);
    else near(client.connectMs.p99, thresholds.maxConnectP99Ms, "SSE connect p99");
  }

  const minutes = Math.max(1 / 60, client.windowSeconds / 60);
  const reconnectsPerMinPer1k = client.reconnects / minutes / Math.max(0.001, streamTarget / 1000);
  if (reconnectsPerMinPer1k > thresholds.maxReconnectsPerMinPer1k) {
    breaches.push(`reconnect churn ${reconnectsPerMinPer1k.toFixed(1)}/min/1k viewers`);
  } else {
    near(reconnectsPerMinPer1k, thresholds.maxReconnectsPerMinPer1k, "reconnect churn");
  }

  if (client.eventLatencyMs.count >= 5 && client.eventLatencyMs.p95 !== null) {
    if (client.eventLatencyMs.p95 > thresholds.maxEventLatencyP95Ms) breaches.push(`event fan-out p95 ${client.eventLatencyMs.p95}ms`);
    else near(client.eventLatencyMs.p95, thresholds.maxEventLatencyP95Ms, "event fan-out p95");
  }

  if (backend) {
    if (backend.cpuMax !== null) {
      if (backend.cpuMax > thresholds.maxProcessCpu) breaches.push(`process CPU peaked at ${pct(backend.cpuMax)}`);
      else near(backend.cpuMax, thresholds.maxProcessCpu, "process CPU");
    }
    if (backend.heapUsedMaxBytes !== null && backend.heapMaxBytes) {
      const heapRatio = backend.heapUsedMaxBytes / backend.heapMaxBytes;
      if (heapRatio > thresholds.maxHeapRatio) breaches.push(`heap peaked at ${pct(heapRatio)} of max`);
      else near(heapRatio, thresholds.maxHeapRatio, "heap usage");
    }
    if (backend.metaspaceUsedMaxBytes !== null && backend.metaspaceMaxBytes) {
      const metaspaceRatio = backend.metaspaceUsedMaxBytes / backend.metaspaceMaxBytes;
      if (metaspaceRatio > thresholds.maxMetaspaceRatio) breaches.push(`metaspace peaked at ${pct(metaspaceRatio)} of max`);
      else near(metaspaceRatio, thresholds.maxMetaspaceRatio, "metaspace usage");
    }
    if ((backend.hikariPendingMax ?? 0) > 0) {
      warnings.push(`database pool had ${backend.hikariPendingMax} pending acquisition(s)`);
    }
    if ((backend.gcPauseMaxSec ?? 0) > 1) {
      warnings.push(`GC pause up to ${(backend.gcPauseMaxSec! * 1000).toFixed(0)}ms observed`);
    }
    if ((backend.serverErrors ?? 0) > 0) {
      breaches.push(`${backend.serverErrors} backend HTTP 5xx response(s) observed`);
    }
  }

  const snapshotResult = evaluateSnapshot(
    snapshotContext?.fleet ?? "live",
    snapshotContext?.configured ?? false,
    client.snapshot,
    thresholds,
  );
  breaches.push(...snapshotResult.breaches);
  warnings.push(...snapshotResult.warnings);

  const verdict: Verdict = breaches.length > 0 ? "FAIL" : warnings.length > 0 ? "NEAR LIMIT" : "PASS";
  return { verdict, breaches, warnings, snapshotCriteria: snapshotResult.criteria };
}
