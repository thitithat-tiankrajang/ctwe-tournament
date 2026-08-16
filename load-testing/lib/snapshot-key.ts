/**
 * The published object key, recomputed by the load generator.
 *
 * A simulated published viewer has to ask the CDN for exactly the object the browser would ask for.
 * If this derivation drifted from `src/infrastructure/http/snapshot-api.ts` or `SnapshotKey.java`
 * the harness would fetch a key nothing was ever published under, receive 404 on every probe, fall
 * through to the live path, and then "measure" a published fleet that is not published at all. That
 * failure mode is silent and it would invalidate every Phase H number, so this file is pinned to the
 * same shared fixture vectors as the other two implementations (`snapshot-key.test.ts`).
 *
 * Node's `crypto` is used rather than Web Crypto only because it is synchronous; the bytes are the
 * same.
 */
import { createHash } from "node:crypto";

const DOMAIN_SEPARATOR = "ctwe-public-snapshot-v1|";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const KEY_LENGTH = 26;

/** `base32(sha256("ctwe-public-snapshot-v1|" + accessToken))`, truncated to 26 characters. */
export function snapshotKey(accessToken: string): string {
  const digest = createHash("sha256").update(DOMAIN_SEPARATOR + accessToken, "utf8").digest();

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

/** The public URL a browser on `/tour/{accessToken}` would probe. */
export function snapshotUrl(origin: URL, accessToken: string): string {
  return new URL(`/s/${snapshotKey(accessToken)}.json`, origin).href;
}
