package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real-Postgres integration tests (localhost:5432) — every test runs inside a transaction that is
 * rolled back, so the developer's existing card/players are never touched. Only runs when the DB
 * password is present in the environment.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class RestoreAndPairResultIntegrationTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    @Autowired TournamentCardService service;
    @Autowired JdbcTemplate jdbc;

    private UUID tournamentId() {
        return jdbc.queryForObject("SELECT id FROM tournaments LIMIT 1", UUID.class);
    }

    private UUID createCard(int games, PairingRuleType initial, List<PairingRuleType> edgeRules) {
        List<Integer> maxDiffs = new ArrayList<>();
        for (int i = 0; i < games; i++) maxDiffs.add(500);
        var request = new CardDtos.CreateCardRequest(tournamentId(), "IT-" + UUID.randomUUID(), "DIV",
            games, edgeRules, maxDiffs, "NONE", 0, false, initial);
        return service.create(request, "ittest").id();
    }

    private void addPlayers(UUID cardId, int count) {
        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < count; i++)
            players.add(new CardDtos.BulkPlayerEntry("First" + i, "Last" + i, "School" + (i % 3)));
        service.addPlayersBulk(cardId, players, "ittest");
    }

    private void runGame(UUID cardId) {
        service.generatePairingPreview(cardId, "ittest");
        service.confirmPairingPreview(cardId, "ittest");
        service.autoResults(cardId, "ittest");
        service.reviewResults(cardId, "ittest");
        service.publishResults(cardId, "ittest");
    }

    private int currentGame(UUID cardId) {
        return jdbc.queryForObject("SELECT current_game FROM tournament_cards WHERE id = ?", Integer.class, cardId);
    }

    // ---- Regression guard: the ordinary Swiss pipeline still finishes end to end ----
    @Test
    void ordinarySwissTournamentStillSimulatesToFinished() {
        UUID cardId = createCard(3, PairingRuleType.RANDOM,
            List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(cardId, 6);
        service.simulate(cardId, "ittest");
        String status = jdbc.queryForObject("SELECT status FROM tournament_cards WHERE id = ?", String.class, cardId);
        assertThat(status).isEqualTo("FINISHED");
    }

    // ---- Bug 3: restoring a player writes a real bye+penalty row for each missed published game ----
    @Test
    void restoringAPlayerAppendsAByePenaltyRowForTheMissedPublishedGame() {
        UUID cardId = createCard(4, PairingRuleType.RANDOM,
            List.of(PairingRuleType.SWISS, PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(cardId, 6);
        service.finishRegistration(cardId, "ittest");

        runGame(cardId);                       // game 1 published, currentGame -> 2
        assertThat(currentGame(cardId)).isEqualTo(2);

        // Pick a player that has a game-1 result, then terminate them before game 2.
        int victim = jdbc.queryForObject(
            "SELECT code FROM players WHERE card_id = ? ORDER BY code LIMIT 1", Integer.class, cardId);
        String victimExternal = jdbc.queryForObject(
            "SELECT code_prefix FROM tournament_cards WHERE id = ?", String.class, cardId)
            + String.format("%03d", victim);
        service.terminatePlayers(cardId, List.of(victimExternal), "ittest");

        runGame(cardId);                       // game 2 played without the victim, currentGame -> 3
        assertThat(currentGame(cardId)).isEqualTo(3);
        // While terminated the victim has no game-2 row at all.
        Long before = jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 2 AND (player_one = ? OR player_two = ?)",
            Long.class, cardId, victim, victim);
        assertThat(before).isZero();

        // Restore at game 3 (case A: no pairing yet) with a 100-point per-game penalty.
        service.restorePlayers(cardId, List.of(victimExternal), 100, false, "ittest");

        // A real lone-player PENALTY row is now attached to the missed (published) game 2.
        Long penaltyRows = jdbc.queryForObject("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = 2 AND player_one = ? AND player_two IS NULL
              AND result_type = 'P' AND calculated_diff = 100 AND snapshot_no IS NOT NULL
            """, Long.class, cardId, victim);
        assertThat(penaltyRows).isEqualTo(1L);

        // Standings count that missed game as a loss (recalculated from the real row, no hidden carry).
        Integer losses = jdbc.queryForObject(
            "SELECT losses FROM standings WHERE card_id = ? AND player_code = ?", Integer.class, cardId, victim);
        assertThat(losses).isGreaterThanOrEqualTo(1);
    }

    // ---- Bug 1: publishing the PAIR_RESULT destination confirms the source game as its own snapshot ----
    @Test
    void publishNextConfirmsSourceGameSnapshotAndKeepsItEditable() {
        UUID cardId = createCard(4, PairingRuleType.RANDOM,
            List.of(PairingRuleType.SWISS, PairingRuleType.SWISS, PairingRuleType.PAIR_RESULT));
        addPlayers(cardId, 8);
        service.finishRegistration(cardId, "ittest");

        runGame(cardId); // game 1
        runGame(cardId); // game 2
        assertThat(currentGame(cardId)).isEqualTo(3);

        // Game 3 is the PAIR_RESULT source: pair it and score every table (winner = player_one).
        service.generatePairingPreview(cardId, "ittest");
        service.confirmPairingPreview(cardId, "ittest");
        int sourceTables = jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 3", Integer.class, cardId);
        for (int table = 1; table <= sourceTables; table++)
            service.submitResult(cardId, "g3t" + table, new CardDtos.ResultRequest(100, 72, false), "ittest");

        // Before publish-next: nothing snapshotted, destination materialised but not published.
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM pairing_snapshots WHERE card_id = ? AND game_from = 3", Long.class, cardId)).isZero();

        service.publishPairResultDestination(cardId, "ittest");

        // Source game 3 is now a confirmed single-game snapshot; the destination stays open for scoring.
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM pairing_snapshots WHERE card_id = ? AND game_from = 3 AND game_to = 3 AND confirmed_at IS NOT NULL",
            Long.class, cardId)).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 3 AND snapshot_no IS NULL", Long.class, cardId)).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 4 AND snapshot_no IS NULL", Long.class, cardId)).isGreaterThan(0L);
        assertThat(currentGame(cardId)).isEqualTo(3); // still the source game until the destination publishes

        // R2: the published source game stays editable via overrideResult (director "แก้เกมเก่า"),
        // which does not hit the immutability guard and re-stamps the snapshot time.
        int diffBefore = jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 3 AND table_number = 1", Integer.class, cardId);
        service.overrideResult(cardId, "g3t1", new CardDtos.ResultRequest(120, 72, false), "ittest");
        int diffAfter = jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 3 AND table_number = 1", Integer.class, cardId);
        assertThat(diffAfter).isNotEqualTo(diffBefore); // edit took effect on a snapshotted (published) game
        assertThat(jdbc.queryForObject(
            "SELECT confirmed_at IS NOT NULL FROM pairing_snapshots WHERE card_id = ? AND game_from = 3", Boolean.class, cardId)).isTrue();

        // Finishing the destination: it becomes its own snapshot (game 4), separate from game 3.
        service.autoResults(cardId, "ittest");
        service.reviewResults(cardId, "ittest");
        service.publishResults(cardId, "ittest");
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM pairing_snapshots WHERE card_id = ? AND game_from = 4 AND game_to = 4", Long.class, cardId)).isEqualTo(1L);
        // Game 4 is the last game, so the card finishes with two distinct snapshots (game 3, game 4).
        assertThat(jdbc.queryForObject("SELECT status FROM tournament_cards WHERE id = ?", String.class, cardId)).isEqualTo("FINISHED");
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM pairing_snapshots WHERE card_id = ? AND game_from IN (3, 4)", Long.class, cardId)).isEqualTo(2L);
    }
}
