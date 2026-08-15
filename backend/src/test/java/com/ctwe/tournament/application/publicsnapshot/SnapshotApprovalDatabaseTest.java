package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.infrastructure.storage.SnapshotStorageProperties;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
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
 * Phase E — publication approval — against a real PostgreSQL.
 *
 * <p>The property under test is one sentence: <b>nothing reaches the publication pipeline unless a
 * named human approved exactly this content, recently, and has not taken it back.</b> Every test
 * below is one way that could fail to hold.
 *
 * <p>Real SQL matters here more than usual. Approval validity is four conditions evaluated against
 * stored rows — existence, revocation, expiry, and a fingerprint recomputed from live card data —
 * and three of the four are only meaningful against a database that actually holds the rows and
 * actually moves the clock. R2 stays a fake ({@link FakeSnapshotStorage}); everything up to that
 * boundary is real.
 *
 * <p>Same harness as the other database tests: localhost:5432, one rolled-back transaction per test,
 * enabled only when the database password is in the environment.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class SnapshotApprovalDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final SnapshotStorageProperties PROPERTIES = new SnapshotStorageProperties(
        "https://account.r2.cloudflarestorage.com", "key", "secret", "ctwe-snapshots",
        "ctwe-snapshots-public", "https://snapshot.ct-we.com", "zone", "token");

    private static final String PASSWORD = "correct-horse-battery";
    private static final String TOURNAMENT_NAME = "CTWE Phase E ทดสอบ";

    @Autowired TournamentCardService service;
    @Autowired PublicSnapshotBuilder builder;
    @Autowired PublicSnapshotState state;
    @Autowired SnapshotApprovalService approvals;
    @Autowired PasswordEncoder passwordEncoder;
    @Autowired JdbcTemplate jdbc;

    private final FakeSnapshotStorage storage = new FakeSnapshotStorage();
    private PublicSnapshotPublisher publisher;
    private UUID tournamentId;

    /** ADMIN — unrestricted by §4.2. */
    private Authentication admin;
    /** DIRECTOR assigned to this tournament. */
    private Authentication director;
    /** DIRECTOR assigned to a DIFFERENT tournament — the §4.2 isolation case. */
    private Authentication otherDirector;
    /** STAFF assigned to this tournament: scoped in, but approval is not theirs to give. */
    private Authentication staff;

    @BeforeEach
    void createTournament() {
        publisher = new PublicSnapshotPublisher(builder, state, storage, storage, storage, PROPERTIES);
        tournamentId = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, TOURNAMENT_NAME, "phase-e-" + tournamentId.toString().substring(0, 8));

        admin = principal("phase-e-admin", "ROLE_ADMIN");
        director = principal("phase-e-director", "ROLE_DIRECTOR");
        otherDirector = principal("phase-e-other", "ROLE_DIRECTOR");
        staff = principal("phase-e-staff", "ROLE_STAFF");

        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?)",
            tournamentId, "phase-e-director");
        jdbc.update("INSERT INTO staff_tournament_access (username, tournament_id) VALUES (?, ?)",
            "phase-e-staff", tournamentId);

        // The other director runs a different tournament entirely.
        UUID otherTournament = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            otherTournament, "รายการอื่น", "phase-e-other-" + otherTournament.toString().substring(0, 8));
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?)",
            otherTournament, "phase-e-other");
    }

    // ================================================================== ① publication needs approval

    @Test
    @DisplayName("an unapproved tournament cannot publish, and nothing about it moves")
    void unapprovedCannotPublish() {
        finishedCard();
        String cardsBefore = cardRowDigest();

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT))
            .hasMessageContaining("ต้องได้รับการอนุมัติก่อนเผยแพร่");

        PublicSnapshotState.Status status = state.status(tournamentId);
        assertThat(status.state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
        assertThat(status.version()).isZero();
        assertThat(status.checksum()).isNull();
        assertThat(state.history(tournamentId)).as("not even a version number is burned").isEmpty();
        assertThat(storage.publicObjects()).isEmpty();
        assertThat(cardRowDigest()).isEqualTo(cardsBefore);
    }

    @Test
    @DisplayName("an approved tournament reaches the pipeline and publishes")
    void approvedTournamentPublishes() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());

        PublicSnapshotPublisher.Outcome outcome = publisher.publish(tournamentId, "phase-e-admin");

        assertThat(outcome.ok()).isTrue();
        PublicSnapshotState.Status status = state.status(tournamentId);
        assertThat(status.state()).isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(status.version()).isEqualTo(1);
        assertThat(storage.publicObject(status.objectKey())).isPresent();
    }

    @Test
    @DisplayName("a revoked approval no longer authorizes publication")
    void revokedApprovalCannotPublish() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());
        approvals.revoke(tournamentId, admin);

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ถูกเพิกถอนแล้ว");

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
        assertThat(storage.publicObjects()).isEmpty();
    }

    @Test
    @DisplayName("an expired approval no longer authorizes publication")
    void expiredApprovalCannotPublish() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());
        // Age the record past its window rather than waiting seven days for it.
        jdbc.update("UPDATE public_snapshot_approvals SET expires_at = now() - interval '1 minute' "
            + "WHERE tournament_id = ?", tournamentId);

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("หมดอายุแล้ว");

        assertThat(storage.publicObjects()).isEmpty();
    }

    /**
     * The subtle one, and the reason the fingerprint exists: an operator approves, then corrects a
     * result, then publishes. Without this check the published artifact would contain data the
     * approver never saw and never consented to.
     */
    @Test
    @DisplayName("content that changed after approval cannot be published under that approval")
    void changedContentCannotPublish() {
        UUID cardId = finishedCard();
        approvals.approve(tournamentId, admin, request());

        jdbc.update("UPDATE tournament_cards SET public_version = public_version + 1 WHERE id = ?", cardId);

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ข้อมูลการ์ดเปลี่ยนแปลงหลังได้รับอนุมัติ");

        assertThat(storage.publicObjects()).isEmpty();
        // Re-approving the NEW content is what unblocks it — the record follows the data.
        approvals.approve(tournamentId, admin, request());
        assertThat(publisher.publish(tournamentId, "phase-e-admin").ok()).isTrue();
    }

    @Test
    @DisplayName("adding a card after approval also invalidates it")
    void addedCardInvalidatesApproval() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());
        finishedCard();

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ข้อมูลการ์ดเปลี่ยนแปลงหลังได้รับอนุมัติ");
    }

    @Test
    @DisplayName("one tournament's approval never authorizes another's publication")
    void approvalIsPerTournament() {
        finishedCard();
        UUID neighbour = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            neighbour, "เพื่อนบ้าน", "phase-e-n-" + neighbour.toString().substring(0, 8));
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?)",
            neighbour, "phase-e-director");
        approvals.approve(neighbour, admin, new SnapshotApprovalService.ApprovalRequest(
            PASSWORD, "เพื่อนบ้าน", SnapshotApprovalService.ACKNOWLEDGMENT_REV));

        assertThatThrownBy(() -> publisher.publish(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ยังไม่มีการอนุมัติ");
    }

    @Test
    @DisplayName("publishing does not consume the approval — a republish of identical content works")
    void approvalSurvivesPublication() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());

        assertThat(publisher.publish(tournamentId, "phase-e-admin").version()).isEqualTo(1);
        assertThat(publisher.publish(tournamentId, "phase-e-admin").version())
            .as("the approver saw exactly this content; republishing it needs no new consent")
            .isEqualTo(2);
    }

    // ================================================================== ② the acknowledgment

    @Test
    @DisplayName("the acknowledgment revision the approver was shown is recorded on the row")
    void recordsTheAcknowledgmentRevision() {
        finishedCard();

        approvals.approve(tournamentId, admin, request());

        assertThat(jdbc.queryForObject(
            "SELECT acknowledgment_rev FROM public_snapshot_approvals WHERE tournament_id = ?",
            Short.class, tournamentId))
            .isEqualTo(SnapshotApprovalService.ACKNOWLEDGMENT_REV);
        assertThat(approvals.status(tournamentId).acknowledgmentRev())
            .isEqualTo(SnapshotApprovalService.ACKNOWLEDGMENT_REV);
    }

    @Test
    @DisplayName("a client showing an older acknowledgment revision is refused")
    void refusesAStaleAcknowledgmentRevision() {
        finishedCard();

        assertThatThrownBy(() -> approvals.approve(tournamentId, admin,
            new SnapshotApprovalService.ApprovalRequest(PASSWORD, TOURNAMENT_NAME, (short) 0)))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ข้อความยินยอมมีการปรับปรุง");

        assertThat(approvalRowCount()).isZero();
    }

    @Test
    @DisplayName("approval requires the operator's current password")
    void requiresTheCurrentPassword() {
        finishedCard();

        assertThatThrownBy(() -> approvals.approve(tournamentId, admin,
            new SnapshotApprovalService.ApprovalRequest("not-my-password", TOURNAMENT_NAME,
                SnapshotApprovalService.ACKNOWLEDGMENT_REV)))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED));

        assertThat(approvalRowCount()).isZero();
    }

    @Test
    @DisplayName("approval requires the tournament's name to be retyped exactly")
    void requiresTheTypedName() {
        finishedCard();

        assertThatThrownBy(() -> approvals.approve(tournamentId, admin,
            new SnapshotApprovalService.ApprovalRequest(PASSWORD, "รายการอื่น",
                SnapshotApprovalService.ACKNOWLEDGMENT_REV)))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST));

        assertThat(approvalRowCount()).isZero();
    }

    // ================================================================== ③ authorization (§4.2)

    @Test
    @DisplayName("a director may approve the tournament they run")
    void directorOfTheTournamentMayApprove() {
        finishedCard();

        assertThatCode(() -> approvals.approve(tournamentId, director, request()))
            .doesNotThrowAnyException();

        assertThat(approvals.status(tournamentId).approvedBy()).isEqualTo("phase-e-director");
    }

    /**
     * Acceptance ③. Paired deliberately with {@link #directorOfTheTournamentMayApprove} — a refusal
     * test alone would still pass if directors could never approve anything at all.
     */
    @Test
    @DisplayName("a director cannot approve another director's tournament")
    void directorCannotApproveAnotherDirectorsTournament() {
        finishedCard();

        assertThatThrownBy(() -> approvals.approve(tournamentId, otherDirector, request()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN));

        assertThat(approvalRowCount()).isZero();
    }

    @Test
    @DisplayName("a director cannot revoke another director's tournament's approval either")
    void directorCannotRevokeAnotherDirectorsApproval() {
        finishedCard();
        approvals.approve(tournamentId, director, request());

        assertThatThrownBy(() -> approvals.revoke(tournamentId, otherDirector))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN));

        assertThat(approvals.status(tournamentId).valid()).isTrue();
    }

    @Test
    @DisplayName("staff scoped to the tournament still cannot approve it")
    void staffCannotApprove() {
        finishedCard();

        assertThatThrownBy(() -> approvals.approve(tournamentId, staff, request()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN));

        assertThat(approvalRowCount()).isZero();
    }

    @Test
    @DisplayName("an admin may approve any tournament")
    void adminMayApproveAnything() {
        finishedCard();

        assertThatCode(() -> approvals.approve(tournamentId, admin, request()))
            .doesNotThrowAnyException();
    }

    /** Authorization is checked before the password, so a refusal cannot confirm a guess. */
    @Test
    @DisplayName("an unauthorized approver is refused without their password being consulted")
    void authorizationPrecedesReauthentication() {
        finishedCard();

        assertThatThrownBy(() -> approvals.approve(tournamentId, otherDirector,
            new SnapshotApprovalService.ApprovalRequest(PASSWORD, TOURNAMENT_NAME,
                SnapshotApprovalService.ACKNOWLEDGMENT_REV)))
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .as("FORBIDDEN, not UNAUTHORIZED — the correct password did not change the answer")
                .isEqualTo(HttpStatus.FORBIDDEN));
    }

    // ================================================================== state machine

    @Test
    @DisplayName("approving moves NOT_PUBLISHED to APPROVED, and revoking moves it back")
    void stateFollowsTheApproval() {
        finishedCard();
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);

        approvals.approve(tournamentId, admin, request());
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.APPROVED);

        approvals.revoke(tournamentId, admin);
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.NOT_PUBLISHED);
    }

    @Test
    @DisplayName("approving a PUBLISHED tournament leaves the pointer and its state alone")
    void reapprovingPublishedKeepsThePointer() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());
        publisher.publish(tournamentId, "phase-e-admin");
        PublicSnapshotState.Status before = state.status(tournamentId);

        approvals.approve(tournamentId, admin, request());

        PublicSnapshotState.Status after = state.status(tournamentId);
        assertThat(after.state())
            .as("something IS public; saying APPROVED would misdescribe it")
            .isEqualTo(PublicSnapshotState.PUBLISHED);
        assertThat(after.version()).isEqualTo(before.version());
        assertThat(after.checksum()).isEqualTo(before.checksum());
    }

    @Test
    @DisplayName("a PUBLISH_FAILED tournament can be approved back into APPROVED")
    void approvingAfterAFailure() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());
        storage.fail(FakeSnapshotStorage.Fault.FETCH_404);
        assertThatThrownBy(() -> publisher.publish(tournamentId, "phase-e-admin"))
            .isInstanceOf(IllegalStateException.class);
        storage.clearFaults();
        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.PUBLISH_FAILED);

        approvals.approve(tournamentId, admin, request());

        assertThat(state.status(tournamentId).state()).isEqualTo(PublicSnapshotState.APPROVED);
    }

    @Test
    @DisplayName("approval is refused while a publication is in flight")
    void refusesWhilePublishing() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());
        state.beginPublishing(tournamentId);

        assertThatThrownBy(() -> approvals.approve(tournamentId, admin, request()))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("กำลังเผยแพร่อยู่");

        assertThat(state.status(tournamentId).state())
            .as("PUBLISHING is the pipeline's exclusion token; approval must not overwrite it")
            .isEqualTo(PublicSnapshotState.PUBLISHING);
    }

    @Test
    @DisplayName("approval is refused for a retracted tournament, which Phase B would never publish")
    void refusesRetracted() {
        finishedCard();
        jdbc.update("UPDATE tournaments SET snapshot_state = 'RETRACTED' WHERE id = ?", tournamentId);

        assertThatThrownBy(() -> approvals.approve(tournamentId, admin, request()))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("ถูกถอนแล้ว");

        assertThat(approvalRowCount()).isZero();
    }

    // ================================================================== audit (§5.2)

    @Test
    @DisplayName("approving and revoking each write exactly one audit row, under the documented action")
    void auditsBothActions() {
        finishedCard();

        approvals.approve(tournamentId, admin, request());
        assertThat(auditCount("APPROVE_PUBLIC_SNAPSHOT")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT new_value FROM audit_logs WHERE action = 'APPROVE_PUBLIC_SNAPSHOT' AND new_value LIKE ?
            """, String.class, "%" + tournamentId + "%"))
            .contains("acknowledgment rev " + SnapshotApprovalService.ACKNOWLEDGMENT_REV)
            .contains("fingerprint");
        assertThat(jdbc.queryForObject("""
            SELECT actor FROM audit_logs WHERE action = 'APPROVE_PUBLIC_SNAPSHOT' AND new_value LIKE ?
            """, String.class, "%" + tournamentId + "%")).isEqualTo("phase-e-admin");

        approvals.revoke(tournamentId, admin);
        assertThat(auditCount("REVOKE_PUBLIC_SNAPSHOT")).isEqualTo(1);
    }

    @Test
    @DisplayName("a refused approval writes no audit row and no approval row")
    void refusedApprovalLeavesNoTrace() {
        finishedCard();
        Map<String, String> before = tournamentDataDigest();

        assertThatThrownBy(() -> approvals.approve(tournamentId, staff, request()))
            .isInstanceOf(ResponseStatusException.class);

        assertThat(approvalRowCount()).isZero();
        assertThat(auditCount("APPROVE_PUBLIC_SNAPSHOT")).isZero();
        assertThat(tournamentDataDigest())
            .as("a refused approval must not touch tournament data or the snapshot columns")
            .isEqualTo(before);
    }

    @Test
    @DisplayName("a successful approval touches no tournament data either")
    void approvalIsReadOnlyOverTournamentData() {
        finishedCard();
        String cardsBefore = cardRowDigest();

        approvals.approve(tournamentId, admin, request());

        assertThat(cardRowDigest())
            .as("approval reads the cards to fingerprint them; it never writes them")
            .isEqualTo(cardsBefore);
    }

    // ================================================================== the fingerprint

    @Test
    @DisplayName("the fingerprint is stable for unchanged data and moves with public_version")
    void fingerprintTracksPublicVersion() {
        UUID cardId = finishedCard();
        String first = approvals.fingerprint(tournamentId);

        assertThat(approvals.fingerprint(tournamentId))
            .as("same data, same digest — otherwise every approval would self-invalidate")
            .isEqualTo(first);
        assertThat(first).hasSize(64).matches("[0-9a-f]+");

        jdbc.update("UPDATE tournament_cards SET public_version = public_version + 1 WHERE id = ?", cardId);
        assertThat(approvals.fingerprint(tournamentId)).isNotEqualTo(first);
    }

    @Test
    @DisplayName("a change to another tournament's cards does not disturb this fingerprint")
    void fingerprintIsScopedToItsTournament() {
        finishedCard();
        String before = approvals.fingerprint(tournamentId);

        UUID neighbour = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            neighbour, "เพื่อนบ้าน", "phase-e-s-" + neighbour.toString().substring(0, 8));
        jdbc.update("UPDATE tournament_cards SET public_version = public_version + 5 "
            + "WHERE tournament_id <> ?", tournamentId);

        assertThat(approvals.fingerprint(tournamentId)).isEqualTo(before);
    }

    // ================================================================== status projection

    @Test
    @DisplayName("status reports each invalidation reason distinctly")
    void statusExplainsWhy() {
        finishedCard();
        assertThat(approvals.status(tournamentId).valid()).isFalse();
        assertThat(approvals.status(tournamentId).reason()).isEqualTo("ยังไม่มีการอนุมัติ");

        approvals.approve(tournamentId, admin, request());
        assertThat(approvals.status(tournamentId).valid()).isTrue();
        assertThat(approvals.status(tournamentId).reason()).isEqualTo("อนุมัติแล้ว");

        jdbc.update("UPDATE tournament_cards SET public_version = public_version + 1 WHERE tournament_id = ?",
            tournamentId);
        assertThat(approvals.status(tournamentId).valid()).isFalse();
        assertThat(approvals.status(tournamentId).reason()).isEqualTo("ข้อมูลเปลี่ยนหลังได้รับอนุมัติ");

        approvals.approve(tournamentId, admin, request());
        approvals.revoke(tournamentId, admin);
        assertThat(approvals.status(tournamentId).reason()).isEqualTo("ถูกเพิกถอนแล้ว");
    }

    @Test
    @DisplayName("the approval window is the documented seven days")
    void expiresAfterSevenDays() {
        finishedCard();

        approvals.approve(tournamentId, admin, request());

        assertThat(jdbc.queryForObject("""
            SELECT expires_at - approved_at FROM public_snapshot_approvals WHERE tournament_id = ?
            """, String.class, tournamentId)).isEqualTo("7 days");
    }

    @Test
    @DisplayName("revocation keeps the record of who approved what")
    void revocationIsASoftDelete() {
        finishedCard();
        approvals.approve(tournamentId, admin, request());

        approvals.revoke(tournamentId, director);

        Map<String, Object> row = jdbc.queryForMap(
            "SELECT approved_by, revoked_by, revoked_at FROM public_snapshot_approvals WHERE tournament_id = ?",
            tournamentId);
        assertThat(row.get("approved_by")).isEqualTo("phase-e-admin");
        assertThat(row.get("revoked_by")).isEqualTo("phase-e-director");
        assertThat(row.get("revoked_at")).isNotNull();
    }

    @Test
    @DisplayName("revoking when there is nothing to revoke is a 404, not a silent success")
    void revokeWithoutApproval() {
        finishedCard();

        assertThatThrownBy(() -> approvals.revoke(tournamentId, admin))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
    }

    // ================================================================== fixtures

    private SnapshotApprovalService.ApprovalRequest request() {
        return new SnapshotApprovalService.ApprovalRequest(
            PASSWORD, TOURNAMENT_NAME, SnapshotApprovalService.ACKNOWLEDGMENT_REV);
    }

    private Authentication principal(String username, String role) {
        jdbc.update("INSERT INTO staff_accounts (username, password_hash) VALUES (?, ?) "
            + "ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash",
            username, passwordEncoder.encode(PASSWORD));
        return new UsernamePasswordAuthenticationToken(username, "n/a",
            List.of(new SimpleGrantedAuthority(role)));
    }

    private int approvalRowCount() {
        return jdbc.queryForObject(
            "SELECT count(*) FROM public_snapshot_approvals WHERE tournament_id = ?",
            Integer.class, tournamentId);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject(
            "SELECT count(*) FROM audit_logs WHERE action = ? AND new_value LIKE ?",
            Integer.class, action, "%" + tournamentId + "%");
    }

    private String cardRowDigest() {
        return jdbc.queryForObject("""
            SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM
              (SELECT md5(c::text) AS h FROM tournament_cards c WHERE c.tournament_id = ?) row_digests
            """, String.class, tournamentId);
    }

    /** Card rows plus this tournament's snapshot columns — what a refused approval must not disturb. */
    private Map<String, String> tournamentDataDigest() {
        Map<String, String> digest = new LinkedHashMap<>();
        digest.put("cards", cardRowDigest());
        digest.put("snapshot", jdbc.queryForObject("""
            SELECT snapshot_state || '|' || snapshot_version || '|' || coalesce(snapshot_checksum, '-')
            FROM tournaments WHERE id = ?
            """, String.class, tournamentId));
        return digest;
    }

    private UUID finishedCard() {
        List<Integer> maxDiffs = new ArrayList<>(List.of(500, 500, 500));
        UUID cardId = service.create(new CardDtos.CreateCardRequest(tournamentId, "PhaseE-" + UUID.randomUUID(),
            "DIV", 3, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS), maxDiffs,
            "NONE", 0, false, PairingRuleType.RANDOM), "ittest").id();
        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < 6; i++) players.add(new CardDtos.BulkPlayerEntry("First" + i, "Last" + i, "School" + i));
        service.addPlayersBulk(cardId, players, "ittest");
        service.simulate(cardId, "ittest");
        return cardId;
    }
}
