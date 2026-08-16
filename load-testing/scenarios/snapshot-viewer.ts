/**
 * One simulated viewer of a PUBLISHED tournament — the Phase H counterpart of `viewer-sse.ts`.
 *
 * What the real client does (`src/application/tournament/store.ts` → `snapshot-api.ts`):
 *
 *   1. The Worker serves the `/tour/{token}` document.
 *   2. The browser derives `s/{h}.json` from the token alone and fetches it from the CDN.
 *   3. **200** — that response *is* the tournament. The store hydrates, marks the tournament
 *      published, and therefore opens no SSE stream, starts no polling, and never asks Render for
 *      `realtime-config`. Nothing further happens for the life of the page; switching cards is a
 *      hash change costing zero requests.
 *   4. **anything else** — fail-open onto today's exact live path.
 *
 * Step 4 is reproduced faithfully rather than skipped, and that is the point. A published fleet only
 * shows zero Render traffic when the snapshots really are there; if one is missing, this viewer does
 * what a browser would do, the ledger records the origin requests, and measurement ② fails. The
 * criterion cannot pass by the harness declining to make requests.
 */
import { pageUrlFor, type Config } from "../config.js";
import type { MetricsHub } from "../lib/metrics-hub.js";
import type { CountedHttp } from "../lib/request-ledger.js";
import { httpFor, probeSnapshot } from "../lib/snapshot-probe.js";
import { Viewer } from "./viewer-sse.js";

export class SnapshotViewer {
  private readonly id: number;
  private readonly token: string;
  private readonly config: Config;
  private readonly hub: MetricsHub;
  private readonly http: CountedHttp;

  private stopped = false;
  /** Only ever non-null after a fail-open fallback; a resolved snapshot needs no stream. */
  private fallback: Viewer | null = null;

  constructor(id: number, token: string, config: Config, hub: MetricsHub) {
    this.id = id;
    this.token = token;
    this.config = config;
    this.hub = hub;
    this.http = httpFor(config, hub, "published");
    hub.registerViewer("published");
  }

  async start(): Promise<void> {
    const startedAt = Date.now();
    if (this.config.fetchPageDocument) {
      // The Worker still serves the document. It is charged to whichever host actually answered.
      try {
        await this.http.fetch(pageUrlFor(this.config, this.token), "text/html");
      } catch {
        // A frontend-host failure is already recorded; the data path is what Phase H measures.
      }
    }
    if (this.stopped) return;

    const probe = await probeSnapshot(this.config, this.hub, this.http, this.token, "published");
    if (probe.outcome === "published") {
      this.hub.firstData("published", Date.now() - startedAt);
      // Done — permanently. No stream, no poll, no further request of any kind.
      return;
    }

    this.hub.publishedFallback();
    if (!this.stopped) await this.startLiveFallback(startedAt);
  }

  /**
   * Exactly the live path, still attributed to the published fleet.
   *
   * The bundle is fetched here rather than delegated so the fallback can learn a card id; the SSE
   * half is delegated to the real live viewer so its reconnect, heartbeat and stall behaviour are
   * the same code the baseline measured.
   */
  private async startLiveFallback(startedAt: number): Promise<void> {
    let cardId: string | null = null;
    try {
      await this.http.fetch(
        new URL("/api/public/realtime-config", this.config.publicApiOrigin).href,
        "application/json",
      );
      const bundle = await this.http.fetch(
        new URL(
          `/api/public/tournaments/${encodeURIComponent(this.token)}/bundle`,
          this.config.publicApiOrigin,
        ).href,
        "application/json",
      );
      if (bundle.ok) {
        this.hub.firstData("published", Date.now() - startedAt);
        const parsed = JSON.parse(bundle.text) as { cards?: { id: string }[] };
        cardId = parsed.cards?.[0]?.id ?? null;
      }
    } catch {
      // Already counted as an HTTP error and as origin traffic.
    }
    if (this.stopped || cardId === null) return;
    this.fallback = new Viewer(this.id, { token: this.token, cardId }, this.config, this.hub, {
      fleet: "published",
      bootstrap: false,
    });
    await this.fallback.start();
  }

  stop(): void {
    this.stopped = true;
    this.fallback?.stop();
  }
}
