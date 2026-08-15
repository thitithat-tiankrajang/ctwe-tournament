/**
 * The operator's declared lifecycle state, read from `system/state.json` on the snapshot origin.
 *
 * Architecture §17.3: the file is written by the stop/start workflow — the single writer — and read
 * here purely to *explain* what a viewer or operator is seeing. It lives under `system/`, a separate
 * prefix from published snapshots under `s/`, so retracting a snapshot cannot disturb it and this
 * file cannot disturb a retraction (§17.4).
 *
 * **This is never a security control (§17.5).** It says what the operator intends, and it can be
 * wrong. If it claims OFF while Spring Boot is running, every endpoint is still live and still
 * protected by Spring Security exactly as before. Hiding a login form is UX, not authorization.
 */
export type SystemLifecycleState = "OFF" | "STARTING" | "READY" | "DRAINING" | "STOPPING";

export interface SystemState {
  state: SystemLifecycleState;
  since: string | null;
  message: string | null;
  activeTournamentsAtLastCheck: number | null;
}

const LIFECYCLE_STATES: readonly SystemLifecycleState[] =
  ["OFF", "STARTING", "READY", "DRAINING", "STOPPING"];

/**
 * The same origin published snapshots use, resolved when it is needed rather than bound at module
 * load. `snapshot-api.ts` performs the https validation for this variable and refuses to load on a
 * bad value, so anything reaching here is already known-good; reading it lazily just means this
 * module's behaviour does not depend on which file imported which first.
 */
function origin(): string {
  return (process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN ?? "").trim().replace(/\/+$/, "");
}

/** Matches the file's own `max-age=30`: re-reading it more often than that tells you nothing new. */
const TTL_MS = 30_000;
const TIMEOUT_MS = 1_200;

let cached: { at: number; value: SystemState | null } | null = null;

/** Test seam: the module memoizes per session, which would otherwise leak between cases. */
export function resetSystemStateCache() {
  cached = null;
}

/**
 * Reads the state file, or returns `null` when it cannot be read or understood.
 *
 * **Fails toward available (§21 caveat 2, Z8).** Every failure — origin unset, network error,
 * timeout, 404, malformed body, unknown state name — returns `null`, and every caller treats `null`
 * as "carry on as normal". A missing state file must never be able to lock an operator out of a
 * running system, so the only thing this function can do is *add* an explanation, never remove one.
 */
export async function fetchSystemState(): Promise<SystemState | null> {
  if (!origin()) return null;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const value = await read();
  cached = { at: Date.now(), value };
  return value;
}

async function read(): Promise<SystemState | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${origin()}/system/state.json`, {
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body = (await response.json()) as Partial<SystemState> | null;
    if (!body || !LIFECYCLE_STATES.includes(body.state as SystemLifecycleState)) return null;
    return {
      state: body.state as SystemLifecycleState,
      since: typeof body.since === "string" ? body.since : null,
      message: typeof body.message === "string" ? body.message : null,
      activeTournamentsAtLastCheck:
        typeof body.activeTournamentsAtLastCheck === "number" ? body.activeTournamentsAtLastCheck : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the backend is expected to be unavailable right now.
 *
 * `READY` and `DRAINING` both mean "the API answers" — `DRAINING` is deliberately a review window in
 * which an operator can still log in and check every snapshot before the irreversible suspend
 * (§16.1), not a lockdown.
 */
export function systemIsOff(state: SystemState | null): boolean {
  return state !== null && (state.state === "OFF" || state.state === "STARTING" || state.state === "STOPPING");
}
