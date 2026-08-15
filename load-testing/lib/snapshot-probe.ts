/**
 * The CDN probe, classified exactly as the browser classifies it.
 *
 * Both fleets need this: the published fleet to resolve its tournament, and the live fleet to pay
 * the cost that Phase H measurement ④ budgets at ≤ 25 ms p95. It lives in `lib/` rather than in
 * either scenario so the two cannot drift, and so neither scenario has to import the other.
 *
 * Mirrors `fetchSnapshotBundle` in `src/infrastructure/http/snapshot-api.ts`, including which
 * outcomes fall through to the live path: everything except a well-formed, supported-schema 200.
 */
import type { Config } from "../config.js";
import type { FleetRole, MetricsHub, ProbeOutcome } from "./metrics-hub.js";
import { CountedHttp, destinationMap } from "./request-ledger.js";
import { snapshotKey, snapshotUrl } from "./snapshot-key.js";

/** Envelope schema this build understands — mirrors `SUPPORTED_SCHEMA` in `snapshot-api.ts`. */
const SUPPORTED_SCHEMA = 1;

export interface ProbeAttempt {
  outcome: ProbeOutcome;
  durationMs: number;
  /** Card ids from the snapshot payload, when it resolved. */
  cardIds: string[];
}

/** The counted HTTP client every scenario must use; see `request-ledger.ts`. */
export function httpFor(config: Config, hub: MetricsHub, fleet: FleetRole): CountedHttp {
  return new CountedHttp(
    hub,
    destinationMap(config.publicApiOrigin, config.backendOrigin, config.snapshot.origin),
    fleet,
    config.requestTimeoutMs,
  );
}

/**
 * One probe, recorded with the edge's own `cf-cache-status` verdict.
 *
 * The deadline is the client's `PROBE_TIMEOUT_MS`, not the harness request timeout: measuring the
 * probe against a longer deadline than the browser uses would understate how often it gives up and
 * overstate the latency a real viewer would tolerate.
 */
export async function probeSnapshot(
  config: Config,
  hub: MetricsHub,
  http: CountedHttp,
  token: string,
  fleet: FleetRole,
): Promise<ProbeAttempt> {
  const origin = config.snapshot.origin;
  if (!origin) return { outcome: "error", durationMs: 0, cardIds: [] };

  const url = snapshotUrl(origin, token);
  const startedAt = Date.now();
  let outcome: ProbeOutcome = "error";
  let durationMs = 0;
  let edgeStatus: string | null = null;
  let cardIds: string[] = [];

  try {
    const response = await http.fetch(url, "application/json", {
      timeoutMs: config.snapshot.probeTimeoutMs,
      // "Not published" is an answer, not an error; only a 5xx or a broken CDN is a failure.
      isSuccess: (status) => status === 404 || (status >= 200 && status < 300),
    });
    durationMs = response.durationMs;
    edgeStatus = response.header("cf-cache-status");
    if (response.status === 404) {
      outcome = "not-published";
    } else if (!response.ok) {
      outcome = "error";
    } else {
      const envelope = JSON.parse(response.text) as {
        snapshot?: { schema?: number };
        payload?: { id?: string; cards?: { id: string }[] };
      };
      if (envelope?.snapshot?.schema !== SUPPORTED_SCHEMA) outcome = "unusable";
      else if (!envelope.payload?.id || !Array.isArray(envelope.payload.cards)) outcome = "unusable";
      else {
        outcome = "published";
        cardIds = envelope.payload.cards.map((card) => card.id).filter(Boolean);
      }
    }
  } catch (error) {
    durationMs = Date.now() - startedAt;
    // AbortError is the client's 1.2 s bound expiring; anything else is a transport failure. Both
    // fall through to the live path, but only one of them is a latency problem.
    outcome = error instanceof Error && error.name === "AbortError" ? "timeout" : "error";
  }

  hub.probeCompleted({ fleet, outcome, durationMs, edgeStatus, key: snapshotKey(token) });
  return { outcome, durationMs, cardIds };
}
