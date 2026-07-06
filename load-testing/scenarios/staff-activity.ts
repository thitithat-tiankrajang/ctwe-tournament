/**
 * Optional realism generator: one staff account rewriting a single match result on an interval
 * (editExisting=true keeps overwriting the same row, so the database stays clean apart from the
 * designated load-test card). Every write produces a real public SSE `result` fan-out, and the
 * returned version number lets every viewer measure true write -> receive latency.
 *
 * Enabled only when ACTIVITY_CARD_ID + ACTIVITY_MATCH_ID are set. Point them at a dedicated
 * load-test card — never at a card holding real tournament data.
 */
import type { Config } from "../config.js";
import type { MetricsHub } from "../lib/metrics-hub.js";
import { BackendSession } from "../lib/backend-session.js";

export class StaffActivity {
  private readonly config: Config;
  private readonly hub: MetricsHub;
  private session: BackendSession | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flip = false;

  constructor(config: Config, hub: MetricsHub) {
    this.config = config;
    this.hub = hub;
  }

  get enabled(): boolean {
    return Boolean(this.config.staffUser && this.config.staffPass
      && this.config.activityCardId && this.config.activityMatchId);
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    this.session = new BackendSession(this.config.backendOrigin, this.config.staffUser!, this.config.staffPass!);
    await this.session.login();
    this.timer = setInterval(() => void this.writeOnce(), this.config.activityIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async writeOnce(): Promise<void> {
    if (!this.session) return;
    // Alternate the losing score so every write is a real change that bumps the public version.
    this.flip = !this.flip;
    const startedAt = Date.now();
    try {
      const response = await this.session.request(
        `/api/cards/${this.config.activityCardId}/matches/${this.config.activityMatchId}/result`,
        {
          method: "PUT",
          body: JSON.stringify({ scoreOne: 450, scoreTwo: this.flip ? 300 : 310, editExisting: true }),
        },
      );
      if (!response.ok) {
        this.hub.writeFailed();
        return;
      }
      await response.arrayBuffer();
      const completedAt = Date.now();
      this.hub.registerWrite(completedAt, completedAt - startedAt);
    } catch {
      this.hub.writeFailed();
    }
  }
}
