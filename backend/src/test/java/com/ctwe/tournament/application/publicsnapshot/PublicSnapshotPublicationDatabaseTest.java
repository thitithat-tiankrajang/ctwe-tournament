package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.application.excelexport.TournamentExcelExportService;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.infrastructure.storage.SnapshotStorageProperties;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Phase B against a real PostgreSQL: the V31 schema, the state machine, and guardrail G1.
 *
 * <p>{@code PublicSnapshotPublisherTest} drives the pipeline over a fake state object, which proves
 * the ordering but says nothing about the SQL. This test runs the real {@link PublicSnapshotState}
 * against real rows — the {@code CHECK} constraint, the {@code FOR UPDATE} lock, the unique
 * {@code (tournament_id, version)} key, and the column G1 reads.
 *
 * <p>R2 is still a fake ({@link FakeSnapshotStorage}); an object store is the one dependency that
 * cannot be stood up in CI. Everything between PostgreSQL and that boundary is real.
 *
 * <p>Same harness as the other database tests: localhost:5432, one rolled-back transaction per test,
 * enabled only when the database password is in the environment.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class PublicSnapshotPublicationDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final SnapshotStorageProperties PROPERTIES = new SnapshotStorageProperties(
        "https://account.r2.cloudflarestorage.com", "key", "secret", "ctwe-snapshots",
        "ctwe-snapshots-public", "https://snapshot.ct-we.com", "zone", "token");

    @Autowired TournamentCardService service;
    @Autowired PublicSnapshotBuilder builder;
    @Autowired PublicSnapshotState state;
    @Autowired SnapshotApprovalService approvals;
    @Autowired TournamentExcelExportService excelExport;
    @Autowired JdbcTemplate jdbc;
    /** The beans the ABSENT configuration actually produced in this context. */
    @Autowired com.ctwe.tournament.infrastructure.storage.SnapshotObjectStore realStore;
    @Autowired com.ctwe.tournament.infrastructure.storage.PublicSnapshotFetcher realFetcher;
    @Autowired com.ctwe.tournament.infrastructure.cdn.CachePurgeClient realPurge;

    private final FakeSnapshotStorage storage = new FakeSnapshotStorage();
    private PublicSnapshotPublisher publisher;
    private UUID tournamentId;
    private String accessToken;

    @BeforeEach
    void createTournament() {
        publisher = new PublicSnapshotPublisher(builder, state, storage, storage, storage, PROPERTIES);
        tournamentId = UUID.randomUUID();
        accessToken = "phase-b-" + tournamentId.toString().substring(0, 8);
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, "CTWE Phase B ทดสอบ", accessToken);
    }

    // ================================================================== V31 schema

    @Test
    @DisplayName("V31 defaults every existing tournament to NOT_PUBLISHED at version 0")
    void defaultsAreInert() {
        PublicSnapshotState.Status status = state.status(tournamentId);

        assertThat(status.state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
        assertThat(status.version()).isZero();
        assertThat(status.publishedAt()).isNull();
        assertThat(status.checksum()).isNull();
        assertThat(status.objectKey()).isEqualTo(SnapshotKey.publicObject(accessToken));
    }

    @Test
    @DisplayName("the CHECK constraint rejects a state outside the documented lifecycle")
    void stateIsConstrained() {
        assertThatThrownBy(() -> jdbc.update(
            "UPDATE tournaments SET snapshot_state = 'WHATEVER' WHERE id = ?", tournamentId))
            .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }

    // ================================================================== preconditions

    @Test
    @DisplayName("a tournament with no cards cannot be published")
    void refusesEmptyTournament() {
        assertThatThrownBy(() -> state.beginPublishing(tournamentId))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ยังไม่มีการ์ด");

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
    }

    /**
     * FINISHED/CLOSED is a PRECONDITION, never something publication brings about.
     *
     * <p>Publication must not mutate {@code tournament_cards} — not to force a card CLOSED, not to
     * change any status. A tournament that is not ready is rejected and left exactly as it was; the
     * operator finishes the cards, then publishes. These four tests pin every half of that: the
     * rejection, the untouched card rows, the untouched publication state, and the absent pointer.
     */
    @Test
    @DisplayName("an unfinished card blocks publication and names how many")
    void refusesUnfinishedCards() {
        finishedCard();
        card();   // left in registration

        assertThatThrownBy(() -> state.beginPublishing(tournamentId))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ยังไม่จบ 1 ใบ");

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
    }

    @Test
    @DisplayName("a rejected publish leaves every card row byte-identical — nothing is forced CLOSED")
    void rejectionDoesNotMutateCards() {
        finishedCard();
        UUID unfinished = card();
        String cardsBefore = cardRowDigest();
        String statusBefore = jdbc.queryForObject(
            "SELECT status FROM tournament_cards WHERE id = ?", String.class, unfinished);

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class);

        assertThat(cardRowDigest())
            .as("publication must never UPDATE tournament_cards")
            .isEqualTo(cardsBefore);
        assertThat(jdbc.queryForObject("SELECT status FROM tournament_cards WHERE id = ?", String.class, unfinished))
            .as("the blocking card keeps its own status; publication does not close it")
            .isEqualTo(statusBefore)
            .isNotEqualTo("CLOSED");
    }

    @Test
    @DisplayName("a rejected publish commits no PUBLISHED state, no pointer, and no public object")
    void rejectionCommitsNothing() {
        finishedCard();
        card();

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class);

        PublicSnapshotState.Status status = state.status(tournamentId);
        assertThat(status.state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
        assertThat(status.version()).isZero();
        assertThat(status.checksum()).isNull();
        assertThat(status.publishedAt()).isNull();
        assertThat(state.history(tournamentId)).isEmpty();
        assertThat(storage.publicObjects())
            .as("nothing may be exposed as published")
            .isEmpty();
    }

    @Test
    @DisplayName("a successful publish also leaves every card row untouched")
    void successDoesNotMutateCards() {
        finishedCard();
        approvePublication();
        String cardsBefore = cardRowDigest();

        publisher.publish(tournamentId, "ittest");

        assertThat(cardRowDigest())
            .as("even on the happy path, publication is read-only with respect to tournament data")
            .isEqualTo(cardsBefore);
    }

    /** Content digest of this tournament's card rows, every column included. */
    private String cardRowDigest() {
        return jdbc.queryForObject("""
            SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM
              (SELECT md5(c::text) AS h FROM tournament_cards c WHERE c.tournament_id = ?) row_digests
            """, String.class, tournamentId);
    }

    @Test
    @DisplayName("a second attempt is refused while one is already in flight")
    void refusesConcurrentPublish() {
        finishedCard();
        approvePublication();
        state.beginPublishing(tournamentId);

        assertThatThrownBy(() -> state.beginPublishing(tournamentId))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    @DisplayName("a retracted tournament is never republished by this path")
    void refusesRetracted() {
        finishedCard();
        jdbc.update("UPDATE tournaments SET snapshot_state = 'RETRACTED' WHERE id = ?", tournamentId);

        // Phase F sets this state; Phase B only has to refuse to resurrect it.
        assertThatThrownBy(() -> state.beginPublishing(tournamentId))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ถูกถอนแล้ว");
    }

    // ================================================================== the pointer

    @Test
    @DisplayName("a full publish advances state, version, checksum and published_at exactly once")
    void publishAdvancesThePointer() {
        finishedCard();
        approvePublication();

        PublicSnapshotPublisher.Outcome outcome = publisher.publish(tournamentId, "ittest");

        PublicSnapshotState.Status status = state.status(tournamentId);
        assertThat(outcome.ok()).isTrue();
        assertThat(status.state()).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(status.version()).isEqualTo(1);
        assertThat(status.checksum()).isEqualTo(outcome.checksum());
        assertThat(status.publishedAt()).isNotNull();
        assertThat(state.history(tournamentId)).singleElement()
            .satisfies(publication -> assertThat(publication.status()).isEqualTo("PROMOTED"));

        // The object under the derived key is what the pointer names.
        String document = new String(
            storage.publicObject(status.objectKey()).orElseThrow(), StandardCharsets.UTF_8);
        assertThat(SnapshotJson.checksum(SnapshotJson.payloadOf(document))).isEqualTo(status.checksum());
    }

    @Test
    @DisplayName("a failed publish leaves the pointer where it was and records the failure")
    void failedPublishDoesNotAdvanceThePointer() {
        finishedCard();
        approvePublication();
        publisher.publish(tournamentId, "ittest");
        PublicSnapshotState.Status before = state.status(tournamentId);

        storage.fail(FakeSnapshotStorage.Fault.FETCH_CORRUPTED);
        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(IllegalStateException.class);

        PublicSnapshotState.Status after = state.status(tournamentId);
        assertThat(after.state()).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(after.version()).isEqualTo(before.version());
        assertThat(after.checksum()).isEqualTo(before.checksum());
        // The burned version number is recorded as FAILED rather than reused.
        assertThat(state.history(tournamentId))
            .anySatisfy(publication -> {
                assertThat(publication.version()).isEqualTo(2);
                assertThat(publication.status()).isEqualTo("FAILED");
            });
    }

    @Test
    @DisplayName("a first-ever publish that fails leaves the tournament PUBLISH_FAILED, not PUBLISHED")
    void firstPublishFailure() {
        finishedCard();
        approvePublication();
        storage.fail(FakeSnapshotStorage.Fault.FETCH_404);

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(storage.publicObjects()).isEmpty();
    }

    @Test
    @DisplayName("version numbers are unique per tournament even across failures")
    void versionsAreUnique() {
        finishedCard();
        approvePublication();
        publisher.publish(tournamentId, "ittest");
        storage.fail(FakeSnapshotStorage.Fault.FETCH_404);
        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest")).isInstanceOf(IllegalStateException.class);
        storage.clearFaults();
        publisher.publish(tournamentId, "ittest");

        assertThat(state.history(tournamentId)).extracting(PublicSnapshotState.Publication::version)
            .containsExactly(3L, 2L, 1L)
            .doesNotHaveDuplicates();
        assertThat(state.status(tournamentId).version()).isEqualTo(3);
    }

    // ================================================================== reconcile

    /**
     * Leaves the tournament in the state architecture §7.3 is written for: the object is promoted and
     * public, and the database still does not know. The post-promotion read-back is what fails, which
     * is what a process dying between steps 6 and 9 looks like from the outside.
     */
    private void promoteThenFailBeforeCommit() {
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS, state.status(tournamentId).objectKey());
        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(IllegalStateException.class);
        storage.clearFaults();
    }

    @Test
    @DisplayName("reconcile completes the commit against real SQL and promotes the recorded row")
    void reconcileCompletesTheCommit() {
        finishedCard();
        approvePublication();
        promoteThenFailBeforeCommit();
        PublicSnapshotState.Status stranded = state.status(tournamentId);
        assertThat(stranded.state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(stranded.version()).isZero();
        String cardsBefore = cardRowDigest();

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(tournamentId, "ittest");

        PublicSnapshotState.Status after = state.status(tournamentId);
        assertThat(outcome.ok()).isTrue();
        assertThat(after.state()).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(after.version()).isEqualTo(1);
        assertThat(after.checksum()).isEqualTo(outcome.checksum());
        assertThat(after.publishedAt()).isNotNull();
        assertThat(state.history(tournamentId)).singleElement()
            .satisfies(publication -> {
                assertThat(publication.version()).isEqualTo(1);
                assertThat(publication.status()).isEqualTo("PROMOTED");
            });
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_logs WHERE action = 'RECONCILE_PUBLIC_SNAPSHOT'
              AND new_value LIKE ?
            """, Integer.class, "%" + tournamentId + "%")).isEqualTo(1);
        assertThat(cardRowDigest())
            .as("reconciliation is bookkeeping; it must not touch tournament data either")
            .isEqualTo(cardsBefore);
        // And the served object was never rewritten — the pointer moved onto bytes already public.
        assertThat(SnapshotJson.checksum(SnapshotJson.payloadOf(new String(
            storage.publicObject(after.objectKey()).orElseThrow(), StandardCharsets.UTF_8))))
            .isEqualTo(after.checksum());
    }

    @Test
    @DisplayName("reconcile is idempotent against real SQL: repeated runs leave the same row")
    void reconcileIsIdempotent() {
        finishedCard();
        approvePublication();
        promoteThenFailBeforeCommit();
        publisher.reconcile(tournamentId, "ittest");
        String rowAfterFirst = tournamentSnapshotRow();

        publisher.reconcile(tournamentId, "ittest");
        publisher.reconcile(tournamentId, "ittest");

        assertThat(tournamentSnapshotRow()).isEqualTo(rowAfterFirst);
        assertThat(state.history(tournamentId)).singleElement()
            .satisfies(publication -> assertThat(publication.status()).isEqualTo("PROMOTED"));
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_logs WHERE action = 'RECONCILE_PUBLIC_SNAPSHOT' AND new_value LIKE ?
            """, Integer.class, "%" + tournamentId + "%"))
            .as("the converged runs write nothing at all, not even an audit row")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("reconcile unsticks a PUBLISHING left behind by a crash, and publishing works again")
    void reconcileUnsticksPublishing() {
        finishedCard();
        approvePublication();
        state.beginPublishing(tournamentId);   // a process that stopped immediately after step 1
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISHING);
        // Until something resolves it, every later attempt is refused by the state machine itself.
        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("กำลังเผยแพร่อยู่แล้ว");

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(tournamentId, "ittest");

        assertThat(outcome.ok()).isTrue();
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);

        // Publishing is possible again. The abandoned attempt never reached the record step, so it
        // left no row, nothing private that anything references, and certainly nothing public — its
        // number is therefore still free (§7.6 allocates from the recorded high-water mark). What
        // must never be reused is a number some bytes were recorded under; versionsAreUnique pins that.
        PublicSnapshotPublisher.Outcome republished = publisher.publish(tournamentId, "ittest");
        assertThat(republished.version()).isEqualTo(1);
        assertThat(state.status(tournamentId).version()).isEqualTo(1);
        assertThat(state.history(tournamentId)).singleElement()
            .satisfies(publication -> assertThat(publication.status()).isEqualTo("PROMOTED"));
    }

    @Test
    @DisplayName("reconcile restores the pointer's own bytes when the public object was replaced")
    void reconcileRestoresThePointersVersion() {
        finishedCard();
        approvePublication();
        publisher.publish(tournamentId, "ittest");
        PublicSnapshotState.Status before = state.status(tournamentId);
        String cardsBefore = cardRowDigest();

        storage.putPublic(before.objectKey(), "{\"payload\":{\"impostor\":true}}".getBytes(StandardCharsets.UTF_8),
            SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL, false);

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(tournamentId, "ittest");

        assertThat(outcome.ok()).isTrue();
        PublicSnapshotState.Status after = state.status(tournamentId);
        assertThat(after.version()).isEqualTo(before.version());
        assertThat(after.checksum()).isEqualTo(before.checksum());
        assertThat(after.state()).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(SnapshotJson.checksum(SnapshotJson.payloadOf(new String(
            storage.publicObject(after.objectKey()).orElseThrow(), StandardCharsets.UTF_8))))
            .isEqualTo(before.checksum());
        assertThat(cardRowDigest()).isEqualTo(cardsBefore);
    }

    @Test
    @DisplayName("reconcile never re-creates an absent object, and marks the divergence instead")
    void reconcileDoesNotResurrectAnAbsentObject() {
        finishedCard();
        approvePublication();
        publisher.publish(tournamentId, "ittest");
        PublicSnapshotState.Status before = state.status(tournamentId);
        storage.deletePublic(before.objectKey());

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(tournamentId, "ittest");

        assertThat(outcome.ok()).isFalse();
        assertThat(storage.publicObjects()).isEmpty();
        PublicSnapshotState.Status after = state.status(tournamentId);
        assertThat(after.state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(after.version())
            .as("the pointer still records which version was verified — that is what an operator needs")
            .isEqualTo(before.version());
        assertThat(after.checksum()).isEqualTo(before.checksum());
    }

    @Test
    @DisplayName("reconcile refuses a RETRACTED tournament, so no repair can resurrect withdrawn data")
    void reconcileRefusesRetracted() {
        finishedCard();
        approvePublication();
        publisher.publish(tournamentId, "ittest");
        jdbc.update("UPDATE tournaments SET snapshot_state = 'RETRACTED' WHERE id = ?", tournamentId);

        assertThatThrownBy(() -> publisher.reconcile(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.RETRACTED);
    }

    /** The snapshot columns as one string, so "nothing changed" is a single comparison. */
    private String tournamentSnapshotRow() {
        return jdbc.queryForObject("""
            SELECT snapshot_state || '|' || snapshot_version || '|' || coalesce(snapshot_checksum, '-')
                 || '|' || coalesce(published_at::text, '-')
            FROM tournaments WHERE id = ?
            """, String.class, tournamentId);
    }

    // ================================================================== safety

    @Test
    @DisplayName("publication writes snapshot bookkeeping only — no tournament data changes")
    void publicationTouchesNoTournamentData() {
        finishedCard();
        approvePublication();
        Map<String, String> before = tournamentDataDigest();

        publisher.publish(tournamentId, "ittest");

        assertThat(tournamentDataDigest())
            .as("PostgreSQL is the source of truth; publishing a derived artifact must not alter it")
            .isEqualTo(before);
    }

    @Test
    @DisplayName("G1: a published snapshot blocks the destructive Excel purge against the real column")
    void publishedSnapshotBlocksPurge() {
        finishedCard();
        approvePublication();
        publisher.publish(tournamentId, "ittest");

        assertThatThrownBy(() -> excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", "CTWE Phase B ทดสอบ"), "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        // The tournament and its cards are still there — the guard fired before any deletion.
        assertThat(jdbc.queryForObject("SELECT count(*) FROM tournaments WHERE id = ?", Integer.class, tournamentId))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM tournament_cards WHERE tournament_id = ?", Integer.class, tournamentId))
            .isEqualTo(1);
    }

    @Test
    @DisplayName("the application runs its live features with no snapshot configuration at all")
    void liveFunctionalityNeedsNoSnapshotConfiguration() {
        // This whole Spring context booted without any app.snapshot-storage.* value — that is the
        // ABSENT case, asserted here rather than merely relied upon. Publication is unavailable;
        // everything a live tournament needs keeps working, including snapshot GENERATION, which
        // never touches storage.
        assertThat(realStore.available()).isFalse();
        assertThat(realFetcher.available()).isFalse();

        UUID cardId = finishedCard();
        assertThat(service.get(cardId, false).status().name()).isEqualTo("FINISHED");
        assertThat(builder.build(tournamentId).payload().cards()).hasSize(1);

        PublicSnapshotPublisher unconfigured = new PublicSnapshotPublisher(
            builder, state, realStore, realFetcher, realPurge, PROPERTIES);
        assertThatThrownBy(() -> unconfigured.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        assertThat(state.status(tournamentId).state())
            .as("a refused publish must not move the state machine at all")
            .isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
    }

    @Test
    @DisplayName("G1: a publish that promoted then failed verification still blocks the purge")
    void promotedThenFailedBlocksPurge() {
        finishedCard();
        approvePublication();
        // Fail only the POST-promotion read-back: staging verifies, the object is promoted, and then
        // step 8 fails. No PROMOTED row is ever written, so the tournament lands in PUBLISH_FAILED —
        // while s/{h}.json is live and being served.
        // Scoped to the promoted key only: "s/{h}.staging-1.json" does not end with "s/{h}.json",
        // so step 4 (staging) verifies normally and only step 8 fails.
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS, state.status(tournamentId).objectKey());
        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(IllegalStateException.class);

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(storage.publicObject(state.status(tournamentId).objectKey()))
            .as("the object WAS promoted before verification failed — it is public right now")
            .isPresent();

        // Purging here would delete the rows behind a live public object: unregenerable forever.
        assertThatThrownBy(() -> excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", "CTWE Phase B ทดสอบ"), "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        assertThat(jdbc.queryForObject("SELECT count(*) FROM tournaments WHERE id = ?", Integer.class, tournamentId))
            .isEqualTo(1);
    }

    @Test
    @DisplayName("G1: an unpublished tournament still purges, so the guardrail is not a blanket block")
    void unpublishedTournamentStillPurges() {
        finishedCard();

        excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", "CTWE Phase B ทดสอบ"), "ittest");

        assertThat(jdbc.queryForObject("SELECT count(*) FROM tournaments WHERE id = ?", Integer.class, tournamentId))
            .isZero();
    }

    // ================================================================== fixtures

    /** A content digest of every table publication must not touch. */
    private Map<String, String> tournamentDataDigest() {
        Map<String, String> digest = new LinkedHashMap<>();
        for (String table : List.of("tournaments", "tournament_cards", "players", "matches",
            "standings", "games", "pairing_snapshots", "final_pairings", "final_game_results")) {
            digest.put(table, jdbc.queryForObject(
                "SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM "
                    + "(SELECT md5(t::text) AS h FROM \"" + table + "\" t) row_digests", String.class));
        }
        // tournaments legitimately changes (snapshot_state / version / checksum / published_at), so it
        // is compared with those columns masked out rather than excluded entirely.
        digest.put("tournaments", jdbc.queryForObject("""
            SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM (
              SELECT md5(ROW(id, name, access_token, status, created_by, created_at, version)::text) AS h
              FROM tournaments) row_digests
            """, String.class));
        return digest;
    }

    /**
     * Satisfies Phase E's gate the way {@code approve()} would, without its operator-facing guards.
     *
     * <p>These tests are about the pipeline, not about the approval dialog, so they record the row
     * directly — but through the REAL {@link SnapshotApprovalService#fingerprint} function, so an
     * approval here is valid for exactly the reasons a real one is. {@code SnapshotApprovalDatabaseTest}
     * covers authorization, re-authentication, the typed name and the acknowledgment revision.
     */
    private void approvePublication() {
        jdbc.update("""
            INSERT INTO public_snapshot_approvals
                (tournament_id, approved_by, acknowledgment_rev, content_fingerprint, expires_at)
            VALUES (?, 'ittest', ?, ?, now() + interval '7 days')
            """, tournamentId, SnapshotApprovalService.ACKNOWLEDGMENT_REV, approvals.fingerprint(tournamentId));
    }

    private UUID card() {
        List<Integer> maxDiffs = new ArrayList<>(List.of(500, 500, 500));
        return service.create(new CardDtos.CreateCardRequest(tournamentId, "PhaseB-" + UUID.randomUUID(),
            "DIV", 3, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS), maxDiffs,
            "NONE", 0, false, PairingRuleType.RANDOM), "ittest").id();
    }

    private UUID finishedCard() {
        UUID cardId = card();
        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < 6; i++) players.add(new CardDtos.BulkPlayerEntry("First" + i, "Last" + i, "School" + i));
        service.addPlayersBulk(cardId, players, "ittest");
        service.simulate(cardId, "ittest");
        return cardId;
    }
}
