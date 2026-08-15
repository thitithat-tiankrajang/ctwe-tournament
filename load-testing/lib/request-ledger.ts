/**
 * Where a request actually went.
 *
 * Phase H's central claim is "a published tournament under load produces zero Render requests". A
 * claim like that is only worth anything if the harness *counts* origin traffic rather than assuming
 * its own scenario code never emits any. So every HTTP call any scenario makes is classified here,
 * by URL origin, and attributed to the fleet that made it. A published viewer that falls through to
 * the live path — which is exactly what a fail-open client does when the object is missing — is then
 * recorded as origin traffic and fails the criterion, instead of quietly passing it.
 *
 * Classification is by `URL.origin` (scheme + host + port), never by path, because a path-based rule
 * would let a mis-built URL escape accounting.
 */

import type { FleetRole, MetricsHub } from "./metrics-hub.js";

/** `origin` means Render — the thing publication is supposed to take off the critical path. */
export type Destination = "origin" | "cdn" | "frontend";

export interface DestinationMap {
  /** Every origin that resolves to the Spring Boot backend (public API host and metrics host). */
  originOrigins: string[];
  /** The snapshot CDN origin, when Phase H is configured. */
  cdnOrigin: string | null;
}

export function destinationMap(
  publicApiOrigin: URL,
  backendOrigin: URL,
  snapshotOrigin: URL | null,
): DestinationMap {
  return {
    originOrigins: [...new Set([publicApiOrigin.origin, backendOrigin.origin])],
    cdnOrigin: snapshotOrigin?.origin ?? null,
  };
}

/**
 * Classify one absolute URL.
 *
 * Render is checked first, so a deployment that (wrongly) put the snapshot host on the Render origin
 * still reports origin traffic — the pessimistic answer is the honest one here. Anything that is
 * neither is the frontend host (the Worker serving the `/tour/{token}` document), which costs Render
 * nothing.
 *
 * Note the deliberate consequence: if the viewer page and the public API share a host — the usual
 * local `localhost:8080` setup — the page document counts as origin traffic and the zero-Render
 * criterion legitimately cannot pass. In production the document is served by the Worker on a
 * different host, so the distinction is real rather than a harness artefact.
 */
export function classifyDestination(url: string, map: DestinationMap): Destination {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // An unparseable URL cannot be proven harmless, so it is charged to the origin.
    return "origin";
  }
  if (map.originOrigins.includes(origin)) return "origin";
  if (map.cdnOrigin !== null && origin === map.cdnOrigin) return "cdn";
  return "frontend";
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Which statuses count as a healthy answer for this particular request. Defaults to 2xx. */
  isSuccess?: (status: number) => boolean;
}

export interface CountedResponse {
  status: number;
  ok: boolean;
  bytes: number;
  text: string;
  header(name: string): string | null;
  durationMs: number;
}

/**
 * The only way a scenario is allowed to make an HTTP request.
 *
 * Routing every call through one place is what makes the accounting structural: a scenario cannot
 * emit an origin request the ledger does not see, because there is no other fetch. The destination
 * is derived from the URL that was actually requested, not from what the call site believed it was
 * doing.
 */
export class CountedHttp {
  constructor(
    private readonly hub: MetricsHub,
    private readonly map: DestinationMap,
    private readonly fleet: FleetRole,
    private readonly timeoutMs: number,
  ) {}

  /** Note the destination is charged even when the request fails: an error still reached the host. */
  async fetch(url: string, accept: string, options: FetchOptions = {}): Promise<CountedResponse> {
    const destination = classifyDestination(url, this.map);
    if (destination === "origin") this.hub.originRequest(this.fleet);

    // A snapshot probe's 404 is the designed answer for a tournament that is not published, not a
    // failure. Counting it as one would put a false HTTP error rate on every live viewer and could
    // fail a stage for behaving exactly as architecture §2.3 specifies.
    const succeeded = options.isSuccess ?? ((status: number) => status >= 200 && status < 300);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        headers: { accept },
        credentials: "omit",
        signal: controller.signal,
      });
      // Drain so keep-alive sockets stay reusable and byte counts stay honest.
      const body = await response.arrayBuffer();
      const durationMs = Date.now() - startedAt;
      this.hub.bytes(body.byteLength);
      this.hub.httpResponse(durationMs, succeeded(response.status));
      if (destination === "cdn") this.hub.cdnRequest(body.byteLength);
      return {
        status: response.status,
        ok: response.ok,
        bytes: body.byteLength,
        text: new TextDecoder().decode(body),
        header: (name: string) => response.headers.get(name),
        durationMs,
      };
    } catch (error) {
      this.hub.httpError();
      if (destination === "cdn") this.hub.cdnRequest(0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
