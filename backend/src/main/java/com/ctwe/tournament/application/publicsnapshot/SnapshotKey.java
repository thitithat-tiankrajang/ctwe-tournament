package com.ctwe.tournament.application.publicsnapshot;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.UUID;

/**
 * Object keys for published snapshots.
 *
 * <p>The public key is derived from the tournament's {@code access_token}:
 * {@code base32(sha256("ctwe-public-snapshot-v1|" + access_token))}, truncated to 26 characters.
 *
 * <p><b>The hash is not a security control.</b> Anyone who knows or guesses the slug can compute the
 * same value in one line of JavaScript. It buys decoupling, log hygiene, and semantic clarity —
 * nothing more. Any future requirement for genuinely private results must be met by a server-side
 * check, not by this path being hard to type.
 *
 * <p>Why derive rather than use the tournament UUID: the browser must compute this key from nothing
 * but the URL it was given, with <b>zero</b> database lookups — that is the whole point of serving a
 * published tournament without waking Spring Boot or Neon. A UUID or a random id would require the
 * per-request lookup the design forbids. Deriving it from the token also keeps tournament names out
 * of CDN logs, R2 request logs, browser history and {@code Referer} headers, and decouples storage
 * keys from a routing string that may one day gain aliases.
 *
 * <p>An identical implementation lives in {@code src/infrastructure/http/snapshot-api.ts}. The two
 * are pinned to shared fixture vectors by {@code SnapshotKeyTest} and {@code snapshot-api.test.ts}: a
 * mismatch would silently make every published snapshot unreachable.
 *
 * <h2>Layout</h2>
 * <pre>
 * PUBLIC   s/{h}.json                       exactly one object per published tournament
 *          s/{h}.staging-{n}.json           transient, deleted after promotion
 * PRIVATE  t/{tournamentId}/v/{n}/payload.json    immutable history, never public
 *          t/{tournamentId}/v/{n}/manifest.json
 * </pre>
 *
 * The public side is keyed by the derived hash because the browser must compute it. The private side
 * is keyed by the tournament UUID because no browser derivation is needed there and the UUID is the
 * true identity. Exactly one public object per tournament is what makes retraction provably complete.
 */
public final class SnapshotKey {
    /** Domain separator: this digest may never collide with one computed for another purpose. */
    private static final String DOMAIN_SEPARATOR = "ctwe-public-snapshot-v1|";

    /** RFC 4648 base32, lowercased. Lowercase keeps the key clean in URLs, logs, and hostnames. */
    private static final String ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

    /** 26 chars x 5 bits = 130 bits of the digest — far beyond any collision concern here. */
    private static final int LENGTH = 26;

    private SnapshotKey() {}

    /** The 26-character derived key for a tournament's access token. */
    public static String of(String accessToken) {
        if (accessToken == null || accessToken.isBlank())
            throw new IllegalArgumentException("access token is required to derive a snapshot key");
        return base32(sha256(DOMAIN_SEPARATOR + accessToken));
    }

    /** The one and only public object for a published tournament. */
    public static String publicObject(String accessToken) {
        return "s/" + of(accessToken) + ".json";
    }

    /**
     * Where a candidate is uploaded and verified through the public hostname before promotion.
     * Version-suffixed so two attempts can never read each other's bytes.
     */
    public static String stagingObject(String accessToken, long version) {
        return "s/" + of(accessToken) + ".staging-" + version + ".json";
    }

    /** Private, immutable history. Keyed by the real internal identity. */
    public static String privatePayload(UUID tournamentId, long version) {
        return "t/" + tournamentId + "/v/" + version + "/payload.json";
    }

    /** Private manifest: which token, name, checksum and actor produced this version. */
    public static String privateManifest(UUID tournamentId, long version) {
        return "t/" + tournamentId + "/v/" + version + "/manifest.json";
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is required to derive a snapshot key", error);
        }
    }

    /** Streams 5-bit groups out of the digest until {@link #LENGTH} characters exist. */
    private static String base32(byte[] digest) {
        StringBuilder out = new StringBuilder(LENGTH);
        int buffer = 0;
        int bits = 0;
        int index = 0;
        while (out.length() < LENGTH) {
            if (bits < 5) {
                buffer = (buffer << 8) | (digest[index++] & 0xff);
                bits += 8;
            }
            bits -= 5;
            out.append(ALPHABET.charAt((buffer >>> bits) & 0x1f));
        }
        return out.toString();
    }
}
