/**
 * Static-first resolution for published tournaments.
 *
 * A published tournament is one immutable JSON object on a CDN. The browser derives that object's
 * key from the URL it is already on, so the lookup costs **zero** origin requests: no database
 * query, no API call, nothing that requires Spring Boot or PostgreSQL to be awake.
 *
 * ```
 *   /tour/{slug}  or  /t/{hex}
 *          │
 *          ├─ 200 ─► this response IS the tournament data. Done. Render/Neon never contacted.
 *          │
 *          └─ 404, timeout, network error, unknown schema, bad JSON
 *                  ─► today's live path, byte-for-byte unchanged
 * ```
 *
 * **Fail-open, always.** Every failure mode above falls through to the live path. A snapshot problem
 * must never be able to delay or break a tournament that is actually running — which is why the
 * probe is bounded at {@link PROBE_TIMEOUT_MS} and why every error is swallowed rather than thrown.
 *
 * **Cost on the live path** is one request to a Cloudflare edge that answers from cache and never
 * reaches R2 or any origin. The 404 is cacheable (browser and edge), and the result is memoised in
 * `sessionStorage`, so refreshes and in-session navigation usually issue nothing at all.
 *
 * With `NEXT_PUBLIC_SNAPSHOT_ORIGIN` unset — local development, and production until the cutover —
 * none of this runs: {@link fetchSnapshotBundle} returns `null` immediately and the viewer behaves
 * exactly as it does today. That unset variable is the kill switch.
 */
import type { PublicTournamentBundle, TournamentCard } from "@/domain/tournament/types";

const configured = (process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN ?? "").trim().replace(/\/+$/, "");

if (configured && !configured.startsWith("https://") && process.env.NODE_ENV === "production") {
  throw new Error("NEXT_PUBLIC_SNAPSHOT_ORIGIN must be an https origin");
}

export const SNAPSHOT_ORIGIN = configured;

/**
 * A snapshot lookup must never hold up a live event. Past this, the probe is abandoned and the
 * live path proceeds — the viewer sees at most this much extra latency in the worst case, and
 * normally none, because the probe overlaps hydration.
 */
export const PROBE_TIMEOUT_MS = 1_200;

/** Envelope schema this client understands. A newer document falls through to the live path. */
const SUPPORTED_SCHEMA = 1;

/** Memo lifetimes: a live answer may change during an event; a published one will not. */
const LIVE_MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_PREFIX = "ctwe.snapshot.";

const DOMAIN_SEPARATOR = "ctwe-public-snapshot-v1|";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const KEY_LENGTH = 26;

/**
 * `base32(sha256("ctwe-public-snapshot-v1|" + accessToken))`, truncated to 26 characters.
 *
 * **This is not a security control.** Anyone who knows or guesses the slug can compute the same
 * value in one line of JavaScript. It buys decoupling, log hygiene, and semantic clarity — nothing
 * more. Any future requirement for genuinely private results must be met by a server-side check,
 * not by this path being hard to type.
 *
 * Must stay byte-identical to `SnapshotKey.java`. The two are pinned to shared fixture vectors in
 * `snapshot-api.test.ts` and `SnapshotKeyTest.java`; if they ever diverge, the backend publishes to
 * a key no viewer will ever request and every published tournament silently disappears.
 */
export async function snapshotKey(accessToken: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DOMAIN_SEPARATOR + accessToken)),
  );

  let out = "";
  let buffer = 0;
  let bits = 0;
  let index = 0;
  while (out.length < KEY_LENGTH) {
    if (bits < 5) {
      buffer = (buffer << 8) | digest[index++];
      bits += 8;
    }
    bits -= 5;
    out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
  }
  return out;
}

/** The public URL for a token's snapshot, or null when the feature is switched off. */
export async function snapshotUrl(accessToken: string): Promise<string | null> {
  if (!SNAPSHOT_ORIGIN) return null;
  return `${SNAPSHOT_ORIGIN}/s/${await snapshotKey(accessToken)}.json`;
}

/** What a snapshot document looks like on the wire. Only the fields this client reads are typed. */
interface SnapshotEnvelope {
  snapshot?: { schema?: number; version?: number | null; checksum?: string };
  payload?: Omit<PublicTournamentBundle, "accessToken"> & { cards: TournamentCard[] };
}

/**
 * Resolves a tournament from the CDN, or returns null to mean "use the live path".
 *
 * Null is returned — never thrown — for every one of: the feature being off, Web Crypto being
 * unavailable, a 404, a non-200, a timeout, a network failure, malformed JSON, and an envelope
 * whose schema this build does not understand.
 */
export async function fetchSnapshotBundle(accessToken: string): Promise<PublicTournamentBundle | null> {
  if (!SNAPSHOT_ORIGIN || !accessToken) return null;
  // Non-HTTPS contexts have no crypto.subtle. Production is HTTPS-only; this keeps local dev sane.
  if (typeof crypto === "undefined" || !crypto.subtle) return null;

  const memo = readMemo(accessToken);
  if (memo === "live") return null;

  try {
    const url = await snapshotUrl(accessToken);
    if (!url) return null;

    // AbortController rather than Promise.race: the request is actually cancelled, so a slow probe
    // does not keep competing for the connection the live bundle needs.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { credentials: "omit", signal: abort.signal });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      // A definite "not published" — worth remembering briefly so a refresh costs nothing.
      writeMemo(accessToken, "live");
      return null;
    }
    if (!response.ok) return null;

    const envelope = (await response.json()) as SnapshotEnvelope;
    if (envelope?.snapshot?.schema !== SUPPORTED_SCHEMA) return null;
    if (!envelope.payload?.id || !Array.isArray(envelope.payload.cards)) return null;

    writeMemo(accessToken, "published");
    // The snapshot deliberately omits accessToken — the client already has it, from the URL it
    // navigated to. Re-attaching it here keeps the bundle shape identical for every consumer.
    return { ...envelope.payload, accessToken };
  } catch {
    // Timeout, DNS failure, CSP block, offline, malformed body — all mean the same thing here.
    return null;
  }
}

// --------------------------------------------------------------------------- session memo

type Memo = "live" | "published";

function readMemo(accessToken: string): Memo | null {
  try {
    const raw = sessionStorage.getItem(MEMO_PREFIX + accessToken);
    if (!raw) return null;
    const { state, at } = JSON.parse(raw) as { state: Memo; at: number };
    // A published tournament stays published for the session; a live one is re-probed periodically
    // so a tournament published mid-session is picked up without a hard reload.
    if (state === "live" && Date.now() - at > LIVE_MEMO_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

function writeMemo(accessToken: string, state: Memo): void {
  try {
    sessionStorage.setItem(MEMO_PREFIX + accessToken, JSON.stringify({ state, at: Date.now() }));
  } catch {
    // Private browsing, quota, disabled storage: the memo is an optimisation, never a requirement.
  }
}
