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
 * The pairing tool's commit contract: atomicity, the per-slot precondition, idempotency, the hard
 * blocks, and the rule that a hold has exactly two exits.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class PairingSessionIntegrationTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final String ACTOR = "ittest";

    @Autowired TournamentCardService cards;
    @Autowired PairingSessionService session;
    @Autowired ScreeningPoolStore pool;
    @Autowired JdbcTemplate jdbc;

    // ---- scaffolding -------------------------------------------------------

    private UUID cardWithPairing(int players) {
        UUID tournamentId = jdbc.queryForObject("SELECT id FROM tournaments LIMIT 1", UUID.class);
        List<PairingRuleType> edges = List.of(PairingRuleType.SWISS, PairingRuleType.SWISS);
        UUID cardId = cards.create(new CardDtos.CreateCardRequest(tournamentId, "PS-" + UUID.randomUUID(),
            "DIV", 3, edges, List.of(500, 500, 500), "NONE", 0, false, PairingRuleType.RANDOM, null), ACTOR).id();
        List<CardDtos.BulkPlayerEntry> entries = new ArrayList<>();
        for (int i = 0; i < players; i++)
            entries.add(new CardDtos.BulkPlayerEntry("F" + i, "L" + i, "School" + (i % 3)));
        cards.addPlayersBulk(cardId, entries, ACTOR);
        cards.finishRegistration(cardId, ACTOR);
        cards.generatePairingPreview(cardId, ACTOR);
        cards.confirmPairingPreview(cardId, ACTOR);
        return cardId;
    }

    private String prefix(UUID cardId) {
        return jdbc.queryForObject("SELECT code_prefix FROM tournament_cards WHERE id = ?", String.class, cardId);
    }

    private String id(UUID cardId, int code) {
        return prefix(cardId) + String.format("%03d", code);
    }

    /** (game, table, one, two) of the first slot in game 1 holding two players. */
    private int[] fullSlot(UUID cardId) {
        return jdbc.queryForObject("""
            SELECT game_number, table_number, player_one, player_two FROM matches
            WHERE card_id = ? AND game_number = 1 AND player_one IS NOT NULL AND player_two IS NOT NULL
            ORDER BY table_number LIMIT 1
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4) }, cardId);
    }

    private CardDtos.SlotState slot(int game, int table, String one, String two) {
        return new CardDtos.SlotState(game, table, one, two);
    }

    private CardDtos.PairingCommitRequest request(
        List<CardDtos.SlotState> expect, List<CardDtos.SlotState> slots,
        List<CardDtos.ScreenEntry> screen, List<String> release, List<String> acknowledged) {
        return new CardDtos.PairingCommitRequest(UUID.randomUUID(), "irrelevant-here", false,
            expect, slots, screen, release, acknowledged);
    }

    private long publicVersion(UUID cardId) {
        return jdbc.queryForObject("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, cardId);
    }

    // ---- screening through the tool ---------------------------------------

    @Test
    void screeningVacatesTheSeatAndOpensAHoldInOneCommit() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))),
            List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)),
            List.of(), List.of()), ACTOR);

        Integer one = jdbc.queryForObject(
            "SELECT player_one FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, slot[1]);
        assertThat(one).as("the seat is vacated by the same commit that opens the hold").isNull();
        assertThat(pool.openCodes(cardId)).containsExactly(slot[2]);
    }

    /**
     * A hold created by this commit must NOT be marked stale by the same commit. Its origin slot is
     * by definition one of the slots the commit touched, so ordering the stale-marking after hold
     * creation makes every brand-new pool card claim its own context is already out of date.
     */
    @Test
    void aFreshHoldIsNotImmediatelyMarkedStale() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        assertThat(pool.listOpen(cardId)).singleElement()
            .satisfies(hold -> assertThat(hold.origin().stale())
                .as("the context was captured by this very commit — it cannot already be stale")
                .isFalse());
    }

    @Test
    void anOlderHoldIsMarkedStaleWhenItsOriginSlotChanges() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        String partner = id(cardId, slot[3]);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, partner)), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        // A later commit rewrites the very slot that hold was taken from.
        session.commit(cardId, request(
            List.of(slot(1, slot[1], null, partner)), List.of(),
            List.of(new CardDtos.ScreenEntry(partner, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        assertThat(pool.listOpen(cardId))
            .filteredOn(hold -> hold.playerCode() == slot[2])
            .singleElement()
            .satisfies(hold -> assertThat(hold.origin().stale())
                .as("the pairing it named has since changed")
                .isTrue());
    }

    @Test
    void theHoldRemembersWhereThePlayerWasSittingAfterTheSeatIsGone() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "LATE", "รถติด")), List.of(), List.of()), ACTOR);

        var hold = pool.listOpen(cardId).get(0);
        assertThat(hold.origin().game()).isEqualTo(1);
        assertThat(hold.origin().table()).isEqualTo(slot[1]);
        assertThat(hold.origin().side()).isEqualTo(1);
        assertThat(hold.origin().opponent())
            .as("captured at screening time — the slot no longer holds this information")
            .isEqualTo(slot[3]);
        assertThat(hold.note()).isEqualTo("รถติด");
    }

    @Test
    void screeningBothPlayersVoidsTheSlotWithoutRenumbering() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        long tablesBefore = jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 1", Long.class, cardId);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(id(cardId, slot[2]), "NO_SHOW", null),
                    new CardDtos.ScreenEntry(id(cardId, slot[3]), "NO_SHOW", null)),
            List.of(), List.of()), ACTOR);

        Boolean voided = jdbc.queryForObject(
            "SELECT voided_at IS NOT NULL FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Boolean.class, cardId, slot[1]);
        assertThat(voided).isTrue();
        long tablesAfter = jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 1", Long.class, cardId);
        assertThat(tablesAfter).as("voided, never deleted — seat numbers derive from table_number")
            .isEqualTo(tablesBefore);
    }

    @Test
    void releasingAPlayerSeatsThemAndClosesTheHold() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        String partner = id(cardId, slot[3]);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, partner)), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        // The seat they vacated is still waiting — that is seat conservation.
        session.commit(cardId, request(
            List.of(slot(1, slot[1], null, partner)),
            List.of(slot(1, slot[1], held, partner)),
            List.of(), List.of(held), List.of()), ACTOR);

        assertThat(pool.isEmpty(cardId)).isTrue();
        Integer one = jdbc.queryForObject(
            "SELECT player_one FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, slot[1]);
        assertThat(one).isEqualTo(slot[2]);
    }

    // ---- rule 3: no "active but unpaired" ---------------------------------

    @Test
    void aPlayerCannotLeaveThePoolWithoutASeat() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        assertThatThrownBy(() -> session.commit(cardId, request(
            List.of(), List.of(), List.of(), List.of(held), List.of()), ACTOR))
            .isInstanceOf(PairingSessionService.PairingRejectedException.class)
            .satisfies(error -> assertThat(((PairingSessionService.PairingRejectedException) error).blocks())
                .extracting(CardDtos.PairingBlock::code).contains("RELEASED_WITHOUT_SEAT"));
    }

    // ---- hard blocks -------------------------------------------------------

    @Test
    void aPlayerCannotBeSeatedTwice() {
        UUID cardId = cardWithPairing(8);
        var slots = jdbc.query("""
            SELECT table_number, player_one, player_two FROM matches
            WHERE card_id = ? AND game_number = 1 AND player_one IS NOT NULL AND player_two IS NOT NULL
            ORDER BY table_number LIMIT 2
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3) }, cardId);
        String duplicated = id(cardId, slots.get(0)[1]);

        assertThatThrownBy(() -> session.commit(cardId, request(
            List.of(slot(1, slots.get(1)[0], id(cardId, slots.get(1)[1]), id(cardId, slots.get(1)[2]))),
            List.of(slot(1, slots.get(1)[0], duplicated, id(cardId, slots.get(1)[2]))),
            List.of(), List.of(), List.of()), ACTOR))
            .isInstanceOf(PairingSessionService.PairingRejectedException.class)
            .satisfies(error -> assertThat(((PairingSessionService.PairingRejectedException) error).blocks())
                .extracting(CardDtos.PairingBlock::code).contains("DUPLICATE_PLAYER"));
    }

    @Test
    void aSlotWithAResultCannotBeRearrangedWithoutForce() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(300, 200, false), ACTOR);

        assertThatThrownBy(() -> session.commit(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))),
            List.of(slot(1, slot[1], id(cardId, slot[2]), null)),
            List.of(), List.of(), List.of()), ACTOR))
            .isInstanceOf(PairingSessionService.PairingRejectedException.class)
            .satisfies(error -> assertThat(((PairingSessionService.PairingRejectedException) error).blocks())
                .extracting(CardDtos.PairingBlock::code).contains("HAS_RESULT"));
    }

    /**
     * Owner rule (release validation): result deletion is only ever a CURRENT-game operation.
     * Once a game is published its rows are history — force is not a second key to them. A director
     * who needs to change a published result uses the historical override, which edits the result
     * and leaves the pairing alone.
     */
    @Test
    void aPublishedSlotCannotBeDestroyedEvenWithForce() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        cards.autoResults(cardId, ACTOR);
        cards.reviewResults(cardId, ACTOR);
        cards.publishResults(cardId, ACTOR);

        var forced = new CardDtos.PairingCommitRequest(UUID.randomUUID(), "irrelevant-here", true,
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))),
            List.of(slot(1, slot[1], id(cardId, slot[2]), null)),
            List.of(), List.of(), List.of());

        assertThatThrownBy(() -> session.commit(cardId, forced, ACTOR))
            .isInstanceOf(PairingSessionService.PairingRejectedException.class)
            .satisfies(error -> assertThat(((PairingSessionService.PairingRejectedException) error).blocks())
                .extracting(CardDtos.PairingBlock::code)
                .as("a published game is history, not a current-game rearrangement")
                .containsAnyOf("SNAPSHOTTED", "GAME_NOT_EDITABLE"));
    }

    /**
     * Force is not a mode, it is permission to destroy results. Asking for it when the change set
     * collides with nothing must behave exactly like an ordinary commit — no results erased, no
     * confirmation theatre, nothing extra written.
     */
    @Test
    void forceWithNothingToDestroyIsJustAnOrdinaryCommit() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);

        var outcome = session.commit(cardId, new CardDtos.PairingCommitRequest(
            UUID.randomUUID(), "x", true,
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        assertThat(outcome.changedSlots()).hasSize(1);
        assertThat(pool.openCodes(cardId)).containsExactly(slot[2]);
        Long destroyed = jdbc.queryForObject(
            "SELECT COUNT(*) FROM audit_logs WHERE card_id = ? AND action = 'FORCE_REMOVE_RESULT'",
            Long.class, cardId);
        assertThat(destroyed).isZero();
    }

    // ---- concurrency -------------------------------------------------------

    @Test
    void aStaleExpectationIsRejectedWithTheSlotsThatMoved() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);

        // Someone else screens player one; our staged view still shows them seated.
        session.commit(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(id(cardId, slot[2]), "NO_SHOW", null)),
            List.of(), List.of()), "other-director");

        assertThatThrownBy(() -> session.commit(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))),
            List.of(slot(1, slot[1], id(cardId, slot[3]), null)),
            List.of(), List.of(), List.of()), ACTOR))
            .isInstanceOf(PairingSessionService.SlotDriftException.class)
            .satisfies(error -> assertThat(((PairingSessionService.SlotDriftException) error).drift())
                .singleElement()
                .satisfies(drift -> assertThat(drift.table()).isEqualTo(slot[1])));
    }

    @Test
    void anUnrelatedChangeElsewhereDoesNotInvalidateTheCommit() {
        UUID cardId = cardWithPairing(8);
        var slots = jdbc.query("""
            SELECT table_number, player_one, player_two FROM matches
            WHERE card_id = ? AND game_number = 1 AND player_one IS NOT NULL AND player_two IS NOT NULL
            ORDER BY table_number LIMIT 2
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3) }, cardId);

        // A result lands on a table we are not touching. A card-level version check would reject the
        // commit here — which on a live floor would mean it never succeeds.
        cards.submitResult(cardId, "g1t" + slots.get(1)[0],
            new CardDtos.ResultRequest(300, 200, false), ACTOR);

        session.commit(cardId, request(
            List.of(slot(1, slots.get(0)[0], id(cardId, slots.get(0)[1]), id(cardId, slots.get(0)[2]))),
            List.of(),
            List.of(new CardDtos.ScreenEntry(id(cardId, slots.get(0)[1]), "NO_SHOW", null)),
            List.of(), List.of()), ACTOR);

        assertThat(pool.openCodes(cardId)).containsExactly(slots.get(0)[1]);
    }

    @Test
    void replayingACommitKeyChangesNothing() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        var body = new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", false,
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of());

        session.commit(cardId, body, ACTOR);
        session.commit(cardId, body, ACTOR);   // the director pressed the button twice

        Long holds = jdbc.queryForObject(
            "SELECT COUNT(*) FROM screening_pool WHERE card_id = ?", Long.class, cardId);
        assertThat(holds).as("a replay is a no-op, not a second apply").isEqualTo(1L);
    }

    // ---- warnings ----------------------------------------------------------

    @Test
    void aSchoolConflictMustBeAcknowledgedBeforeItCommits() {
        UUID cardId = cardWithPairing(9);
        // Find two same-school players sitting in different slots, and pair them.
        var pair = jdbc.query("""
            SELECT a.table_number, a.player_one, b.table_number, b.player_one
            FROM matches a JOIN matches b
              ON b.card_id = a.card_id AND b.game_number = a.game_number AND b.table_number > a.table_number
            JOIN players pa ON pa.card_id = a.card_id AND pa.code = a.player_one
            JOIN players pb ON pb.card_id = b.card_id AND pb.code = b.player_one
            WHERE a.card_id = ? AND a.game_number = 1 AND pa.school = pb.school
              AND a.player_two IS NOT NULL AND b.player_two IS NOT NULL
            LIMIT 1
            """, (rs, row) -> new int[] { rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4) }, cardId);
        org.junit.jupiter.api.Assumptions.assumeFalse(pair.isEmpty(), "needs two same-school seat-ones");
        int[] found = pair.get(0);

        var body = request(
            List.of(slot(1, found[0], id(cardId, found[1]), null)),
            List.of(slot(1, found[0], id(cardId, found[1]), id(cardId, found[3]))),
            List.of(), List.of(), List.of());

        var verdict = session.validate(cardId, body);
        assertThat(verdict.warnings()).extracting(CardDtos.PairingWarning::code).contains("SCHOOL_CONFLICT");
    }

    // ---- the dry run tells the truth ---------------------------------------

    @Test
    void validateAndCommitAgreeOnTheSameChangeSet() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        var body = request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of());

        var preview = session.validate(cardId, body);
        assertThat(preview.ok()).isTrue();
        assertThat(preview.changes()).singleElement()
            .satisfies(change -> {
                assertThat(change.beforeOne()).isEqualTo(held);
                assertThat(change.afterOne()).isNull();
            });
        assertThat(preview.consequences()).extracting(CardDtos.PairingConsequence::kind)
            .contains("BECOMES_BYE", "POOL_ADD");

        // The dry run wrote nothing.
        assertThat(pool.isEmpty(cardId)).isTrue();

        session.commit(cardId, body, ACTOR);
        assertThat(pool.openCodes(cardId)).containsExactly(slot[2]);
    }

    // ---- what the SSE delta gets to say (P3) -------------------------------

    /**
     * The commit reports which slots moved, so the delta can name them. Without this a subscriber
     * gets a bare version bump and neither the tool nor result entry can mark the affected rows.
     */
    @Test
    void commitReportsTheSlotsThatMoved() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);

        var outcome = session.commit(cardId, request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        assertThat(outcome.changedSlots()).singleElement()
            .satisfies(change -> {
                assertThat(change.table()).isEqualTo(slot[1]);
                assertThat(change.beforeOne()).isEqualTo(held);
                assertThat(change.afterOne()).isNull();
            });
    }

    /**
     * A replayed commit must broadcast NOTHING. It already applied, so an empty change set is the
     * honest answer — anything else would tell every other screen a second edit had happened.
     */
    @Test
    void aReplayReportsNoChangesToBroadcast() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        var body = new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", false,
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of());

        assertThat(session.commit(cardId, body, ACTOR).changedSlots()).hasSize(1);
        assertThat(session.commit(cardId, body, ACTOR).changedSlots())
            .as("the replay applied nothing, so it has nothing to announce")
            .isEmpty();
    }

    // ---- force commit (P4) --------------------------------------------------

    /** A recorded result stops an ordinary commit, and says so rather than failing obscurely. */
    @Test
    void aRecordedResultBlocksAnOrdinaryCommitAndNamesTheForceRoute() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(300, 200, false), ACTOR);

        var verdict = session.validate(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))),
            List.of(slot(1, slot[1], id(cardId, slot[2]), null)),
            List.of(), List.of(), List.of()));

        assertThat(verdict.blocks()).extracting(CardDtos.PairingBlock::code).contains("HAS_RESULT");
        assertThat(verdict.resultsToRemove()).singleElement()
            .satisfies(doomed -> {
                assertThat(doomed.table()).isEqualTo(slot[1]);
                assertThat(doomed.scoreOne()).isEqualTo(300);
                assertThat(doomed.submittedBy()).isEqualTo(ACTOR);
            });
        assertThat(verdict.forceAvailable())
            .as("an ordinary game result with nothing derived from it can be unwound")
            .isTrue();
    }

    /**
     * Force destroys the result, applies the change, and rebuilds standings — and the destroyed
     * result survives ONLY in the audit, which is why that row carries the whole thing.
     */
    @Test
    void forceDestroysTheResultAppliesTheChangeAndAuditsWhatItErased() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String one = id(cardId, slot[2]);
        String two = id(cardId, slot[3]);
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(300, 200, false), ACTOR);

        var forced = new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", true,
            List.of(slot(1, slot[1], one, two)), List.of(),
            List.of(new CardDtos.ScreenEntry(one, "NO_SHOW", null)), List.of(), List.of());
        session.commit(cardId, forced, "director01");

        var row = jdbc.queryForMap(
            "SELECT result_type, score_one, player_one, result_withdrawn_by FROM matches"
                + " WHERE card_id = ? AND game_number = 1 AND table_number = ?", cardId, slot[1]);
        assertThat(row.get("result_type")).as("the result is gone").isNull();
        assertThat(row.get("score_one")).isNull();
        assertThat(row.get("player_one")).as("and the staged screening applied").isNull();

        var audits = jdbc.queryForList("""
            SELECT old_value::text FROM audit_logs
            WHERE card_id = ? AND action = 'FORCE_REMOVE_RESULT'
            """, String.class, cardId);
        assertThat(audits).singleElement().satisfies(value -> assertThat(value)
            .contains("300").contains("200").contains(ACTOR).contains(one));
    }

    /** A result the audience had already seen is marked withdrawn, never silently vanished. */
    @Test
    void aDestroyedPublicResultIsMarkedWithdrawn() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String one = id(cardId, slot[2]);
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(300, 200, false), ACTOR);
        jdbc.update("UPDATE matches SET pairing_published_at = now() WHERE card_id = ? AND game_number = 1",
            cardId);
        long publicBefore = publicVersion(cardId);

        session.commit(cardId, new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", true,
            List.of(slot(1, slot[1], one, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(one, "NO_SHOW", null)), List.of(), List.of()), "director01");

        Boolean withdrawn = jdbc.queryForObject(
            "SELECT result_withdrawn_at IS NOT NULL FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Boolean.class, cardId, slot[1]);
        assertThat(withdrawn).as("a score cannot just disappear from a public scoreboard").isTrue();
        assertThat(publicVersion(cardId))
            .as("and the withdrawal has to reach the audience")
            .isGreaterThan(publicBefore);
    }

    /** Entering a replacement clears the marker: the row is an ordinary scored pairing again. */
    @Test
    void aReplacementResultClearsTheWithdrawnMarker() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String one = id(cardId, slot[2]);
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(300, 200, false), ACTOR);
        jdbc.update("UPDATE matches SET pairing_published_at = now() WHERE card_id = ? AND game_number = 1",
            cardId);
        session.commit(cardId, new CardDtos.PairingCommitRequest(UUID.randomUUID(), "x", true,
            List.of(slot(1, slot[1], one, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(one, "NO_SHOW", null)), List.of(), List.of()), "director01");

        // The slot is now a bye for the remaining player; staff score it normally.
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(0, 250, false), ACTOR);

        Boolean withdrawn = jdbc.queryForObject(
            "SELECT result_withdrawn_at IS NOT NULL FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Boolean.class, cardId, slot[1]);
        assertThat(withdrawn).isFalse();
    }

    /** Snapshot immutability is absolute: force may not touch a confirmed result. */
    @Test
    void forceCannotTouchASnapshottedResult() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        cards.submitResult(cardId, "g1t" + slot[1], new CardDtos.ResultRequest(300, 200, false), ACTOR);
        jdbc.update("""
            INSERT INTO pairing_snapshots (card_id, snapshot_no, game_from, game_to, confirmed_at)
            VALUES (?, 1, 1, 1, now())
            """, cardId);
        jdbc.update("UPDATE matches SET snapshot_no = 1 WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            cardId, slot[1]);

        assertThat(cards.unwindBlocker(cardId, 1, slot[1]))
            .as("a confirmed result is permanent — that is what makes published results trustworthy")
            .contains("snapshot");
    }

    /** ลงดาบ has its own withdrawal path; force must not become a second one. */
    @Test
    void forceCannotClearAPenaltyResult() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        jdbc.update("""
            UPDATE matches SET result_type = 'P', score_one = 0, score_two = 0, calculated_diff = 50,
                               submitted_by = ?, submitted_at = now()
            WHERE card_id = ? AND game_number = 1 AND table_number = ?
            """, ACTOR, cardId, slot[1]);

        assertThat(cards.unwindBlocker(cardId, 1, slot[1])).contains("ถอนดาบ");
    }

    // ---- I9: the audience never learns of a hold ---------------------------

    @Test
    void screeningAnUnpublishedPairingDoesNotBumpThePublicVersion() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        // Game 1 confirmed but not published to viewers yet.
        jdbc.update("UPDATE matches SET pairing_published_at = NULL WHERE card_id = ?", cardId);
        long before = publicVersion(cardId);

        session.commit(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(id(cardId, slot[2]), "NO_SHOW", null)),
            List.of(), List.of()), ACTOR);

        assertThat(publicVersion(cardId))
            .as("a hold on an unpublished pairing reaches nobody outside the back office")
            .isEqualTo(before);
    }

    @Test
    void theStaffCardCarriesThePoolAndThePublicProjectionDoesNot() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        session.commit(cardId, request(
            List.of(slot(1, slot[1], id(cardId, slot[2]), id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(id(cardId, slot[2]), "NO_SHOW", null)),
            List.of(), List.of()), ACTOR);

        var staff = cards.get(cardId, true);
        assertThat(staff.screeningPool()).hasSize(1);
        assertThat(PublicCardProjection.of(staff, 1L).screeningPool()).isEmpty();
    }

    // ---- audit -------------------------------------------------------------

    @Test
    void oneCommitWritesOneAuditRowCarryingBeforeAndAfter() {
        UUID cardId = cardWithPairing(8);
        int[] slot = fullSlot(cardId);
        String held = id(cardId, slot[2]);
        session.commit(cardId, request(
            List.of(slot(1, slot[1], held, id(cardId, slot[3]))), List.of(),
            List.of(new CardDtos.ScreenEntry(held, "NO_SHOW", null)), List.of(), List.of()), ACTOR);

        var rows = jdbc.queryForList("""
            SELECT new_value::text FROM audit_logs
            WHERE card_id = ? AND action = 'PAIRING_COMMIT'
            """, String.class, cardId);
        assertThat(rows).singleElement()
            .satisfies(value -> {
                assertThat(value).contains(held).contains("NO_SHOW").contains("commitKey");
                assertThat(value).contains("BECOMES_BYE");
            });
    }
}
