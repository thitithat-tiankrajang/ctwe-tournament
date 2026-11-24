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
            games, edges, maxDiffs, "NONE", 0, false, PairingRuleType.RANDOM, null);
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
     * step of which the rules permit. Before V37 the slot became an unscoreable, unpublishable
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

        scoreEveryLiveSlot(cardId);
        service.reviewResults(cardId, ACTOR);
        assertThatThrownBy(() -> service.publishResults(cardId, ACTOR))
            .isInstanceOf(TournamentCardService.ScreeningPoolPending.class);
        assertThatThrownBy(() -> service.terminatePublicationHolds(cardId, List.of(external(cardId, first)), ACTOR))
            .isInstanceOf(TournamentCardService.ScreeningPoolPending.class);
        assertThat(pool.listOpen(cardId)).hasSize(2);

        service.terminatePublicationHolds(cardId, List.of(external(cardId, first), external(cardId, partner)), ACTOR);
        assertThat(pool.isEmpty(cardId)).isTrue();
        service.publishResults(cardId, ACTOR);

        Integer snapshotNo = jdbc.queryForObject(
            "SELECT snapshot_no FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?",
            Integer.class, cardId, slot[0], slot[1]);
        assertThat(snapshotNo).as("the voided slot is published with the block, not stranded").isNotNull();
    }

    // ---- the gate ----------------------------------------------------------

    @Test
    void publicationIsBlockedWhileAnyPlayerIsHeld() {
        UUID cardId = cardInResultCollection(8);
        int held = codes(cardId).get(0);
        screen(cardId, held);
        scoreEveryLiveSlot(cardId);

        service.reviewResults(cardId, ACTOR);
        assertThatThrownBy(() -> service.publishResults(cardId, ACTOR))
            .isInstanceOf(TournamentCardService.ScreeningPoolPending.class)
            .hasMessageContaining("ถังคัดชั่วคราว")
            // The message must name the player using THIS card's prefix. The legacy single-argument
            // pcode() always renders "P", which would send the director looking for a code that
            // appears on no screen in this tournament.
            .hasMessageContaining(external(cardId, held));
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
    void aNoOpponentSlotWinsAndKeepsTheEnteredMargin() {
        UUID cardId = cardInResultCollection(7);   // odd field -> exactly one bye

        int[] bye = jdbc.queryForObject("""
            SELECT table_number, COALESCE(player_one, player_two) FROM matches
            WHERE card_id = ? AND game_number = 1
              AND (player_one IS NULL) <> (player_two IS NULL)
            LIMIT 1
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2) }, cardId);

        service.submitResult(cardId, "g1t" + bye[0], new CardDtos.ResultRequest(300, 0, false), ACTOR);

        // OWNER-CONFIRMED RULE (release validation): a no-opponent slot is processed as the score
        // that was actually entered — the empty seat is 0 and the differential is the ordinary
        // margin, capped by the game maximum like any other pair. The system does not invent the
        // occupied player's score, so it must not overrule the margin that score produces.
        //
        // This REVERSES the previous implementation rule ("a game nobody played must not move a
        // tie-break", which forced the differential to 0). That earlier rule was deliberate, so the
        // reversal is recorded here rather than silently dropped: the owner now decides the entered
        // score, and the entered score decides the margin.
        Integer diff = jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, bye[0]);
        assertThat(diff).as("the entered margin is kept (300 - 0, under the 500 game maximum)").isEqualTo(300);

        Integer winner = jdbc.queryForObject(
            "SELECT winner FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, bye[0]);
        assertThat(winner).as("the lone player still wins").isEqualTo(bye[1]);

        // The empty seat is forced to 0, not left holding whatever was typed opposite. This is what
        // the `presentScore > 0` guard is measured against once negative scores are allowed for real
        // matches — without it, a bye "won" with a negative score would sit under its absent opponent.
        int[] stored = jdbc.queryForObject("""
            SELECT score_one, score_two, COALESCE(player_one, -1) FROM matches
            WHERE card_id = ? AND game_number = 1 AND table_number = ?
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3) }, cardId, bye[0]);
        boolean onePresent = stored[2] != -1;
        assertThat(onePresent ? stored[1] : stored[0]).as("the empty seat scores 0").isZero();
        assertThat(onePresent ? stored[0] : stored[1]).as("the present player keeps their score").isEqualTo(300);
    }

    /**
     * A bye's empty seat is forced to 0, so the present player must win with a POSITIVE score. Once
     * negative scores are allowed for real matches, "greater than whatever was typed opposite" is no
     * longer enough: -10 beats -50 as typed, but against a forced 0 it would store a winner sitting
     * below their absent opponent.
     */
    @Test
    void aByeCannotBeWonWithANonPositiveScore() {
        UUID cardId = cardInResultCollection(7);
        Integer byeTable = jdbc.queryForObject(
            "SELECT table_number FROM matches WHERE card_id = ? AND game_number = 1"
                + " AND (player_one IS NULL) <> (player_two IS NULL) LIMIT 1",
            Integer.class, cardId);
        boolean onePresent = Boolean.TRUE.equals(jdbc.queryForObject(
            "SELECT player_one IS NOT NULL FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Boolean.class, cardId, byeTable));

        // The present player "beats" the empty seat as typed (1 > 0) but scores zero themselves.
        assertThatThrownBy(() -> service.submitResult(cardId, "g1t" + byeTable,
            new CardDtos.ResultRequest(onePresent ? 0 : 1, onePresent ? 1 : 0, false), ACTOR))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("บาย");
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

    // ---- overrideResult: the remediation path for a pre-deploy bye ---------
    //
    // recalculateStandings rebuilds from the STORED calculated_diff, so a bye recorded before this
    // path existed keeps its margin forever — no recalculation reconciles it, because the stored
    // value is the input. overrideResult is the only way back, and nothing else covers its bye
    // branch.

    /** The lone player's seat, their code, and the table — for a card whose game 1 has one bye. */
    private int[] byeSeat(UUID cardId) {
        return jdbc.queryForObject("""
            SELECT table_number, COALESCE(player_one, player_two), (player_one IS NOT NULL)::int
            FROM matches
            WHERE card_id = ? AND game_number = 1 AND (player_one IS NULL) <> (player_two IS NULL)
            LIMIT 1
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3) }, cardId);
    }

    /** Write the bye exactly as the pre-deploy rule stored it: typed margin, real capped diff. */
    private void seedLegacyBye(UUID cardId, int table, boolean onePresent, int code, int margin) {
        jdbc.update("""
            UPDATE matches SET winner = ?, score_one = ?, score_two = ?, result_type = 'W',
                               calculated_diff = ?, submitted_by = ?, submitted_at = now()
            WHERE card_id = ? AND game_number = 1 AND table_number = ?
            """, code, onePresent ? margin : 0, onePresent ? 0 : margin, margin, ACTOR, cardId, table);
        service.recalculateStandings(cardId);
    }

    private Integer standingDiff(UUID cardId, int code) {
        return jdbc.queryForObject(
            "SELECT diff FROM standings WHERE card_id = ? AND player_code = ?", Integer.class, cardId, code);
    }

    @Test
    void overridingALegacyByeTakesTheCorrectedMarginAndRebuildsStandings() {
        // What this covers is the REMEDIATION, not the differential rule: a bye stored before this
        // path existed keeps whatever margin it was typed with, because recalculateStandings reads
        // the stored calculated_diff as its input and so can never reconcile it. overrideResult is
        // the only way back, and the standings must be rebuilt from the corrected value rather than
        // patched incrementally.
        //
        // This test previously asserted a corrected bye stores 0 ("a game nobody played must not
        // move a tie-break"). That rule was deliberately REVERSED — the owner now decides the
        // entered score, and the entered score decides the margin, capped by the game maximum
        // exactly as for a contested pair (see submitResult's bye branch and its own coverage
        // above). The expectation follows the live rule; the remediation it guards is unchanged.
        UUID cardId = cardInResultCollection(7);
        int[] bye = byeSeat(cardId);
        int table = bye[0], code = bye[1];
        boolean onePresent = bye[2] == 1;

        seedLegacyBye(cardId, table, onePresent, code, 300);
        assertThat(standingDiff(cardId, code))
            .as("the bye's stored margin reaches the standings").isEqualTo(300);

        service.overrideResult(cardId, "g1t" + table, new CardDtos.ResultRequest(
            onePresent ? 250 : 0, onePresent ? 0 : 250, true), ACTOR);

        int[] stored = jdbc.queryForObject("""
            SELECT score_one, score_two, calculated_diff, winner FROM matches
            WHERE card_id = ? AND game_number = 1 AND table_number = ?
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4) }, cardId, table);

        assertThat(onePresent ? stored[1] : stored[0]).as("the empty seat is forced to 0").isZero();
        assertThat(onePresent ? stored[0] : stored[1]).as("the present player keeps their score").isEqualTo(250);
        assertThat(stored[2])
            .as("the corrected margin stands, under the 500 game maximum").isEqualTo(250);
        assertThat(stored[3]).as("the lone player still wins").isEqualTo(code);

        assertThat(standingDiff(cardId, code))
            .as("standings are rebuilt from the corrected value, not patched incrementally").isEqualTo(250);
        assertThat(jdbc.queryForObject(
            "SELECT wins FROM standings WHERE card_id = ? AND player_code = ?", Integer.class, cardId, code))
            .as("correcting the margin must not cost the player the win").isEqualTo(1);
    }

    @Test
    void overrideRejectsAByeWonWithANonPositiveScore() {
        UUID cardId = cardInResultCollection(7);
        int[] bye = byeSeat(cardId);
        int table = bye[0];
        boolean onePresent = bye[2] == 1;
        seedLegacyBye(cardId, table, onePresent, bye[1], 300);

        // Beats the empty seat as typed (1 > 0) but scores zero, which the forced-0 seat makes
        // meaningless. Same rule as submitResult — the two branches must not drift apart.
        assertThatThrownBy(() -> service.overrideResult(cardId, "g1t" + table, new CardDtos.ResultRequest(
            onePresent ? 0 : 1, onePresent ? 1 : 0, true), ACTOR))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("บาย");

        assertThat(jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, table))
            .as("a refused override must leave the row exactly as it was").isEqualTo(300);
    }

    @Test
    void overridingARealMatchStillTakesItsMargin() {
        // The bye exemption lives in the same branch on both paths; this is the guard that it does
        // not leak into overrideResult's ordinary case the way it must not leak into submitResult's.
        UUID cardId = cardInResultCollection(8);
        Integer table = jdbc.queryForObject("""
            SELECT table_number FROM matches
            WHERE card_id = ? AND game_number = 1 AND player_one IS NOT NULL AND player_two IS NOT NULL
            ORDER BY table_number LIMIT 1
            """, Integer.class, cardId);

        service.submitResult(cardId, "g1t" + table, new CardDtos.ResultRequest(300, 200, false), ACTOR);
        service.overrideResult(cardId, "g1t" + table, new CardDtos.ResultRequest(420, 300, true), ACTOR);

        assertThat(jdbc.queryForObject(
            "SELECT calculated_diff FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, table))
            .as("a played match keeps its margin under override").isEqualTo(120);
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
     * R-B: V38's trigger makes a bare {@code DELETE FROM audit_logs} fail. Card deletion opens the
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
