package com.ctwe.tournament.application.systemlifecycle;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotState;
import com.ctwe.tournament.application.publicsnapshot.SnapshotKey;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
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
 * Phase G — the shutdown gate — against a real PostgreSQL.
 *
 * <p>The question this service answers decides whether a real event's results stay reachable. Get it
 * wrong in one direction and the backend never switches off; wrong in the other and it switches off
 * while a tournament is still being played, or while finished results exist that nobody outside the
 * backend can read. The second mistake is the expensive one, so nearly every test below is about
 * something that must <b>keep the gate shut</b>.
 *
 * <p>These tests share the database with every other tournament in it, so each one asserts on
 * <em>this</em> tournament's contribution to the counts rather than on absolute totals — which is
 * also the honest way to test a global gate.
 *
 * <p>Same harness as the other database tests: localhost:5432, one rolled-back transaction per test,
 * enabled only when the database password is in the environment.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class ShutdownReadinessDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    @Autowired TournamentCardService service;
    @Autowired ShutdownReadinessService readiness;
    @Autowired JdbcTemplate jdbc;

    private UUID tournamentId;
    private String accessToken;

    @BeforeEach
    void createTournament() {
        // Every pre-existing tournament in the shared database is settled first, so this test's own
        // tournament is the only thing that can move the gate. Rolled back with the transaction.
        jdbc.update("UPDATE tournaments SET shelved_at = now(), shelved_by = 'test-baseline' "
            + "WHERE shelved_at IS NULL AND snapshot_state <> 'PUBLISHED'");
        jdbc.update("UPDATE tournament_cards SET status = 'CLOSED' WHERE status NOT IN ('FINISHED', 'CLOSED')");

        tournamentId = UUID.randomUUID();
        accessToken = "phase-g-" + tournamentId.toString().substring(0, 8);
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, "CTWE Phase G ทดสอบ", accessToken);
    }

    // ================================================================== the gate stays shut

    @Test
    @DisplayName("a tournament that is neither published nor shelved keeps the gate shut")
    void unsettledTournamentBlocksShutdown() {
        finishedCard();

        ShutdownReadinessService.Readiness result = readiness.readiness();

        assertThat(result.activeTournamentCount()).isEqualTo(1);
        assertThat(result.readyToStop()).isFalse();
        assertThat(result.unpublishedFinished()).extracting(ShutdownReadinessService.TournamentRef::tournamentId)
            .containsExactly(tournamentId);
    }

    @Test
    @DisplayName("a tournament with a card still in play keeps the gate shut")
    void cardInPlayBlocksShutdown() {
        card();   // left in registration

        ShutdownReadinessService.Readiness result = readiness.readiness();

        assertThat(result.activeTournamentCount()).isEqualTo(1);
        assertThat(result.unpublishedFinished())
            .as("it is not finished, so it belongs in the count rather than in this list")
            .isEmpty();
    }

    /**
     * §19.1's second clause, and the reason it exists: "even a tournament wrongly marked settled
     * counts as active if any of its cards is still in play". Belt and braces — a mis-marked
     * tournament must not be able to authorize a shutdown mid-event.
     */
    @Test
    @DisplayName("cards in play outrank a settled marking, whether shelved or published")
    void cardsInPlayOutrankSettledMarkings() {
        card();
        readiness.shelve(tournamentId, "ittest");

        assertThat(readiness.readiness().activeTournamentCount())
            .as("shelving records intent; a card in play is a fact about right now")
            .isEqualTo(1);

        jdbc.update("UPDATE tournaments SET snapshot_state = 'PUBLISHED', snapshot_version = 1, "
            + "snapshot_checksum = 'sha256-x' WHERE id = ?", tournamentId);

        assertThat(readiness.readiness().activeTournamentCount())
            .as("even PUBLISHED does not settle a tournament that is still being played")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("a RETRACTED tournament keeps the gate shut until it is explicitly shelved")
    void retractedBlocksUntilShelved() {
        finishedCard();
        jdbc.update("UPDATE tournaments SET snapshot_state = 'RETRACTED' WHERE id = ?", tournamentId);

        assertThat(readiness.readiness().activeTournamentCount())
            .as("withdrawn results are not public; someone must decide that is acceptable")
            .isEqualTo(1);

        readiness.shelve(tournamentId, "ittest");

        assertThat(readiness.readiness().activeTournamentCount()).isZero();
    }

    @Test
    @DisplayName("a PUBLISH_FAILED tournament keeps the gate shut")
    void publishFailedBlocksShutdown() {
        finishedCard();
        jdbc.update("UPDATE tournaments SET snapshot_state = 'PUBLISH_FAILED' WHERE id = ?", tournamentId);

        assertThat(readiness.readiness().activeTournamentCount()).isEqualTo(1);
    }

    // ================================================================== the gate opens

    @Test
    @DisplayName("a published tournament settles, and is listed for external verification")
    void publishedTournamentSettles() {
        finishedCard();
        publish(1, "sha256-abc");

        ShutdownReadinessService.Readiness result = readiness.readiness();

        assertThat(result.activeTournamentCount()).isZero();
        assertThat(result.readyToStop()).isTrue();
        assertThat(result.publishedSnapshots())
            .filteredOn(snapshot -> snapshot.tournamentId().equals(tournamentId))
            .singleElement()
            .satisfies(snapshot -> {
                assertThat(snapshot.h())
                    .as("the workflow builds https://{origin}/s/{h}.json from this, per §19.3")
                    .isEqualTo(SnapshotKey.of(accessToken));
                assertThat(snapshot.version()).isEqualTo(1);
                assertThat(snapshot.sha()).isEqualTo("sha256-abc");
            });
    }

    @Test
    @DisplayName("shelving settles a finished tournament that will never be published")
    void shelvingSettlesAnUnpublishedTournament() {
        finishedCard();
        assertThat(readiness.readiness().activeTournamentCount()).isEqualTo(1);

        readiness.shelve(tournamentId, "ittest");

        ShutdownReadinessService.Readiness result = readiness.readiness();
        assertThat(result.activeTournamentCount()).isZero();
        assertThat(result.unpublishedFinished()).isEmpty();
        assertThat(result.shelved()).extracting(ShutdownReadinessService.TournamentRef::tournamentId)
            .contains(tournamentId);
        assertThat(result.publishedSnapshots())
            .as("shelving publishes nothing — there is no object to verify")
            .noneMatch(snapshot -> snapshot.tournamentId().equals(tournamentId));
    }

    @Test
    @DisplayName("unshelving puts the tournament back in front of the gate")
    void unshelvingRestoresTheBlock() {
        finishedCard();
        readiness.shelve(tournamentId, "ittest");
        assertThat(readiness.readiness().activeTournamentCount()).isZero();

        readiness.unshelve(tournamentId, "ittest");

        assertThat(readiness.readiness().activeTournamentCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT shelved_by FROM tournaments WHERE id = ?", String.class, tournamentId)).isNull();
    }

    // ================================================================== shelving rules

    @Test
    @DisplayName("a published tournament cannot be shelved — it is already settled")
    void refusesToShelveAPublishedTournament() {
        finishedCard();
        publish(1, "sha256-abc");

        assertThatThrownBy(() -> readiness.shelve(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        assertThat(jdbc.queryForObject(
            "SELECT shelved_at FROM tournaments WHERE id = ?", java.sql.Timestamp.class, tournamentId))
            .isNull();
    }

    @Test
    @DisplayName("shelving is idempotent and keeps the first decision's attribution")
    void shelvingIsIdempotent() {
        finishedCard();
        readiness.shelve(tournamentId, "first-admin");
        String shelvedAt = shelvedAtText();

        readiness.shelve(tournamentId, "second-admin");

        assertThat(jdbc.queryForObject(
            "SELECT shelved_by FROM tournaments WHERE id = ?", String.class, tournamentId))
            .isEqualTo("first-admin");
        assertThat(shelvedAtText()).isEqualTo(shelvedAt);
        assertThat(auditCount("SHELVE_TOURNAMENT"))
            .as("a repeat decision is not a new decision")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("unshelving something that was never shelved is a no-op, not an error")
    void unshelvingIsIdempotent() {
        finishedCard();

        assertThatCode(() -> readiness.unshelve(tournamentId, "ittest")).doesNotThrowAnyException();

        assertThat(auditCount("UNSHELVE_TOURNAMENT")).isZero();
    }

    @Test
    @DisplayName("shelving an unknown tournament is a 404")
    void shelvingAnUnknownTournament() {
        assertThatThrownBy(() -> readiness.shelve(UUID.randomUUID(), "ittest"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
    }

    // ================================================================== isolation and safety

    @Test
    @DisplayName("shelving one tournament does not settle another")
    void shelvingIsScopedToItsTournament() {
        finishedCard();
        UUID neighbour = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            neighbour, "เพื่อนบ้าน", "phase-g-n-" + neighbour.toString().substring(0, 8));

        readiness.shelve(tournamentId, "ittest");

        assertThat(readiness.readiness().activeTournamentCount())
            .as("the neighbour is still unsettled and still blocks")
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT shelved_at FROM tournaments WHERE id = ?", java.sql.Timestamp.class, neighbour))
            .isNull();
    }

    @Test
    @DisplayName("two blockers are both reported, and clearing one is not enough")
    void everyBlockerMustBeCleared() {
        finishedCard();
        UUID neighbour = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            neighbour, "เพื่อนบ้าน", "phase-g-n2-" + neighbour.toString().substring(0, 8));

        assertThat(readiness.readiness().activeTournamentCount()).isEqualTo(2);

        readiness.shelve(tournamentId, "ittest");
        assertThat(readiness.readiness().activeTournamentCount()).isEqualTo(1);

        readiness.shelve(neighbour, "ittest");
        assertThat(readiness.readiness().activeTournamentCount()).isZero();
    }

    @Test
    @DisplayName("readiness and shelving mutate no tournament card or game data")
    void phaseGTouchesNoTournamentData() {
        finishedCard();
        Map<String, String> before = tournamentDataDigest();

        readiness.readiness();
        readiness.shelve(tournamentId, "ittest");
        readiness.unshelve(tournamentId, "ittest");
        readiness.readiness();

        assertThat(tournamentDataDigest())
            .as("the shutdown gate observes the tournament; it never plays it")
            .isEqualTo(before);
    }

    @Test
    @DisplayName("shelving cannot publish, unpublish, or resurrect anything")
    void shelvingNeverTouchesTheSnapshotSurface() {
        finishedCard();
        jdbc.update("UPDATE tournaments SET snapshot_state = 'RETRACTED', snapshot_version = 2, "
            + "snapshot_checksum = 'sha256-old', retracted_by = 'someone', retracted_at = now() "
            + "WHERE id = ?", tournamentId);
        String snapshotColumns = snapshotColumnText();

        readiness.shelve(tournamentId, "ittest");
        readiness.unshelve(tournamentId, "ittest");

        assertThat(snapshotColumnText())
            .as("Phase F's withdrawal must survive Phase G untouched")
            .isEqualTo(snapshotColumns);
        assertThat(readiness.readiness().publishedSnapshots())
            .noneMatch(snapshot -> snapshot.tournamentId().equals(tournamentId));
    }

    // ================================================================== audit

    @Test
    @DisplayName("shelving and unshelving each write one attributed audit row")
    void auditsBothDecisions() {
        finishedCard();

        readiness.shelve(tournamentId, "ittest");
        assertThat(auditCount("SHELVE_TOURNAMENT")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT actor FROM audit_logs WHERE action = 'SHELVE_TOURNAMENT' AND new_value LIKE ?
            """, String.class, "%" + tournamentId + "%")).isEqualTo("ittest");

        readiness.unshelve(tournamentId, "ittest");
        assertThat(auditCount("UNSHELVE_TOURNAMENT")).isEqualTo(1);
    }

    @Test
    @DisplayName("a refused shelve writes no audit row and no flag")
    void refusedShelveLeavesNoTrace() {
        finishedCard();
        publish(1, "sha256-abc");

        assertThatThrownBy(() -> readiness.shelve(tournamentId, "ittest"))
            .isInstanceOf(ResponseStatusException.class);

        assertThat(auditCount("SHELVE_TOURNAMENT")).isZero();
    }

    // ================================================================== fixtures

    private void publish(long version, String checksum) {
        jdbc.update("""
            UPDATE tournaments SET snapshot_state = ?, snapshot_version = ?, snapshot_checksum = ?,
                   published_at = now() WHERE id = ?
            """, PublicSnapshotState.PUBLISHED, version, checksum, tournamentId);
    }

    private String shelvedAtText() {
        return jdbc.queryForObject(
            "SELECT coalesce(shelved_at::text, '-') FROM tournaments WHERE id = ?", String.class, tournamentId);
    }

    private String snapshotColumnText() {
        return jdbc.queryForObject("""
            SELECT snapshot_state || '|' || snapshot_version || '|' || coalesce(snapshot_checksum, '-')
                 || '|' || coalesce(retracted_by, '-') || '|' || coalesce(retracted_at::text, '-')
            FROM tournaments WHERE id = ?
            """, String.class, tournamentId);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject(
            "SELECT count(*) FROM audit_logs WHERE action = ? AND new_value LIKE ?",
            Integer.class, action, "%" + tournamentId + "%");
    }

    private Map<String, String> tournamentDataDigest() {
        Map<String, String> digest = new LinkedHashMap<>();
        for (String table : List.of("tournament_cards", "players", "matches", "standings", "games",
            "pairing_snapshots", "final_pairings", "final_game_results")) {
            digest.put(table, jdbc.queryForObject(
                "SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM "
                    + "(SELECT md5(t::text) AS h FROM \"" + table + "\" t) row_digests", String.class));
        }
        return digest;
    }

    private UUID card() {
        List<Integer> maxDiffs = new ArrayList<>(List.of(500, 500, 500));
        return service.create(new CardDtos.CreateCardRequest(tournamentId, "PhaseG-" + UUID.randomUUID(),
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
