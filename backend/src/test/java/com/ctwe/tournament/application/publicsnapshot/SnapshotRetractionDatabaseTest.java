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

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Phase F — retraction — against a real PostgreSQL.
 *
 * <p>Two properties carry this phase, and they pull in opposite directions. <b>Retraction must
 * always work</b> (invariant I9): no approval, no password, no card preconditions, because the
 * situation it exists for is "this must not be public, now". And <b>nothing may put it back</b>
 * (§4.5): once withdrawn, every path that can write the public object has to refuse, or the
 * withdrawal was theatre.
 *
 * <p>The second property is why several tests below attack {@code rollback} and {@code reconcile}
 * rather than {@code retract}. A no-resurrection rule enforced on the obvious path and forgotten on
 * the other two is not a rule.
 *
 * <p>Same harness as the other database tests: localhost:5432, one rolled-back transaction per test,
 * enabled only when the database password is in the environment. R2 stays a fake; everything up to
 * that boundary is real.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class SnapshotRetractionDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final SnapshotStorageProperties PROPERTIES = new SnapshotStorageProperties(
        "https://account.r2.cloudflarestorage.com", "key", "secret", "ctwe-snapshots",
        "ctwe-snapshots-public", "https://snapshot.ct-we.com", "zone", "token");

    private static final String TOURNAMENT_NAME = "CTWE Phase F ทดสอบ";

    @Autowired TournamentCardService service;
    @Autowired PublicSnapshotBuilder builder;
    @Autowired PublicSnapshotState state;
    @Autowired SnapshotApprovalService approvals;
    @Autowired TournamentExcelExportService excelExport;
    @Autowired JdbcTemplate jdbc;

    private final FakeSnapshotStorage storage = new FakeSnapshotStorage();
    private PublicSnapshotPublisher publisher;
    private UUID tournamentId;

    @BeforeEach
    void createTournament() {
        publisher = new PublicSnapshotPublisher(builder, state, storage, storage, storage, PROPERTIES);
        tournamentId = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, TOURNAMENT_NAME, "phase-f-" + tournamentId.toString().substring(0, 8));
    }

    // ================================================================== ① the public surface goes

    @Test
    @DisplayName("retraction deletes the one public object and records who withdrew it")
    void retractionRemovesThePublicSurface() {
        publishOnce();
        String objectKey = state.status(tournamentId).objectKey();
        assertThat(storage.publicObject(objectKey)).isPresent();

        PublicSnapshotPublisher.Outcome outcome = publisher.retract(tournamentId, "ittest");

        assertThat(outcome.ok()).isTrue();
        assertThat(storage.publicObjects())
            .as("§7.1: one object per tournament is what makes withdrawal provably complete")
            .isEmpty();

        Map<String, Object> row = jdbc.queryForMap("""
            SELECT snapshot_state, snapshot_version, snapshot_checksum, retracted_by, retracted_at
            FROM tournaments WHERE id = ?
            """, tournamentId);
        assertThat(row.get("snapshot_state")).isEqualTo(PublicSnapshotState.RETRACTED);
        assertThat(row.get("retracted_by")).isEqualTo("ittest");
        assertThat(row.get("retracted_at")).isNotNull();
        assertThat(row.get("snapshot_version"))
            .as("the pointer is the record of what WAS published — an audit needs it after a withdrawal")
            .isEqualTo(1L);
        assertThat(row.get("snapshot_checksum")).isNotNull();
    }

    @Test
    @DisplayName("the delete is issued and the key is purged from the edge")
    void retractionPurgesTheEdge() {
        publishOnce();
        String objectKey = state.status(tournamentId).objectKey();
        String publicUrl = PROPERTIES.publicUrl(objectKey);
        int before = storage.purged().size();

        publisher.retract(tournamentId, "ittest");

        assertThat(storage.operations()).contains("deletePublic " + objectKey);
        assertThat(storage.purged().subList(before, storage.purged().size())).contains(publicUrl);
    }

    // ================================================================== ② verified 404

    @Test
    @DisplayName("retraction verifies the 404 through the public hostname, cache-busted")
    void retractionVerifiesThe404() {
        publishOnce();
        String objectKey = state.status(tournamentId).objectKey();
        int before = storage.operations().size();

        PublicSnapshotPublisher.Outcome outcome = publisher.retract(tournamentId, "ittest");

        assertThat(storage.operations().subList(before, storage.operations().size()))
            .contains("fetch " + objectKey + " (cache-bust)");
        assertThat(outcome.detail()).contains("verified 404");
    }

    /**
     * §4.5's SLA, stated honestly: a still-cached copy does not undo the deletion. The state must
     * follow the bytes, not the cache — a database that claimed PUBLISHED after the object was gone
     * would be wrong in the direction that matters.
     */
    @Test
    @DisplayName("an edge still serving the object does not block the withdrawal, and says so")
    void staleEdgeDoesNotBlockRetraction() {
        publishOnce();
        storage.fail(FakeSnapshotStorage.Fault.FETCH_STALE);

        PublicSnapshotPublisher.Outcome outcome = publisher.retract(tournamentId, "ittest");

        assertThat(outcome.ok()).as("the 404 was not observed, and the outcome admits it").isFalse();
        assertThat(outcome.detail()).contains("max-age=300");
        assertThat(state.status(tournamentId).state())
            .as("the object IS deleted; the state must not claim otherwise")
            .isEqualTo(PublicSnapshotState.RETRACTED);
        assertThat(storage.publicObjects()).isEmpty();
    }

    // ================================================================== ③ no resurrection

    @Test
    @DisplayName("publish is refused after retraction")
    void publishCannotResurrect() {
        publishOnce();
        publisher.retract(tournamentId, "ittest");
        approveDirectly();   // even with a fresh approval row present

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ถูกถอนแล้ว");

        assertThat(storage.publicObjects()).isEmpty();
    }

    /**
     * The path that was actually open before Phase F. {@code rollback} re-promotes bytes straight
     * from private history, so without a guard it would have put a withdrawn snapshot back on the
     * CDN — no approval, no publish, one call.
     */
    @Test
    @DisplayName("rollback is refused after retraction")
    void rollbackCannotResurrect() {
        publishOnce();
        changeCardsAndPublishAgain();
        publisher.retract(tournamentId, "ittest");

        assertThatThrownBy(() -> publisher.rollback(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ถูกถอนแล้ว");

        assertThat(storage.publicObjects())
            .as("private history survives retraction, but nothing may promote it back")
            .isEmpty();
    }

    @Test
    @DisplayName("reconcile is refused after retraction")
    void reconcileCannotResurrect() {
        publishOnce();
        publisher.retract(tournamentId, "ittest");

        assertThatThrownBy(() -> publisher.reconcile(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        assertThat(storage.publicObjects()).isEmpty();
    }

    @Test
    @DisplayName("approval is refused after retraction, so the pipeline cannot be re-entered")
    void approvalCannotResurrect() {
        publishOnce();
        publisher.retract(tournamentId, "ittest");

        assertThatThrownBy(() -> approvals.approve(tournamentId, admin(), new SnapshotApprovalService
            .ApprovalRequest("pw", TOURNAMENT_NAME, SnapshotApprovalService.ACKNOWLEDGMENT_REV)))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ถูกถอนแล้ว");
    }

    @Test
    @DisplayName("private history survives retraction — the audit trail outlives the public object")
    void privateHistorySurvives() {
        publishOnce();

        publisher.retract(tournamentId, "ittest");

        assertThat(storage.getPrivate(SnapshotKey.privatePayload(tournamentId, 1)))
            .as("§7.1: history was never publicly reachable, so withdrawal does not touch it")
            .isPresent();
        assertThat(storage.getPrivate(SnapshotKey.privateManifest(tournamentId, 1))).isPresent();
        assertThat(state.history(tournamentId)).singleElement()
            .satisfies(publication -> assertThat(publication.status()).isEqualTo("PROMOTED"));
    }

    // ================================================================== ④ isolation

    @Test
    @DisplayName("retracting one tournament does not touch another's public object")
    void retractionIsScopedToItsTournament() {
        publishOnce();

        UUID neighbour = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            neighbour, "เพื่อนบ้าน", "phase-f-n-" + neighbour.toString().substring(0, 8));
        UUID keep = tournamentId;
        tournamentId = neighbour;
        publishOnce();
        String neighbourKey = state.status(neighbour).objectKey();
        byte[] neighbourBytes = storage.publicObject(neighbourKey).orElseThrow().clone();
        tournamentId = keep;

        publisher.retract(tournamentId, "ittest");

        assertThat(storage.publicObject(neighbourKey)).contains(neighbourBytes);
        assertThat(state.status(neighbour).state()).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(jdbc.queryForObject(
            "SELECT retracted_at FROM tournaments WHERE id = ?", java.sql.Timestamp.class, neighbour))
            .isNull();
    }

    // ================================================================== authorization (§4.2, I9)

    @Test
    @DisplayName("retraction needs no approval, no password and no finished cards")
    void retractionIsUnconditional() {
        publishOnce();
        // Revoke the approval and leave a card unfinished: publishing would now be refused twice over.
        approvals.revoke(tournamentId, admin());
        card();

        assertThatCode(() -> publisher.retract(tournamentId, "ittest")).doesNotThrowAnyException();

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.RETRACTED);
        assertThat(storage.publicObjects()).isEmpty();
    }

    @Test
    @DisplayName("a tournament that never published has nothing to retract")
    void refusesWhenNothingWasEverPublished() {
        finishedCard();

        assertThatThrownBy(() -> publisher.retract(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ยังไม่เคยเผยแพร่");

        assertThat(state.status(tournamentId).state())
            .as("RETRACTED here would permanently block a tournament that never published")
            .isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
    }

    @Test
    @DisplayName("retraction is refused while a publication is in flight")
    void refusesWhilePublishing() {
        publishOnce();
        approveDirectly();
        state.beginPublishing(tournamentId);

        assertThatThrownBy(() -> publisher.retract(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("กำลังเผยแพร่อยู่");

        assertThat(storage.publicObjects())
            .as("deleting under a running promotion would race it")
            .isNotEmpty();
    }

    /** A stranded object from a promote-that-never-committed must still be withdrawable. */
    @Test
    @DisplayName("a PUBLISH_FAILED tournament with a live object can still be retracted")
    void retractsAfterAFailedPublish() {
        finishedCard();
        approveDirectly();
        storage.fail(FakeSnapshotStorage.Fault.FETCH_FAILS, state.status(tournamentId).objectKey());
        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(IllegalStateException.class);
        storage.clearFaults();
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);
        assertThat(storage.publicObjects()).as("the object is public despite the failure").isNotEmpty();

        publisher.retract(tournamentId, "ittest");

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.RETRACTED);
        assertThat(storage.publicObjects()).isEmpty();
    }

    // ================================================================== idempotency and retry

    @Test
    @DisplayName("retracting twice is safe and reports the surface still gone")
    void retractionIsIdempotent() {
        publishOnce();
        publisher.retract(tournamentId, "ittest");
        String rowAfterFirst = retractionRow();

        PublicSnapshotPublisher.Outcome second = publisher.retract(tournamentId, "someone-else");

        assertThat(second.ok()).isTrue();
        assertThat(storage.publicObjects()).isEmpty();
        assertThat(retractionRow())
            .as("the first withdrawal's attribution is the one that stands")
            .isEqualTo(rowAfterFirst);
    }

    @Test
    @DisplayName("a delete that fails changes nothing and leaves the retraction retryable")
    void failedDeleteRewindsTheIntent() {
        publishOnce();
        String objectKey = state.status(tournamentId).objectKey();
        storage.fail(FakeSnapshotStorage.Fault.THROW_ON_DELETE_PUBLIC);

        assertThatThrownBy(() -> publisher.retract(tournamentId, "ittest"))
            .isInstanceOf(IllegalStateException.class);

        Map<String, Object> row = jdbc.queryForMap(
            "SELECT snapshot_state, retracted_by, retracted_at FROM tournaments WHERE id = ?", tournamentId);
        assertThat(row.get("snapshot_state")).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(row.get("retracted_at"))
            .as("nothing was removed, so no retraction is pending and publishing is not blocked")
            .isNull();
        assertThat(row.get("retracted_by")).isNull();
        assertThat(storage.publicObject(objectKey)).isPresent();

        storage.clearFaults();
        assertThatCode(() -> publisher.retract(tournamentId, "ittest")).doesNotThrowAnyException();
        assertThat(storage.publicObjects()).isEmpty();
    }

    /**
     * The failure the plan names for Phase F: the object is deleted and the process dies before the
     * commit. The intent marker is what lets the reconciler tell this apart from a lost object.
     */
    @Test
    @DisplayName("reconcile completes a retraction that was interrupted after the delete")
    void reconcileCompletesAnInterruptedRetraction() {
        publishOnce();
        String objectKey = state.status(tournamentId).objectKey();
        // Exactly the state a crash between the delete and the commit leaves behind.
        state.beginRetraction(tournamentId, "ittest");
        storage.deletePublic(objectKey);
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISHED);

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(tournamentId, "operator");

        assertThat(outcome.ok()).isTrue();
        assertThat(outcome.detail()).contains("interrupted retraction");
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.RETRACTED);
        assertThat(jdbc.queryForObject(
            "SELECT retracted_by FROM tournaments WHERE id = ?", String.class, tournamentId))
            .as("the original actor keeps the attribution, not the operator who reconciled")
            .isEqualTo("ittest");
        assertThat(auditCount("RETRACT_PUBLIC_SNAPSHOT")).isEqualTo(1);
    }

    @Test
    @DisplayName("reconcile refuses to finish a retraction whose delete never happened")
    void reconcileWillNotDeleteOnItsOwnInitiative() {
        publishOnce();
        state.beginRetraction(tournamentId, "ittest");

        PublicSnapshotPublisher.Outcome outcome = publisher.reconcile(tournamentId, "operator");

        assertThat(outcome.ok()).isFalse();
        assertThat(outcome.detail()).contains("run retract again");
        assertThat(storage.publicObjects())
            .as("withdrawing data is an attributable act; a repair job must not do it unprompted")
            .isNotEmpty();
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISHED);
    }

    @Test
    @DisplayName("a pending retraction blocks publication rather than racing it")
    void pendingRetractionBlocksPublish() {
        publishOnce();
        approveDirectly();
        state.beginRetraction(tournamentId, "ittest");

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("มีการถอนการเผยแพร่ค้างอยู่");
    }

    // ================================================================== data safety and G1

    @Test
    @DisplayName("retraction mutates no tournament data")
    void retractionTouchesNoTournamentData() {
        publishOnce();
        Map<String, String> before = tournamentDataDigest();

        publisher.retract(tournamentId, "ittest");

        assertThat(tournamentDataDigest())
            .as("withdrawing a derived public artifact must not alter the source of truth")
            .isEqualTo(before);
    }

    @Test
    @DisplayName("G1: the Excel purge is blocked while published and allowed after retraction")
    void retractionUnblocksTheExcelPurge() {
        publishOnce();
        assertThatThrownBy(() -> excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", TOURNAMENT_NAME), "ittest"))
            .isInstanceOf(ResponseStatusException.class);

        publisher.retract(tournamentId, "ittest");

        // Retraction is the documented escape hatch from G1 — withdraw first, then the live rows may
        // go, because nothing public depends on being able to regenerate them any more.
        assertThatCode(() -> excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", TOURNAMENT_NAME), "ittest"))
            .doesNotThrowAnyException();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM tournaments WHERE id = ?", Integer.class, tournamentId)).isZero();
    }

    // ================================================================== audit (§4.5 step 4)

    @Test
    @DisplayName("retraction writes exactly one RETRACT_PUBLIC_SNAPSHOT row, attributed and detailed")
    void auditsTheWithdrawal() {
        publishOnce();

        publisher.retract(tournamentId, "ittest");

        assertThat(auditCount("RETRACT_PUBLIC_SNAPSHOT")).isEqualTo(1);
        Map<String, Object> entry = jdbc.queryForMap("""
            SELECT actor, new_value FROM audit_logs
            WHERE action = 'RETRACT_PUBLIC_SNAPSHOT' AND new_value LIKE ?
            """, "%" + tournamentId + "%");
        assertThat(entry.get("actor")).isEqualTo("ittest");
        assertThat((String) entry.get("new_value")).contains("version 1").contains("verified 404");
    }

    @Test
    @DisplayName("a refused retraction writes no audit row and no intent")
    void refusedRetractionLeavesNoTrace() {
        finishedCard();

        assertThatThrownBy(() -> publisher.retract(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class);

        assertThat(auditCount("RETRACT_PUBLIC_SNAPSHOT")).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT retracted_at FROM tournaments WHERE id = ?", java.sql.Timestamp.class, tournamentId))
            .isNull();
    }

    // ================================================================== fixtures

    private org.springframework.security.core.Authentication admin() {
        jdbc.update("INSERT INTO staff_accounts (username, password_hash) VALUES ('phase-f-admin', 'x') "
            + "ON CONFLICT (username) DO NOTHING");
        return new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
            "phase-f-admin", "n/a",
            List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_ADMIN")));
    }

    /** An approval row written straight in, the way the Phase B tests do — approval is not the subject here. */
    private void approveDirectly() {
        jdbc.update("""
            INSERT INTO public_snapshot_approvals
                (tournament_id, approved_by, approved_at, acknowledgment_rev, content_fingerprint, expires_at)
            VALUES (?, 'ittest', clock_timestamp(), ?, ?, now() + interval '7 days')
            """, tournamentId, SnapshotApprovalService.ACKNOWLEDGMENT_REV, approvals.fingerprint(tournamentId));
    }

    private void publishOnce() {
        finishedCard();
        approveDirectly();
        publisher.publish(tournamentId, "ittest");
    }

    private void changeCardsAndPublishAgain() {
        finishedCard();
        approveDirectly();
        publisher.publish(tournamentId, "ittest");
    }

    private String retractionRow() {
        return jdbc.queryForObject("""
            SELECT coalesce(retracted_by, '-') || '|' || coalesce(retracted_at::text, '-')
            FROM tournaments WHERE id = ?
            """, String.class, tournamentId);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject(
            "SELECT count(*) FROM audit_logs WHERE action = ? AND new_value LIKE ?",
            Integer.class, action, "%" + tournamentId + "%");
    }

    /** A content digest of every table retraction must not touch. */
    private Map<String, String> tournamentDataDigest() {
        Map<String, String> digest = new LinkedHashMap<>();
        for (String table : List.of("tournament_cards", "players", "matches", "standings", "games",
            "pairing_snapshots", "final_pairings", "final_game_results")) {
            digest.put(table, jdbc.queryForObject(
                "SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM "
                    + "(SELECT md5(t::text) AS h FROM \"" + table + "\" t) row_digests", String.class));
        }
        digest.put("tournaments", jdbc.queryForObject("""
            SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM (
              SELECT md5(ROW(id, name, access_token, status, created_by, created_at, version)::text) AS h
              FROM tournaments) row_digests
            """, String.class));
        return digest;
    }

    private UUID card() {
        List<Integer> maxDiffs = new ArrayList<>(List.of(500, 500, 500));
        return service.create(new CardDtos.CreateCardRequest(tournamentId, "PhaseF-" + UUID.randomUUID(),
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
