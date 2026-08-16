package com.ctwe.tournament.infrastructure.storage;

import com.ctwe.tournament.infrastructure.cdn.CachePurgeClient;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The configuration policy, in full.
 *
 * <pre>
 *   ABSENT   nothing set              → publication DISABLED, application starts normally
 *   PARTIAL  something set, not all   → INVALID, startup FAILS with a specific message
 *   COMPLETE everything set and valid → publication ENABLED
 * </pre>
 *
 * <p>The middle row is the one worth testing hardest. Silently disabling a half-configured
 * deployment is the failure mode that hurts: it boots healthy, passes its health check, and only
 * reveals itself when an operator tries to publish — at which point they are mid-way through
 * committing a permanent public artifact. Every PARTIAL case below must therefore fail loudly at
 * startup, and none of them may fall back to "disabled".
 */
class SnapshotStorageConfigurationTest {

    private static final String ENDPOINT = "https://account.r2.cloudflarestorage.com";
    private static final String ORIGIN = "https://snapshot.ct-we.com";

    private static SnapshotStorageProperties complete() {
        return new SnapshotStorageProperties(ENDPOINT, "key", "secret",
            "ctwe-snapshots", "ctwe-snapshots-public", ORIGIN, "zone", "purge-token");
    }

    private static SnapshotStorageProperties absent() {
        return new SnapshotStorageProperties(null, null, null, null, null, null, null, null);
    }

    private final SnapshotStorageConfiguration configuration = new SnapshotStorageConfiguration();

    // ================================================================== ABSENT

    @Nested
    @DisplayName("ABSENT — nothing configured")
    class Absent {

        @Test
        @DisplayName("classifies as ABSENT rather than failing")
        void classifies() {
            assertThat(absent().validate()).isEqualTo(SnapshotStorageProperties.Mode.ABSENT);
            assertThat(absent().enabled()).isFalse();
        }

        @Test
        @DisplayName("blank strings count as absent, not as a partial configuration")
        void blanksAreAbsent() {
            // Render and Docker hand through empty strings for unset variables; an empty value is
            // "not set", not "set to nothing".
            SnapshotStorageProperties blank = new SnapshotStorageProperties("", "  ", "", "", "", "", "", "");
            assertThat(blank.validate()).isEqualTo(SnapshotStorageProperties.Mode.ABSENT);
        }

        @Test
        @DisplayName("wires unavailable stand-ins instead of throwing, so the application still starts")
        void wiresStandIns() {
            SnapshotObjectStore store = configuration.snapshotObjectStore(absent());
            PublicSnapshotFetcher fetcher = configuration.publicSnapshotFetcher(absent());
            CachePurgeClient purge = configuration.cachePurgeClient(absent());

            assertThat(store.available()).isFalse();
            assertThat(fetcher.available()).isFalse();
            assertThat(purge.available()).isFalse();
        }

        @Test
        @DisplayName("attempting to publish fails with a message naming the missing configuration")
        void publishingSaysWhy() {
            SnapshotObjectStore store = configuration.snapshotObjectStore(absent());

            assertThatThrownBy(() -> store.putPublic("s/x.json", new byte[0], "no-store", false))
                .hasMessageContaining("app.snapshot-storage");
            // The fetcher reports rather than throws, because the pipeline treats a failed read-back
            // as a branch; either way the reason is explicit.
            assertThat(configuration.publicSnapshotFetcher(absent()).fetch("s/x.json", false).failure())
                .contains("app.snapshot-storage");
        }
    }

    // ================================================================== COMPLETE

    @Nested
    @DisplayName("COMPLETE — everything configured")
    class Complete {

        @Test
        @DisplayName("classifies as COMPLETE and enables publication")
        void classifies() {
            assertThat(complete().validate()).isEqualTo(SnapshotStorageProperties.Mode.COMPLETE);
            assertThat(complete().enabled()).isTrue();
            assertThat(complete().purgeConfigured()).isTrue();
        }

        @Test
        @DisplayName("the optional purge pair may be omitted entirely")
        void purgeIsOptional() {
            SnapshotStorageProperties noPurge = new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "ctwe-snapshots", "ctwe-snapshots-public", ORIGIN, null, null);

            assertThat(noPurge.validate()).isEqualTo(SnapshotStorageProperties.Mode.COMPLETE);
            assertThat(noPurge.purgeConfigured()).isFalse();
            assertThat(configuration.cachePurgeClient(noPurge).available()).isFalse();
        }

        @Test
        @DisplayName("an http endpoint is allowed (self-hosted S3), an http public origin is not")
        void schemeRules() {
            SnapshotStorageProperties localEndpoint = new SnapshotStorageProperties("http://localhost:9000",
                "key", "secret", "priv", "pub", ORIGIN, null, null);

            assertThat(localEndpoint.validate()).isEqualTo(SnapshotStorageProperties.Mode.COMPLETE);
        }

        @Test
        @DisplayName("public URLs are built from the origin without doubling the slash")
        void buildsPublicUrls() {
            SnapshotStorageProperties trailing = new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", "pub", ORIGIN + "/", null, null);

            assertThat(trailing.publicUrl("s/abc.json")).isEqualTo(ORIGIN + "/s/abc.json");
            assertThat(complete().publicUrl("s/abc.json")).isEqualTo(ORIGIN + "/s/abc.json");
        }
    }

    // ================================================================== PARTIAL

    @Nested
    @DisplayName("PARTIAL — invalid, must fail fast")
    class Partial {

        private void assertRejected(SnapshotStorageProperties properties, String expectedProblem) {
            assertThatThrownBy(properties::validate)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining(expectedProblem);
            // And the bean factory must refuse too — this is what turns it into a failed startup
            // rather than a quietly degraded service.
            assertThatThrownBy(() -> configuration.snapshotObjectStore(properties))
                .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> configuration.publicSnapshotFetcher(properties))
                .isInstanceOf(IllegalStateException.class);
        }

        @Test
        @DisplayName("a missing credential is rejected")
        void missingSecret() {
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", null,
                "priv", "pub", ORIGIN, null, null), "secret-access-key is missing");
        }

        @Test
        @DisplayName("a missing bucket is rejected")
        void missingBucket() {
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", null, ORIGIN, null, null), "public-bucket is missing");
        }

        @Test
        @DisplayName("R2 without a public origin is rejected — verification depends on that hostname")
        void missingPublicOrigin() {
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", "pub", null, null, null), "public-origin is missing");
        }

        @Test
        @DisplayName("a public origin alone is rejected instead of silently disabling")
        void publicOriginAlone() {
            // The gap this test closes: a lone public-origin used to fall through to "disabled",
            // which is exactly the silent degradation the policy forbids.
            assertRejected(new SnapshotStorageProperties(null, null, null, null, null, ORIGIN, null, null),
                "endpoint is missing");
        }

        @Test
        @DisplayName("a lone Cloudflare value is rejected instead of silently disabling")
        void cloudflareAlone() {
            assertRejected(new SnapshotStorageProperties(null, null, null, null, null, null, "zone", null),
                "endpoint is missing");
        }

        @Test
        @DisplayName("half a purge credential pair is rejected")
        void halfPurgePair() {
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", "pub", ORIGIN, "zone", null), "set together or not at all");
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", "pub", ORIGIN, null, "purge-token"), "set together or not at all");
        }

        @Test
        @DisplayName("a scheme-less endpoint or origin is rejected")
        void schemeless() {
            assertRejected(new SnapshotStorageProperties("account.r2.cloudflarestorage.com", "key", "secret",
                "priv", "pub", ORIGIN, null, null), "endpoint must be an absolute URL");
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", "pub", "snapshot.ct-we.com", null, null), "public-origin must be an absolute URL");
        }

        @Test
        @DisplayName("an http public origin is rejected — the viewer page is https")
        void httpPublicOrigin() {
            // Mixed content: the browser would block the fetch and every published tournament would
            // fall through to the live path forever, looking like "publication does nothing".
            assertRejected(new SnapshotStorageProperties(ENDPOINT, "key", "secret",
                "priv", "pub", "http://snapshot.ct-we.com", null, null), "public-origin must be https");
        }

        @Test
        @DisplayName("every problem is reported at once, not one redeploy at a time")
        void reportsAllProblems() {
            assertThatThrownBy(() -> new SnapshotStorageProperties(null, "key", null,
                null, "pub", null, null, null).validate())
                .hasMessageContaining("endpoint is missing")
                .hasMessageContaining("secret-access-key is missing")
                .hasMessageContaining("private-bucket is missing")
                .hasMessageContaining("public-origin is missing");
        }

        @Test
        @DisplayName("the message tells an operator exactly which keys to set")
        void messageNamesTheKeys() {
            assertThatThrownBy(() -> new SnapshotStorageProperties(ENDPOINT, null, null,
                null, null, null, null, null).validate())
                .hasMessageContaining("app.snapshot-storage.{endpoint,access-key-id,secret-access-key,"
                    + "private-bucket,public-bucket,public-origin}");
        }
    }
}
