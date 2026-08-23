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
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * P1 guards for the Screening Pool: the deadlock that stranded the original rules, the review/publish
 * gate, generator exclusion, zero-diff byes, and card deletion under the append-only audit trigger.
 *
 * <p>Real Postgres (localhost:5432), every test inside a rolled-back transaction so the developer's
 * own cards are never touched. Runs only when DATABASE_PASSWORD is present — note that without it
 * JUnit SKIPS these silently and the build still reports success, so CI must assert the run count.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class ScreeningPoolIntegrationTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final String ACTOR = "ittest";

    @Autowired TournamentCardService service;
    @Autowired ScreeningPoolStore pool;
    @Autowired JdbcTemplate jdbc;

    // ---- scaffolding -------------------------------------------------------

    private UUID tournamentId() {
        return jdbc.queryForObject("SELECT id FROM tournaments LIMIT 1", UUID.class);
    }

    private UUID createCard(int games) {
        List<PairingRuleType> edges = new ArrayList<>();
        List<Integer> maxDiffs = new ArrayList<>();
        for (int i = 0; i < games; i++) maxDiffs.add(500);
        for (int i = 1; i < games; i++) edges.add(PairingRuleType.SWISS);
        var request = new CardDtos.CreateCardRequest(tournamentId(), "SP-" + UUID.randomUUID(), "DIV",
            games, edges, maxDiffs, "NONE", 0, false, PairingRuleType.RANDOM);
        return service.create(request, ACTOR).id();
    }

    private void addPlayers(UUID cardId, int count) {
        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < count; i++)
            players.add(new CardDtos.BulkPlayerEntry("First" + i, "Last" + i, "School" + (i % 3)));
        service.addPlayersBulk(cardId, players, ACTOR);
    }

    /** A card sitting in RESULT_COLLECTION with a confirmed game-1 pairing and no results yet. */
    private UUID cardInResultCollection(int players) {
        UUID cardId = createCard(3);
        addPlayers(cardId, players);
        service.finishRegistration(cardId, ACTOR);
        service.generatePairingPreview(cardId, ACTOR);
        service.confirmPairingPreview(cardId, ACTOR);
        return cardId;
    }

    private List<Integer> codes(UUID cardId) {
        return jdbc.queryForList("SELECT code FROM players WHERE card_id = ? ORDER BY code",
            Integer.class, cardId);
    }

    private String external(UUID cardId, int code) {
        return jdbc.queryForObject("SELECT code_prefix FROM tournament_cards WHERE id = ?", String.class, cardId)
            + String.format("%03d", code);
    }

    /** The (game, table) slot a player currently occupies in game 1. */
    private int[] slotOf(UUID cardId, int code) {
        return jdbc.queryForObject("""
            SELECT game_number, table_number FROM matches
            WHERE card_id = ? AND game_number = 1 AND (player_one = ? OR player_two = ?)
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2) }, cardId, code, code);
    }

    /** Screen a player the way a commit will: open the hold and vacate their seat, atomically. */
    private void screen(UUID cardId, int code) {
        int[] slot = slotOf(cardId, code);
        Integer opponent = jdbc.queryForObject("""
            SELECT CASE WHEN player_one = ? THEN player_two ELSE player_one END
            FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?
            """, Integer.class, code, cardId, slot[0], slot[1]);
        int side = Boolean.TRUE.equals(jdbc.queryForObject(
            "SELECT player_one = ? FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?",
            Boolean.class, code, cardId, slot[0], slot[1])) ? 1 : 2;

        pool.open(cardId, code, ScreeningPoolStore.Reason.NO_SHOW, null,
            new ScreeningPoolStore.Origin(slot[0], slot[1], side, opponent, false), ACTOR);
        jdbc.update("UPDATE matches SET player_" + (side == 1 ? "one" : "two") + " = NULL"
            + " WHERE card_id = ? AND game_number = ? AND table_number = ?", cardId, slot[0], slot[1]);
        // A slot that lost both players is voided, never deleted: table numbering must survive.
        jdbc.update("""
            UPDATE matches SET voided_at = now(), voided_by = ?
            WHERE card_id = ? AND game_number = ? AND table_number = ?
              AND player_one IS NULL AND player_two IS NULL AND voided_at IS NULL
            """, ACTOR, cardId, slot[0], slot[1]);
    }

    /**
     * Score every slot that still needs a result. A bye must be scored with the winning margin on the
     * side the present player actually occupies — the lone player has to win, so 300/200 on the wrong
     * side is rejected.
     */
    private void scoreEveryLiveSlot(UUID cardId) {
        var live = jdbc.query("""
            SELECT table_number, player_one IS NOT NULL, player_two IS NOT NULL FROM matches
            WHERE card_id = ? AND game_number = 1 AND snapshot_no IS NULL
              AND voided_at IS NULL AND result_type IS NULL
            ORDER BY table_number
            """, (rs, row) -> new Object[] { rs.getInt(1), rs.getBoolean(2), rs.getBoolean(3) }, cardId);
        for (Object[] match : live) {
            boolean onePresent = (Boolean) match[1];
            int scoreOne = onePresent ? 300 : 200;
            int scoreTwo = onePresent ? 200 : 300;
            service.submitResult(cardId, "g1t" + match[0],
                new CardDtos.ResultRequest(scoreOne, scoreTwo, false), ACTOR);
        }
    }

    // ---- the deadlock ------------------------------------------------------

    /**
     * The case that stranded the original rules, and the reason voided slots exist.
     *
     * <p>Both players of one pairing fail to appear, are screened, and are then terminated — every
     * step of which the rules permit. Before V36 the slot became an unscoreable, unpublishable
     * both-NULL row: submitResult refuses it, review can never complete it, and the published-pairing
     * CHECK forbids snapshotting it. The round could not advance by any route.
     */
    @Test
    void bothPlayersScreenedThenTerminated_roundStillAdvances() {
        UUID cardId = cardInResultCollection(8);
        List<Integer> codes = codes(cardId);

        // Two players from the SAME pairing fail to appear.
        int first = codes.get(0);
        int[] slot = slotOf(cardId, first);
        Integer partner = jdbc.queryForObject("""
            SELECT CASE WHEN player_one = ? THEN player_two ELSE player_one END
            FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?
            """, Integer.class, first, cardId, slot[0], slot[1]);
        assertThat(partner).as("8 players pair evenly, so this slot has two occupants").isNotNull();

        screen(cardId, first);
        screen(cardId, partner);

        // The slot is VOIDED, not deleted — its table number is still there.
        Boolean voided = jdbc.queryForObject(
            "SELECT voided_at IS NOT NULL FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?",
            Boolean.class, cardId, slot[0], slot[1]);
        assertThat(voided).as("an abandoned slot is voided so table numbering survives").isTrue();

        // The gate refuses while anyone is held.
        scoreEveryLiveSlot(cardId);
        assertThatThrownBy(() -> service.reviewResults(cardId, ACTOR))
            .hasMessageContaining("Screening Pool");

        // Resolve both by the disciplinary exit.
        service.terminatePlayers(cardId, List.of(external(cardId, first), external(cardId, partner)), ACTOR);
        assertThat(pool.isEmpty(cardId)).isTrue();

        // ...and the round now advances all the way through publish.
        service.reviewResults(cardId, ACTOR);
        service.publishResults(cardId, ACTOR);

        Integer snapshotNo = jdbc.queryForObject(
            "SELECT snapshot_no FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?",
            Integer.class, cardId, slot[0], slot[1]);
        assertThat(snapshotNo).as("the voided slot is published with the block, not stranded").isNotNull();
    }

    // ---- the gate ----------------------------------------------------------

    @Test
    void reviewIsBlockedWhileAnyPlayerIsHeld() {
        UUID cardId = cardInResultCollection(8);
        int held = codes(cardId).get(0);
        screen(cardId, held);
        scoreEveryLiveSlot(cardId);

        assertThatThrownBy(() -> service.reviewResults(cardId, ACTOR))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Screening Pool");
    }

    @Test
    void reviewPassesOnceThePoolIsEmptied() {
        UUID cardId = cardInResultCollection(8);
        int held = codes(cardId).get(0);
        screen(cardId, held);

        // Re-seat them: the vacated seat is still there, which is exactly seat conservation (I11).
        int[] slot = slotOf2(cardId, held);
        jdbc.update("UPDATE matches SET player_one = COALESCE(player_one, ?), "
            + "player_two = CASE WHEN player_one IS NOT NULL AND player_two IS NULL THEN ? ELSE player_two END, "
            + "voided_at = NULL, voided_by = NULL "
            + "WHERE card_id = ? AND game_number = ? AND table_number = ?", held, held, cardId, slot[0], slot[1]);
        pool.close(cardId, held, ScreeningPoolStore.Resolution.RETURNED, ACTOR);

        scoreEveryLiveSlot(cardId);
        service.reviewResults(cardId, ACTOR);   // must not throw

        String stage = jdbc.queryForObject(
            "SELECT runtime_stage FROM tournament_cards WHERE id = ?", String.class, cardId);
        assertThat(stage).isEqualTo("RESULT_REVIEW");
    }

    /** The slot a player was screened out of, read back from their open hold. */
    private int[] slotOf2(UUID cardId, int code) {
        return jdbc.queryForObject("""
            SELECT origin_game, origin_table FROM screening_pool
            WHERE card_id = ? AND player_code = ? AND resolved_at IS NULL
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2) }, cardId, code);
    }

    // ---- generator exclusion ----------------------------------------------

    @Test
    void aHeldPlayerIsLeftOutOfAGeneratedPairing() {
        UUID cardId = createCard(3);
        addPlayers(cardId, 8);
        service.finishRegistration(cardId, ACTOR);

        int held = codes(cardId).get(0);
        pool.open(cardId, held, ScreeningPoolStore.Reason.NO_SHOW, null,
            ScreeningPoolStore.Origin.UNKNOWN, ACTOR);

        service.generatePairingPreview(cardId, ACTOR);

        Long seated = jdbc.queryForObject(
            "SELECT COUNT(*) FROM table_seats WHERE card_id = ? AND player_code = ?",
            Long.class, cardId, held);
        assertThat(seated).as("screening before generation keeps the player out of the field").isZero();

        Long total = jdbc.queryForObject(
            "SELECT COUNT(*) FROM table_seats WHERE card_id = ?", Long.class, cardId);
        assertThat(total).as("the other seven are still seated").isEqualTo(7L);
    }

    // ---- byes --------------------------------------------------------------

    /**
     * A bye is defined by shape — one player, one empty seat — with no record of why. It wins, but
     * contributes zero diff: nobody played, and ranking leads with capped diff, so a typed margin
     * would reorder real standings on the strength of a game that never happened.
     */
    @Test
    void aByeWinsWithZeroDiffWhateverMarginIsTyped() {
        UUID cardId = cardInResultCollection(7);   // odd field -> exactly one bye

        int[] bye = jdbc.queryForObject("""
            SELECT table_number, COALESCE(player_one, player_two) FROM matches
            WHERE card_id = ? AND game_number = 1
              AND (player_one IS NULL) <> (player_two IS NULL)
            LIMIT 1
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2) }, cardId);

        service.submitResult(cardId, "g1t" + bye[0], new CardDtos.ResultRequest(300, 0, false), ACTOR);

        Integer diff = jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, bye[0]);
        assertThat(diff).as("a game nobody played must not move a tie-break").isZero();

        Integer winner = jdbc.queryForObject(
            "SELECT winner FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, bye[0]);
        assertThat(winner).as("the lone player still wins").isEqualTo(bye[1]);
    }

    @Test
    void aRealMatchStillRequiresAMargin() {
        UUID cardId = cardInResultCollection(8);
        int[] real = jdbc.queryForObject("""
            SELECT table_number FROM matches
            WHERE card_id = ? AND game_number = 1 AND player_one IS NOT NULL AND player_two IS NOT NULL
            ORDER BY table_number LIMIT 1
            """, (rs, row) -> new int[] { rs.getInt(1) }, cardId);

        service.submitResult(cardId, "g1t" + real[0], new CardDtos.ResultRequest(300, 200, false), ACTOR);
        Integer diff = jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, real[0]);
        assertThat(diff).as("the bye exemption must not leak into ordinary matches").isEqualTo(100);
    }

    // ---- seat conservation (I11) -------------------------------------------

    @Test
    void everyHeldPlayerHasASeatWaiting() {
        UUID cardId = cardInResultCollection(8);
        List<Integer> codes = codes(cardId);

        for (int i = 0; i < 3; i++) {
            screen(cardId, codes.get(i));

            long emptySeats = jdbc.queryForObject("""
                SELECT SUM((player_one IS NULL)::int + (player_two IS NULL)::int)
                FROM matches WHERE card_id = ? AND game_number = 1 AND snapshot_no IS NULL
                """, Long.class, cardId);
            long heldCount = pool.openCodes(cardId).size();

            assertThat(emptySeats)
                .as("after screening %d, free seats must still cover everyone held", i + 1)
                .isGreaterThanOrEqualTo(heldCount);
        }
    }

    // ---- append-only audit, and deletion under it --------------------------

    @Test
    void auditRowsCannotBeRewritten() {
        UUID cardId = createCard(2);
        assertThatThrownBy(() -> jdbc.update("UPDATE audit_logs SET actor = 'x' WHERE card_id = ?", cardId))
            .hasMessageContaining("append-only");
    }

    /**
     * R-B: V37's trigger makes a bare {@code DELETE FROM audit_logs} fail. Card deletion opens the
     * GUC first — this proves that guard is actually wired, because without it every other test still
     * passes while deletion breaks in production.
     */
    @Test
    void cardDeletionStillSucceedsUnderTheAppendOnlyTrigger() {
        UUID cardId = createCard(2);
        addPlayers(cardId, 4);
        int held = codes(cardId).get(0);
        pool.open(cardId, held, ScreeningPoolStore.Reason.LATE, "probe",
            ScreeningPoolStore.Origin.UNKNOWN, ACTOR);

        service.delete(cardId);

        Long cards = jdbc.queryForObject(
            "SELECT COUNT(*) FROM tournament_cards WHERE id = ?", Long.class, cardId);
        assertThat(cards).isZero();
        Long holds = jdbc.queryForObject(
            "SELECT COUNT(*) FROM screening_pool WHERE card_id = ?", Long.class, cardId);
        assertThat(holds).as("holds go with the card").isZero();
    }

    // ---- pool semantics ----------------------------------------------------

    @Test
    void screeningTheSamePlayerTwiceIsConvergentNotAnError() {
        UUID cardId = createCard(2);
        addPlayers(cardId, 4);
        int code = codes(cardId).get(0);

        assertThat(pool.open(cardId, code, ScreeningPoolStore.Reason.NO_SHOW, null,
            ScreeningPoolStore.Origin.UNKNOWN, "director-a")).isTrue();
        assertThat(pool.open(cardId, code, ScreeningPoolStore.Reason.LATE, null,
            ScreeningPoolStore.Origin.UNKNOWN, "director-b"))
            .as("two directors screening the same no-show have agreed, not conflicted")
            .isFalse();
        assertThat(pool.openCodes(cardId)).containsExactly(code);
    }

    @Test
    void aPlayerCanBeHeldAgainAfterBeingReturned() {
        UUID cardId = createCard(2);
        addPlayers(cardId, 4);
        int code = codes(cardId).get(0);

        pool.open(cardId, code, ScreeningPoolStore.Reason.LATE, null, ScreeningPoolStore.Origin.UNKNOWN, ACTOR);
        pool.close(cardId, code, ScreeningPoolStore.Resolution.RETURNED, ACTOR);
        assertThat(pool.isEmpty(cardId)).isTrue();

        assertThat(pool.open(cardId, code, ScreeningPoolStore.Reason.NO_SHOW, null,
            ScreeningPoolStore.Origin.UNKNOWN, ACTOR)).isTrue();

        Long history = jdbc.queryForObject(
            "SELECT COUNT(*) FROM screening_pool WHERE card_id = ? AND player_code = ?",
            Long.class, cardId, code);
        assertThat(history).as("the earlier hold is kept as history, not overwritten").isEqualTo(2L);
    }

    @Test
    void capturedOriginIsMarkedStaleWhenThatSlotChanges() {
        UUID cardId = cardInResultCollection(8);
        int held = codes(cardId).get(0);
        screen(cardId, held);
        int[] slot = slotOf2(cardId, held);

        pool.markOriginStale(cardId, List.of(new int[] { slot[0], slot[1] }));

        Boolean stale = jdbc.queryForObject("""
            SELECT origin_stale FROM screening_pool
            WHERE card_id = ? AND player_code = ? AND resolved_at IS NULL
            """, Boolean.class, cardId, held);
        assertThat(stale)
            .as("a pool card must not confidently name an opponent who has since moved")
            .isTrue();
    }
}
