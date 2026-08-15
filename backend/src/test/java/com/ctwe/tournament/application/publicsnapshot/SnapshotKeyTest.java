package com.ctwe.tournament.application.publicsnapshot;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The derived object key, pinned.
 *
 * <p>The browser computes this key from the URL alone and fetches {@code s/{h}.json} directly from
 * the CDN. If Java and TypeScript ever disagree by one character, the backend publishes to a key no
 * viewer will ever request — every published tournament silently becomes unreachable while every
 * test that only checks one side still passes. So the vectors below are duplicated verbatim in
 * {@code src/infrastructure/http/snapshot-api.test.ts}, and both suites must be updated together.
 */
class SnapshotKeyTest {

    /**
     * SHARED FIXTURE VECTORS — keep byte-identical with snapshot-api.test.ts.
     *
     * <p>Covers a modern admin-chosen slug, a legacy 32-hex token, the 3-character minimum, a
     * 64-character maximum, and a digits-and-dashes token.
     */
    @Test
    @DisplayName("fixture vectors match the TypeScript implementation")
    void fixtureVectors() {
        assertThat(SnapshotKey.of("bkk-th-ms-championship")).isEqualTo(expected("bkk-th-ms-championship"));
        assertThat(SnapshotKey.of("ctwe")).isEqualTo(expected("ctwe"));
        assertThat(SnapshotKey.of("a1b")).isEqualTo(expected("a1b"));
        assertThat(SnapshotKey.of("7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f"))
            .isEqualTo(expected("7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f"));
        assertThat(SnapshotKey.of("a".repeat(64))).isEqualTo(expected("a".repeat(64)));
    }

    /**
     * The literal expected values. Written out rather than recomputed so a change to the derivation
     * — a different separator, a different alphabet, a different truncation — fails here instead of
     * agreeing with itself.
     */
    private static String expected(String token) {
        return switch (token) {
            case "bkk-th-ms-championship" -> "hcjbazc3ehzb4pip6gueijdxv3";
            case "ctwe" -> "hh3rgn6lnfxvhmc27hsgfzeiay";
            case "a1b" -> "7jpknkgoln7kuq4ay3uvfj2kdo";
            case "7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f" -> "xjlkx6owtl3czp4dfbfqel5n67";
            default -> "qeo5fga7l3m5xotlstwh2fscwm";   // "a" x 64
        };
    }

    @Test
    @DisplayName("keys are 26 lowercase base32 characters")
    void shape() {
        for (String token : new String[] {"bkk-th-ms-championship", "ctwe", "a1b", "a".repeat(64)})
            assertThat(SnapshotKey.of(token))
                .hasSize(26)
                .matches("[a-z2-7]{26}");
    }

    @Test
    @DisplayName("the key is a pure function of the token")
    void deterministic() {
        assertThat(SnapshotKey.of("ctwe-2026")).isEqualTo(SnapshotKey.of("ctwe-2026"));
    }

    @Test
    @DisplayName("different tokens give different keys, including near-identical ones")
    void distinct() {
        assertThat(SnapshotKey.of("ctwe-2026")).isNotEqualTo(SnapshotKey.of("ctwe-2027"));
        assertThat(SnapshotKey.of("ctwe")).isNotEqualTo(SnapshotKey.of("ctwe-"));
    }

    @Test
    @DisplayName("the domain separator is part of the digest")
    void domainSeparated() {
        // A bare sha256 of the token — no separator — must not be what we publish under. This is what
        // stops a digest computed for some other purpose from colliding with a snapshot key.
        assertThat(SnapshotKey.of("ctwe")).isNotEqualTo(SnapshotKey.of("ctwe-public-snapshot-v1|ctwe"));
    }

    @Test
    @DisplayName("the public surface is exactly one object per tournament")
    void publicLayout() {
        String key = SnapshotKey.of("ctwe-2026");
        assertThat(SnapshotKey.publicObject("ctwe-2026")).isEqualTo("s/" + key + ".json");
        // Staging is version-suffixed so two attempts can never read each other's bytes, and it is
        // a different key from the promoted one — the promoted object is never written until step 6.
        assertThat(SnapshotKey.stagingObject("ctwe-2026", 4))
            .isEqualTo("s/" + key + ".staging-4.json")
            .isNotEqualTo(SnapshotKey.publicObject("ctwe-2026"));
        assertThat(SnapshotKey.stagingObject("ctwe-2026", 4))
            .isNotEqualTo(SnapshotKey.stagingObject("ctwe-2026", 5));
    }

    @Test
    @DisplayName("no tournament id or name appears in a public key")
    void publicKeyLeaksNothing() {
        UUID tournamentId = UUID.fromString("f3da7a4d-6fa1-4531-9631-8c96f48fce2f");
        String publicKey = SnapshotKey.publicObject("bkk-th-ms-championship");

        assertThat(publicKey)
            .doesNotContain(tournamentId.toString())
            .as("the routing token itself must not appear either — that is the log-hygiene point")
            .doesNotContain("bkk")
            .doesNotContain("championship");
        // The PRIVATE side is keyed by the real identity, because no browser derives it.
        assertThat(SnapshotKey.privatePayload(tournamentId, 3))
            .isEqualTo("t/" + tournamentId + "/v/3/payload.json");
        assertThat(SnapshotKey.privateManifest(tournamentId, 3))
            .isEqualTo("t/" + tournamentId + "/v/3/manifest.json");
    }

    @Test
    @DisplayName("a missing token is rejected rather than hashed into a shared key")
    void rejectsBlank() {
        assertThatThrownBy(() -> SnapshotKey.of(null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> SnapshotKey.of("  ")).isInstanceOf(IllegalArgumentException.class);
    }
}
