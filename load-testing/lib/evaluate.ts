/**
 * Stage verdicts. A stage PASSes when the server AND the viewer fleet both stayed healthy for the
 * whole hold window; it is NEAR LIMIT when any signal used most of its budget; it FAILs on any
 * hard breach. The runbook derives the safe operating limit from these verdicts.
 */
import type { Thresholds } from "../config.js";
import type { StageClientSnapshot } from "./metrics-hub.js";
import type { BackendWindowSummary } from "../scripts/metrics-collector.js";

export type Verdict = "PASS" | "NEAR LIMIT" | "FAIL";

export interface Evaluation {
  verdict: Verdict;
  breaches: string[];
  warnings: string[];
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

export function evaluateStage(
  target: number,
  client: StageClientSnapshot,
  backend: BackendWindowSummary | null,
  thresholds: Thresholds,
): Evaluation {
  const breaches: string[] = [];
  const warnings: string[] = [];
  const near = (value: number, limit: number, label: string) => {
    if (value >= limit * thresholds.nearLimitRatio) warnings.push(`${label} at ${Math.round((value / limit) * 100)}% of its budget`);
  };

  const attachRatio = client.activeStreams / target;
  if (attachRatio < thresholds.minAttachRatio) {
    breaches.push(`only ${client.activeStreams}/${target} streams attached (${pct(attachRatio)})`);
  }

  const errorRatePct = ((client.sseRejected + client.sseDropped + client.sseStalled) / Math.max(1, target)) * 100;
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
  const reconnectsPerMinPer1k = client.reconnects / minutes / Math.max(0.001, target / 1000);
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

  const verdict: Verdict = breaches.length > 0 ? "FAIL" : warnings.length > 0 ? "NEAR LIMIT" : "PASS";
  return { verdict, breaches, warnings };
}
