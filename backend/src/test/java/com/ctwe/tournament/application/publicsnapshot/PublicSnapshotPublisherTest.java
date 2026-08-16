package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.infrastructure.storage.SnapshotStorageProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * The Phase B publication pipeline, and above all its ordering guarantee:
 *
 * <blockquote>the public pointer is never advanced to bytes that have not been read back and
 * checksum-verified through the public hostname.</blockquote>
 *
 * <p>Most of what follows injects a failure at one step and asserts the same thing each time —
 * whatever was public before is still public, byte for byte, and the recorded pointer still names
 * it. A publication that cannot complete must be indistinguishable, from a viewer's side, from one
 * that was never attempted.
 */
class PublicSnapshotPublisherTest {
    private static final UUID TOURNAMENT = SnapshotFixtures.TOURNAMENT_ID;
    private static final String TOKEN = "ctwe-phase-b";
    private static final String OBJECT_KEY = SnapshotKey.publicObject(TOKEN);
    private static final String PUBLIC_URL = "https://snapshot.ct-we.com/" + OBJECT_KEY;

    private static final SnapshotStorageProperties PROPERTIES = new SnapshotStorageProperties(
        "https://account.r2.cloudflarestorage.com", "key", "secret", "ctwe-snapshots",
        "ctwe-snapshots-public", "https://snapshot.ct-we.com", "zone", "token");

    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService cards = mock(TournamentCardService.class);
    private final FakeSnapshotStorage storage = new FakeSnapshotStorage();
    private final RecordingState state = new RecordingState();

    private PublicSnapshotBuilder builder;
    private PublicSnapshotPublisher publisher;

    @BeforeEach
    void setUp() {
        sourceData(SnapshotFixtures.seeds());
        builder = new PublicSnapshotBuilder(jdbc, cards);
        publisher = new PublicSnapshotPublisher(builder, state, storage, storage, storage, PROPERTIES);
    }

    /** Points the builder at a given set of rows. Calling it again is how "the data changed". */
    private void sourceData(List<SnapshotFixtures.Seed> seeds) {
        SnapshotFixtures.stub(jdbc, cards, TOURNAMENT, SnapshotFixtures.TOURNAMENT_NAME, seeds);
    }

    /** Bumps one card's public version, so the next build produces a different payload. */
    private void changeSourceData() {
        sourceData(SnapshotFixtures.seeds().stream()
            .map(seed -> new SnapshotFixtures.Seed(seed.id(), seed.publicVersion() + 1000, seed.source()))
            .toList());
    }

    // ================================================================== the happy path

    @Test
    @DisplayName("a successful publish stages, verifies, promotes, purges, re-verifies, then commits")
    void publishesInOrder() {
        PublicSnapshotPublisher.Outcome outcome = publisher.publish(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(outcome.version()).isEqualTo(1);
        assertThat(outcome.publicUrl()).isEqualTo(PUBLIC_URL);

        String staging = SnapshotKey.stagingObject(TOKEN, 1);
        assertThat(storage.operations()).containsExactly(
            "putPrivate " + SnapshotKey.privatePayload(TOURNAMENT, 1),
            "putPrivate " + SnapshotKey.privateManifest(TOURNAMENT, 1),
            "putPublic " + staging,
            "fetch " + staging,
            "putPublic " + OBJECT_KEY,
            "fetch " + OBJECT_KEY + " (cache-bust)",
            "deletePublic " + staging);

        // The promoted object is the ONLY public object left — one object per published tournament.
        assertThat(storage.publicObjects()).containsOnlyKeys(OBJECT_KEY);
        assertThat(storage.publicCacheControl(OBJECT_KEY))
            .contains(SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL);
        assertThat(storage.purged()).containsExactly(PUBLIC_URL);
    }

    @Test
    @DisplayName("the verified candidate is recorded before the promotion, and committed only after")
    void recordsVerifiedBeforePromoting() {
        publisher.publish(TOURNAMENT, "admin");

        // Ordering is the whole safety property: a VERIFIED row can exist with no promotion, but a
        // commit can never exist without a preceding verification.
        assertThat(state.calls).containsExactly("beginPublishing", "recordVerified:1", "commitPublished:1");
    }

    @Test
    @DisplayName("the published object's payload checksums to exactly what was recorded")
    void publishedBytesMatchTheChecksum() {
        PublicSnapshotPublisher.Outcome outcome = publisher.publish(TOURNAMENT, "admin");

        String document = new String(storage.publicObject(OBJECT_KEY).orElseThrow(), StandardCharsets.UTF_8);
        assertThat(SnapshotJson.checksum(SnapshotJson.payloadOf(document))).isEqualTo(outcome.checksum());
        assertThat(SnapshotJson.versionOf(document)).isEqualTo(1L);
        // generatedAt and version live outside the checksum, so the payload bytes depend only on the
        // database — the Phase A2 property, now asserted on what actually reaches R2.
        assertThat(SnapshotJson.payloadOf(document)).isEqualTo(builder.build(TOURNAMENT).payloadJson());
    }

    @Test
    @DisplayName("private history keeps the exact payload bytes a rollback would restore")
    void writesPrivateHistory() {
        PublicSnapshotPublisher.Outcome outcome = publisher.publish(TOURNAMENT, "admin");

        byte[] stored = storage.getPrivate(SnapshotKey.privatePayload(TOURNAMENT, 1)).orElseThrow();
        assertThat(SnapshotJson.checksum(new String(stored, StandardCharsets.UTF_8)))
            .isEqualTo(outcome.checksum());
    }

    @Test
    @DisplayName("the manifest is private only — it is the one place the token and name are recorded")
    void manifestStaysPrivate() {
        publisher.publish(TOURNAMENT, "admin");

        String manifest = new String(
            storage.getPrivate(SnapshotKey.privateManifest(TOURNAMENT, 1)).orElseThrow(), StandardCharsets.UTF_8);
        assertThat(manifest).contains(TOKEN).contains(SnapshotFixtures.TOURNAMENT_NAME);

        String published = new String(storage.publicObject(OBJECT_KEY).orElseThrow(), StandardCharsets.UTF_8);
        assertThat(published)
            .as("the public document must not carry the routing token")
            .doesNotContain(TOKEN)
            .doesNotContain("accessToken");
    }

    // ================================================================== failure never advances the pointer

    @Test
    @DisplayName("no public object exists at all until the promotion step")
    void nothingPublicBeforePromotion() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS, ".staging-1.json");

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(storage.publicObject(OBJECT_KEY))
            .as("the promoted key was never written")
            .isEmpty();
        assertThat(state.committed).isEmpty();
    }

    @Test
    @DisplayName("a refused upload leaves the previous published object untouched")
    void failedUploadKeepsPreviousObject() {
        publisher.publish(TOURNAMENT, "admin");
        byte[] published = storage.publicObject(OBJECT_KEY).orElseThrow().clone();
        long pointerBefore = state.version;
        String checksumBefore = state.currentChecksum;
        state.reset();

        changeSourceData();
        storage.fail(FakeSnapshotStorage.Fault.THROW_ON_PUT_PUBLIC);
        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(storage.publicObject(OBJECT_KEY)).contains(published);
        assertThat(state.calls).containsExactly("beginPublishing", "failPublishing:2");
        assertThat(state.committed).isEmpty();
        assertThat(state.version).isEqualTo(pointerBefore);
        assertThat(state.currentChecksum).isEqualTo(checksumBefore);
    }

    @Test
    @DisplayName("a refused PRIVATE upload aborts before anything public is written")
    void failedPrivateUploadAbortsEarly() {
        storage.fail(FakeSnapshotStorage.Fault.THROW_ON_PUT_PRIVATE);

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(storage.publicObjects()).isEmpty();
        assertThat(state.committed).isEmpty();
    }

    @Test
    @DisplayName("a read-back that 404s aborts the publish")
    void failedReadBack404() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_404);

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("HTTP 404");

        assertThat(state.committed).isEmpty();
    }

    @Test
    @DisplayName("an unreachable read-back aborts the publish")
    void failedReadBackTransport() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS);

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("connection reset");

        assertThat(state.committed).isEmpty();
    }

    @Test
    @DisplayName("a truncated read-back aborts the publish")
    void failedReadBackTruncated() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_TRUNCATED);

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("expected");

        assertThat(state.committed).isEmpty();
    }

    @Test
    @DisplayName("a corrupted read-back is caught by the checksum, not by luck")
    void checksumMismatchAborts() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_CORRUPTED);

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("checksum");

        assertThat(state.committed).isEmpty();
    }

    @Test
    @DisplayName("a stale edge answering for the promoted key fails the post-promotion re-verify")
    void staleEdgeAborts() {
        publisher.publish(TOURNAMENT, "admin");
        state.reset();
        changeSourceData();

        // The staging read succeeds; only the promoted key is answered with some other object's bytes.
        storage.fail(FakeSnapshotStorage.Fault.FETCH_STALE, OBJECT_KEY);
        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(state.committed)
            .as("a promotion that cannot be re-verified is never committed as the pointer")
            .isEmpty();
        assertThat(state.version).as("the pointer fell back to the last promoted version").isEqualTo(1);
    }

    @Test
    @DisplayName("publication is refused entirely when storage is not configured")
    void refusesWithoutStorage() {
        storage.setAvailable(false);

        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        assertThat(state.calls).as("not even a version number is burned").isEmpty();
    }

    // ================================================================== rollback

    @Test
    @DisplayName("rollback re-promotes the previous version's exact payload bytes")
    void rollbackRestoresPreviousBytes() {
        publisher.publish(TOURNAMENT, "admin");
        byte[] firstDocument = storage.publicObject(OBJECT_KEY).orElseThrow().clone();
        String firstChecksum = state.currentChecksum;

        changeSourceData();
        publisher.publish(TOURNAMENT, "admin");
        assertThat(storage.publicObject(OBJECT_KEY).orElseThrow()).isNotEqualTo(firstDocument);

        PublicSnapshotPublisher.Outcome outcome = publisher.rollback(TOURNAMENT, "admin");

        assertThat(outcome.version()).isEqualTo(1);
        assertThat(outcome.checksum()).isEqualTo(firstChecksum);
        // The PAYLOAD is restored byte for byte; the envelope carries a fresh generatedAt, which is
        // deliberately outside the checksum.
        String restored = new String(storage.publicObject(OBJECT_KEY).orElseThrow(), StandardCharsets.UTF_8);
        assertThat(SnapshotJson.payloadOf(restored))
            .isEqualTo(SnapshotJson.payloadOf(new String(firstDocument, StandardCharsets.UTF_8)));
        assertThat(SnapshotJson.versionOf(restored)).isEqualTo(1L);
        assertThat(state.version).isEqualTo(1);
        assertThat(state.currentChecksum).isEqualTo(firstChecksum);
    }

    @Test
    @DisplayName("a rolled-back object is verified through the public hostname too")
    void rollbackVerifies() {
        publisher.publish(TOURNAMENT, "admin");
        changeSourceData();
        publisher.publish(TOURNAMENT, "admin");
        String checksumBefore = state.currentChecksum;

        storage.fail(FakeSnapshotStorage.Fault.FETCH_CORRUPTED, OBJECT_KEY);
        assertThatThrownBy(() -> publisher.rollback(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(state.currentChecksum)
            .as("an unverifiable rollback does not move the recorded pointer")
            .isEqualTo(checksumBefore);
    }

    @Test
    @DisplayName("rollback is refused when there is no previous version")
    void rollbackWithoutHistory() {
        publisher.publish(TOURNAMENT, "admin");

        assertThatThrownBy(() -> publisher.rollback(TOURNAMENT, "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ไม่มีฉบับก่อนหน้า");
    }

    @Test
    @DisplayName("rollback refuses history whose bytes no longer match their recorded checksum")
    void rollbackRefusesTamperedHistory() {
        publisher.publish(TOURNAMENT, "admin");
        changeSourceData();
        publisher.publish(TOURNAMENT, "admin");

        storage.putPrivate(SnapshotKey.privatePayload(TOURNAMENT, 1),
            "{\"tampered\":true}".getBytes(StandardCharsets.UTF_8));

        assertThatThrownBy(() -> publisher.rollback(TOURNAMENT, "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("checksum");
    }

    // ================================================================== verify

    @Test
    @DisplayName("verify reports agreement between the served object and the recorded checksum")
    void verifyMatches() {
        publisher.publish(TOURNAMENT, "admin");

        assertThat(publisher.verify(TOURNAMENT).ok()).isTrue();
    }

    @Test
    @DisplayName("verify reports drift instead of silently republishing")
    void verifyDetectsDrift() {
        publisher.publish(TOURNAMENT, "admin");
        int operationsBefore = storage.operations().size();
        storage.fail(FakeSnapshotStorage.Fault.FETCH_CORRUPTED);

        PublicSnapshotPublisher.Outcome outcome = publisher.verify(TOURNAMENT);

        assertThat(outcome.ok()).isFalse();
        assertThat(outcome.detail()).contains("drift");
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .as("drift detection reports; it must never repair, or it could resurrect changed content")
            .allSatisfy(operation -> assertThat(operation).startsWith("fetch"));
    }

    // ================================================================== reconcile

    /**
     * The failure §7.3 exists for: the object is promoted (step 6) and then the process dies before
     * the commit (step 9). The bytes are public and were verified before promotion; only the database
     * disagrees. Reproduced here by failing the post-promotion read-back, which is what leaves the
     * pipeline in exactly that state.
     */
    private void promoteThenFailBeforeCommit() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS, OBJECT_KEY);
        assertThatThrownBy(() -> publisher.publish(TOURNAMENT, "admin"))
            .isInstanceOf(IllegalStateException.class);
        storage.clearFaults();
    }

    @Test
    @DisplayName("reconcile completes the commit for an object that was promoted but never committed")
    void reconcileCompletesTheCommit() {
        promoteThenFailBeforeCommit();
        byte[] promoted = storage.publicObject(OBJECT_KEY).orElseThrow().clone();
        assertThat(state.version).as("the pointer never reached the promoted version").isZero();
        assertThat(state.stateName).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        state.reset();
        int operationsBefore = storage.operations().size();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(outcome.version()).isEqualTo(1);
        assertThat(state.version).isEqualTo(1);
        assertThat(state.stateName).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(state.currentChecksum).isEqualTo(outcome.checksum());
        assertThat(storage.publicObject(OBJECT_KEY))
            .as("convergence is a bookkeeping change; the public bytes are already correct")
            .contains(promoted);
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .as("nothing is uploaded, nothing is deleted — only a read")
            .allSatisfy(operation -> assertThat(operation).startsWith("fetch"));
    }

    @Test
    @DisplayName("reconcile is idempotent: the second run observes agreement and writes nothing")
    void reconcileIsIdempotent() {
        promoteThenFailBeforeCommit();
        publisher.reconcile(TOURNAMENT, "admin");
        long versionAfterFirst = state.version;
        String checksumAfterFirst = state.currentChecksum;
        state.reset();
        int operationsBefore = storage.operations().size();

        PublicSnapshotPublisher.Outcome second = publisher.reconcile(TOURNAMENT, "admin");
        PublicSnapshotPublisher.Outcome third = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(second.ok()).isTrue();
        assertThat(second.detail()).contains("consistent");
        assertThat(third.detail()).contains("consistent");
        assertThat(state.calls).as("a converged tournament is not written to again").isEmpty();
        assertThat(state.version).isEqualTo(versionAfterFirst);
        assertThat(state.currentChecksum).isEqualTo(checksumAfterFirst);
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .allSatisfy(operation -> assertThat(operation).startsWith("fetch"));
    }

    @Test
    @DisplayName("reconcile on a healthy publication changes nothing")
    void reconcileOnHealthyPublication() {
        publisher.publish(TOURNAMENT, "admin");
        state.reset();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(outcome.detail()).contains("consistent");
        assertThat(state.calls).isEmpty();
        assertThat(state.version).isEqualTo(1);
    }

    @Test
    @DisplayName("reconcile resolves a PUBLISHING that died before it promoted anything")
    void reconcileResolvesAbandonedFirstAttempt() {
        state.beginPublishing(TOURNAMENT);   // a process that stopped right here
        state.reset();
        int operationsBefore = storage.operations().size();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(state.stateName)
            .as("PUBLISHING blocks every later attempt until something resolves it")
            .isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .as("nothing was ever public, so nothing is written")
            .allSatisfy(operation -> assertThat(operation).startsWith("fetch"));
    }

    @Test
    @DisplayName("reconcile unsticks a PUBLISHING whose object still matches the pointer")
    void reconcileUnsticksPublishingOverAHealthyObject() {
        publisher.publish(TOURNAMENT, "admin");
        String checksumBefore = state.currentChecksum;
        state.beginPublishing(TOURNAMENT);   // a second attempt that died immediately
        state.reset();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(state.stateName).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(state.version).isEqualTo(1);
        assertThat(state.currentChecksum).isEqualTo(checksumBefore);
    }

    @Test
    @DisplayName("reconcile restores the pointer's own bytes when something else is being served")
    void reconcileRestoresThePointersVersion() {
        publisher.publish(TOURNAMENT, "admin");
        changeSourceData();
        publisher.publish(TOURNAMENT, "admin");
        byte[] correct = storage.publicObject(OBJECT_KEY).orElseThrow().clone();
        String checksumBefore = state.currentChecksum;

        // Something replaced the public object with a document that matches no recorded version.
        storage.putPublic(OBJECT_KEY, "{\"payload\":{\"impostor\":true}}".getBytes(StandardCharsets.UTF_8),
            SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL, false);
        state.reset();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(outcome.version()).as("the pointer does not move; the object comes back to it").isEqualTo(2);
        assertThat(state.version).isEqualTo(2);
        assertThat(state.currentChecksum).isEqualTo(checksumBefore);
        String restored = new String(storage.publicObject(OBJECT_KEY).orElseThrow(), StandardCharsets.UTF_8);
        assertThat(SnapshotJson.payloadOf(restored))
            .isEqualTo(SnapshotJson.payloadOf(new String(correct, StandardCharsets.UTF_8)));
    }

    @Test
    @DisplayName("a restore replays private history — it never rebuilds from the database")
    void reconcileNeverRebuilds() {
        publisher.publish(TOURNAMENT, "admin");
        String publishedPayload = SnapshotJson.payloadOf(
            new String(storage.publicObject(OBJECT_KEY).orElseThrow(), StandardCharsets.UTF_8));

        // The source data moves on AFTER publication, then the public object is damaged. A reconciler
        // that regenerated would quietly publish the new data under the old version number.
        changeSourceData();
        storage.putPublic(OBJECT_KEY, "{}".getBytes(StandardCharsets.UTF_8),
            SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL, false);

        publisher.reconcile(TOURNAMENT, "admin");

        String restored = SnapshotJson.payloadOf(
            new String(storage.publicObject(OBJECT_KEY).orElseThrow(), StandardCharsets.UTF_8));
        assertThat(restored).isEqualTo(publishedPayload);
        assertThat(restored)
            .as("the current database state differs — proving the restore did not come from it")
            .isNotEqualTo(builder.build(TOURNAMENT).payloadJson());
    }

    @Test
    @DisplayName("reconcile refuses to commit a pointer onto bytes no recorded checksum matches")
    void reconcileRefusesUnverifiedBytes() {
        promoteThenFailBeforeCommit();
        // The promoted object is replaced by a document that still claims version 1 but whose payload
        // is not the one that was verified. Completing the commit here would point the pointer at
        // bytes nobody ever checked.
        String forged = SnapshotJson.envelope(
            new PublicSnapshotEnvelope.Meta(SnapshotJson.SCHEMA, 1L, Instant.EPOCH, "sha256-forged", 2,
                TOURNAMENT), "{\"forged\":true}");
        storage.putPublic(OBJECT_KEY, forged.getBytes(StandardCharsets.UTF_8),
            SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL, false);
        state.reset();
        int operationsBefore = storage.operations().size();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isFalse();
        assertThat(outcome.detail()).contains("matches no recorded publication");
        assertThat(state.version).as("the pointer stays at nothing").isZero();
        assertThat(state.committed).isEmpty();
        assertThat(state.stateName).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .as("it reports; it does not delete the object and does not publish over it")
            .allSatisfy(operation -> assertThat(operation).startsWith("fetch"));
    }

    @Test
    @DisplayName("reconcile never re-creates a public object that is not there")
    void reconcileDoesNotResurrectAnAbsentObject() {
        publisher.publish(TOURNAMENT, "admin");
        storage.deletePublic(OBJECT_KEY);
        state.reset();
        int operationsBefore = storage.operations().size();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isFalse();
        assertThat(outcome.detail()).contains("nothing is served");
        assertThat(state.stateName).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(storage.publicObjects())
            .as("an absent object is also what a retraction looks like; repair would resurrect it")
            .isEmpty();
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .allSatisfy(operation -> assertThat(operation).startsWith("fetch"));
    }

    @Test
    @DisplayName("reconcile refuses a retracted tournament outright")
    void reconcileRefusesRetracted() {
        publisher.publish(TOURNAMENT, "admin");
        state.stateName = PublicSnapshotState.RETRACTED;
        state.reset();
        int operationsBefore = storage.operations().size();

        assertThatThrownBy(() -> publisher.reconcile(TOURNAMENT, "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        assertThat(state.calls).isEmpty();
        assertThat(storage.operations().subList(operationsBefore, storage.operations().size()))
            .as("it does not even look, so it can never repair withdrawn data back into existence")
            .isEmpty();
    }

    @Test
    @DisplayName("an unreachable read makes reconcile inconclusive rather than destructive")
    void reconcileInconclusiveOnTransportFailure() {
        publisher.publish(TOURNAMENT, "admin");
        state.reset();
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS);

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isFalse();
        assertThat(outcome.detail()).contains("inconclusive");
        assertThat(state.calls)
            .as("a network blip must not be able to mark a healthy tournament failed")
            .isEmpty();
        assertThat(state.stateName).isEqualTo(PublicSnapshotState.PUBLISHED);
    }

    @Test
    @DisplayName("reconcile on a tournament that was never published is a no-op")
    void reconcileWithNothingPublished() {
        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(TOURNAMENT, "admin");

        assertThat(outcome.ok()).isTrue();
        assertThat(outcome.detail()).contains("nothing is published");
        assertThat(state.calls).isEmpty();
        assertThat(storage.publicObjects()).isEmpty();
    }

    @Test
    @DisplayName("reconcile is refused entirely when storage is not configured")
    void reconcileRefusesWithoutStorage() {
        storage.setAvailable(false);

        assertThatThrownBy(() -> publisher.reconcile(TOURNAMENT, "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        assertThat(state.calls).isEmpty();
    }

    // ================================================================== test double

    /**
     * A {@link PublicSnapshotState} that records the pipeline's calls in order instead of touching a
     * database. The ORDER is the assertion target: it is what proves the pointer moves last.
     */
    private static final class RecordingState extends PublicSnapshotState {
        final List<String> calls = new ArrayList<>();
        final List<String> committed = new ArrayList<>();
        /** Publication rows by version, with the same status transitions the real SQL performs. */
        private final Map<Long, Publication> publications = new LinkedHashMap<>();
        /** The pointer: the version currently public. Moves only on commit. */
        long version;
        /** The allocator: never decreases, so a burned number is never handed out twice. */
        long highWater;
        String currentChecksum;
        String stateName = NOT_PUBLISHED;

        RecordingState() {
            // Every method the pipeline calls is overridden below, so neither collaborator is ever
            // reached. Approval is Phase E's gate inside beginPublishing, which this double replaces
            // wholesale; SnapshotApprovalDatabaseTest exercises the real one against real SQL.
            super(mock(JdbcTemplate.class), mock(SnapshotApprovalService.class));
        }

        void reset() {
            calls.clear();
            committed.clear();
        }

        @Override
        public Status status(UUID tournamentId) {
            return new Status(tournamentId, SnapshotFixtures.TOURNAMENT_NAME, TOKEN, stateName, version,
                null, currentChecksum, SnapshotKey.publicObject(TOKEN), 4, 0);
        }

        @Override
        public long beginPublishing(UUID tournamentId) {
            calls.add("beginPublishing");
            stateName = PUBLISHING;
            return ++highWater;   // the pointer stays put until commitPublished
        }

        @Override
        public void recordVerified(UUID id, long v, String checksum, long bytes, String key, String actor) {
            calls.add("recordVerified:" + v);
            publications.put(v, new Publication(v, checksum, bytes, key, "VERIFIED", null, actor, Instant.EPOCH));
        }

        @Override
        public void commitPublished(UUID id, long v, String checksum, String actor) {
            calls.add("commitPublished:" + v);
            promote(v, checksum, actor);
        }

        @Override
        public void commitReconciled(UUID id, long v, String checksum, String actor, String detail) {
            calls.add("commitReconciled:" + v);
            promote(v, checksum, actor);
        }

        private void promote(long v, String checksum, String actor) {
            committed.add(v + ":" + checksum);
            version = v;
            highWater = Math.max(highWater, v);
            currentChecksum = checksum;
            stateName = PUBLISHED;
            Publication existing = publications.get(v);
            publications.put(v, new Publication(v, checksum,
                existing == null ? 0 : existing.payloadBytes(),
                existing == null ? "" : existing.objectKey(), "PROMOTED", null, actor, Instant.EPOCH));
        }

        @Override
        public void failPublishing(UUID id, long v, String reason, String actor) {
            // Mirrors the real implementation: the pointer is not touched, because it was never
            // moved off the last promoted version in the first place. The row keeps the checksum it
            // recorded at step 5 — that is what the reconciler later reads as evidence.
            calls.add("failPublishing:" + v);
            stateName = lastPromoted(id).isPresent() ? PUBLISHED : PUBLISH_FAILED;
            Publication existing = publications.get(v);
            publications.put(v, existing == null
                ? new Publication(v, "", 0, "", "FAILED", reason, actor, Instant.EPOCH)
                : new Publication(v, existing.checksum(), existing.payloadBytes(), existing.objectKey(),
                    "FAILED", reason, actor, Instant.EPOCH));
        }

        @Override
        public void markPublishFailed(UUID id, String reason, String actor) {
            calls.add("markPublishFailed");
            stateName = PUBLISH_FAILED;
        }

        @Override
        public Optional<Publication> publication(UUID tournamentId, long v) {
            return Optional.ofNullable(publications.get(v));
        }

        @Override
        public Optional<Publication> lastPromoted(UUID tournamentId) {
            return promotedRows().max(Comparator.comparingLong(Publication::version));
        }

        @Override
        public Optional<Publication> previousPromoted(UUID tournamentId, long currentVersion) {
            return promotedRows().filter(publication -> publication.version() < currentVersion)
                .max(Comparator.comparingLong(Publication::version));
        }

        private java.util.stream.Stream<Publication> promotedRows() {
            return publications.values().stream().filter(p -> "PROMOTED".equals(p.status()));
        }
    }
}
