package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The dry run must survive a genuinely READ-ONLY transaction.
 *
 * <p>Deliberately NOT {@code @Transactional}. Every other integration test here runs inside a
 * read-WRITE transaction that is rolled back, and {@code validate}'s own {@code readOnly = true}
 * silently joins it — which hid a real production 500: {@code cardSummary} used to take
 * {@code SELECT ... FOR UPDATE}, and PostgreSQL refuses that outright in a read-only transaction.
 * A rolled-back harness cannot see that class of bug, because the read-only flag never takes effect.
 *
 * <p>The cost of committing for real is a card left behind, so this class cleans up after itself.
 */
@SpringBootTest
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class PairingSessionReadOnlyTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final String ACTOR = "ittest";

    @Autowired TournamentCardService cards;
    @Autowired PairingSessionService session;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactions;

    @Test
    void validateSurvivesARealReadOnlyTransaction() {
        UUID tournamentId = jdbc.queryForObject("SELECT id FROM tournaments LIMIT 1", UUID.class);
        UUID cardId = cards.create(new CardDtos.CreateCardRequest(tournamentId,
            "RO-" + UUID.randomUUID(), "DIV", 3,
            List.of(PairingRuleType.SWISS, PairingRuleType.SWISS), List.of(500, 500, 500),
            "NONE", 0, false, PairingRuleType.RANDOM, null), ACTOR).id();
        try {
            List<CardDtos.BulkPlayerEntry> entries = new ArrayList<>();
            for (int i = 0; i < 8; i++)
                entries.add(new CardDtos.BulkPlayerEntry("RO" + i, "L" + i, "School" + (i % 3)));
            cards.addPlayersBulk(cardId, entries, ACTOR);
            cards.finishRegistration(cardId, ACTOR);
            cards.generatePairingPreview(cardId, ACTOR);
            cards.confirmPairingPreview(cardId, ACTOR);

            int[] slot = jdbc.queryForObject("""
                SELECT game_number, table_number, player_one, player_two FROM matches
                WHERE card_id = ? AND game_number = 1 AND player_one IS NOT NULL AND player_two IS NOT NULL
                ORDER BY table_number LIMIT 1
                """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4) }, cardId);
            String prefix = jdbc.queryForObject(
                "SELECT code_prefix FROM tournament_cards WHERE id = ?", String.class, cardId);
            String one = prefix + String.format("%03d", slot[2]);
            String two = prefix + String.format("%03d", slot[3]);

            var body = new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", false,
                List.of(new CardDtos.SlotState(1, slot[1], one, two)), List.of(),
                List.of(new CardDtos.ScreenEntry(one, "NO_SHOW", null)), List.of(), List.of());

            var template = new TransactionTemplate(transactions);
            template.setReadOnly(true);
            var verdict = template.execute(status -> session.validate(cardId, body));

            assertThat(verdict).isNotNull();
            assertThat(verdict.ok()).as("the dry run must not need a row lock").isTrue();
            assertThat(verdict.changes()).hasSize(1);

            // And again over a slot that HAS a result, which is the branch that reaches
            // unwindBlocker — a second lock-taking call hid there and only surfaced in the browser.
            cards.submitResult(cardId, "g1t" + slot[1],
                new CardDtos.ResultRequest(300, 200, false), ACTOR);
            var forced = new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", true,
                List.of(new CardDtos.SlotState(1, slot[1], one, two)),
                List.of(new CardDtos.SlotState(1, slot[1], one, null)),
                List.of(), List.of(), List.of());
            var forcedVerdict = template.execute(status -> session.validate(cardId, forced));

            assertThat(forcedVerdict).isNotNull();
            assertThat(forcedVerdict.resultsToRemove())
                .as("the force pre-check must also run without taking a lock")
                .hasSize(1);
        } finally {
            cards.delete(cardId);
        }
    }
}
