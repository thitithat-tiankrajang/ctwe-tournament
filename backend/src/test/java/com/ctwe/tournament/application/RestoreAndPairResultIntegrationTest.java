package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.ranking.RankingEngine;
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
import org.springframework.test.context.bean.override.mockito.MockitoBean;

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

    /** Test-scoped: Web Push must not create/store VAPID keys, run its scheduled cleanup, or send. */
    @MockitoBean WebPushService webPush;

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    @Autowired TournamentCardService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired RankingSource rankingSource;

    /** A synthetic tournament inside the rolled-back test transaction: no reliance on existing data. */
    private UUID syntheticTournament() {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            id, "IT " + id, "it-" + id);
        return id;
    }

    private UUID tournamentId() {
        return syntheticTournament();
    }

    private UUID createCard(int games, PairingRuleType initial, List<PairingRuleType> edgeRules) {
        List<Integer> maxDiffs = new ArrayList<>();
        for (int i = 0; i < games; i++) maxDiffs.add(500);
        var request = new CardDtos.CreateCardRequest(tournamentId(), "IT-" + UUID.randomUUID(), "DIV",
            games, edgeRules, maxDiffs, "NONE", 0, false, initial, null);
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

    // ---- Owner rule: historical correction EDITS the published result and preserves its pairing ----
    @Test
    void historicalOverrideEditsThePublishedResultAndLeavesItsPairingIntact() {
        UUID cardId = createCard(3, PairingRuleType.RANDOM,
            List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(cardId, 6);
        service.finishRegistration(cardId, "ittest");
        runGame(cardId);                                   // game 1 published
        runGame(cardId);                                   // game 2 published — tournament has moved on

        record Slot(int table, int one, int two, int scoreOne, int scoreTwo) {}
        List<Slot> before = jdbc.query("""
            SELECT table_number, player_one, player_two, score_one, score_two FROM matches
            WHERE card_id = ? AND game_number = 1 ORDER BY table_number
            """, (rs, row) -> new Slot(rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getInt(5)), cardId);
        Slot target = before.get(0);
        Integer diffBefore = jdbc.queryForObject(
            "SELECT diff FROM standings WHERE card_id = ? AND player_code = ?", Integer.class, cardId, target.one());

        // Backdate the snapshot so the correction below genuinely MOVES confirmed_at. Without
        // this the test cannot fail: now() is the transaction clock, publish and correction
        // share this transaction, so the re-stamp would write the value already stored, the
        // immutability trigger would see no change, and a correction that is impossible on a
        // live card would pass here. On a real card the two are separate transactions.
        jdbc.execute("SET LOCAL app.allow_snapshot_restamp = 'on'");
        jdbc.update("""
            UPDATE pairing_snapshots SET confirmed_at = confirmed_at - interval '1 hour'
            WHERE card_id = ? AND game_from <= 1 AND game_to >= 1
            """, cardId);
        // RESET, not SET LOCAL's own scope: the flag would otherwise stay on for the rest of
        // this transaction and exempt the override's re-stamp too, so the guard could never fail.
        jdbc.execute("RESET app.allow_snapshot_restamp");
        var confirmedBefore = jdbc.queryForObject("""
            SELECT confirmed_at FROM pairing_snapshots WHERE card_id = ? AND game_from <= 1 AND game_to >= 1
            """, java.time.Instant.class, cardId);

        // Director corrects a PUBLISHED game-1 result, long after game 2 was published.
        service.overrideResult(cardId, "g1t" + target.table(),
            new CardDtos.ResultRequest(target.scoreOne() + 40, target.scoreTwo(), true), "ittest");

        List<Slot> after = jdbc.query("""
            SELECT table_number, player_one, player_two, score_one, score_two FROM matches
            WHERE card_id = ? AND game_number = 1 ORDER BY table_number
            """, (rs, row) -> new Slot(rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getInt(5)), cardId);

        assertThat(after).as("the historical pairing is preserved, not regenerated")
            .extracting(Slot::table, Slot::one, Slot::two)
            .isEqualTo(before.stream().map(slot -> org.assertj.core.groups.Tuple.tuple(
                slot.table(), slot.one(), slot.two())).toList());
        assertThat(after.get(0).scoreOne()).as("the result is edited, not deleted")
            .isEqualTo(target.scoreOne() + 40);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 1 AND result_type IS NULL
            """, Integer.class, cardId)).as("no published row lost its result").isZero();

        Integer diffAfter = jdbc.queryForObject(
            "SELECT diff FROM standings WHERE card_id = ? AND player_code = ?", Integer.class, cardId, target.one());
        assertThat(diffAfter).as("standings recomputed forward through the current state").isNotEqualTo(diffBefore);

        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_logs WHERE card_id = ? AND action = 'OVERRIDE_RESULT'
            """, Integer.class, cardId)).as("the correction is audited").isEqualTo(1);

        var confirmedAfter = jdbc.queryForObject("""
            SELECT confirmed_at FROM pairing_snapshots WHERE card_id = ? AND game_from <= 1 AND game_to >= 1
            """, java.time.Instant.class, cardId);
        assertThat(confirmedAfter)
            .as("a corrected game carries a fresh publication time, which the trigger must allow")
            .isAfter(confirmedBefore);
    }

    // ---- Owner-confirmed rule: a no-opponent slot keeps the differential its entered score produces ----
    @Test
    void noOpponentSlotKeepsTheEnteredScoreDifferential() {
        // Owner fixture: configured maximum 250, the occupied player is entered at 100, the empty
        // seat is 0, so the differential is the ordinary +100 — the system must not overrule it.
        List<Integer> maxDiffs = List.of(250, 250);
        var request = new CardDtos.CreateCardRequest(tournamentId(), "IT-" + UUID.randomUUID(), "DIV",
            2, List.of(PairingRuleType.SWISS), maxDiffs, "NONE", 0, false, PairingRuleType.RANDOM, null);
        UUID cardId = service.create(request, "ittest").id();
        addPlayers(cardId, 5);                     // odd field -> exactly one no-opponent slot
        service.finishRegistration(cardId, "ittest");
        service.generatePairingPreview(cardId, "ittest");
        service.confirmPairingPreview(cardId, "ittest");

        var bye = jdbc.queryForMap("""
            SELECT table_number, player_one, player_two FROM matches
            WHERE card_id = ? AND game_number = 1 AND (player_one IS NULL OR player_two IS NULL)
            """, cardId);
        int table = (Integer) bye.get("table_number");
        boolean occupiedIsOne = bye.get("player_one") != null;

        service.submitResult(cardId, "g1t" + table,
            new CardDtos.ResultRequest(occupiedIsOne ? 100 : 0, occupiedIsOne ? 0 : 100, false), "ittest");

        var stored = jdbc.queryForMap("""
            SELECT score_one, score_two, calculated_diff, winner, result_type FROM matches
            WHERE card_id = ? AND game_number = 1 AND table_number = ?
            """, cardId, table);
        assertThat(stored.get("result_type")).isEqualTo("W");
        assertThat(stored.get("calculated_diff")).as("no-opponent differential follows the entered score").isEqualTo(100);
        assertThat(stored.get("winner")).isEqualTo(occupiedIsOne ? bye.get("player_one") : bye.get("player_two"));
        assertThat(stored.get(occupiedIsOne ? "score_one" : "score_two")).isEqualTo(100);
        assertThat(stored.get(occupiedIsOne ? "score_two" : "score_one")).as("empty seat scores zero").isEqualTo(0);
    }

    /**
     * Owner decision 1, the other half: having proved the stored differential follows the entered
     * score, prove that NOTHING downstream re-learns that the row was a bye. The four ranking
     * dimensions are read here from the production sources — {@code standings} for win points and
     * differential, {@link RankingSource} for the scoreFor/games the average is built from, and the
     * live head-to-head provider for the one dimension a lone player genuinely cannot enter.
     */
    @Test
    void noOpponentSlotFeedsTheRankingDimensionsLikeAnyOtherRow() {
        var request = new CardDtos.CreateCardRequest(tournamentId(), "IT-" + UUID.randomUUID(), "DIV",
            2, List.of(PairingRuleType.SWISS), List.of(250, 250), "NONE", 0, false, PairingRuleType.RANDOM, null);
        UUID cardId = service.create(request, "ittest").id();
        addPlayers(cardId, 5);                     // odd field -> exactly one no-opponent slot
        service.finishRegistration(cardId, "ittest");
        service.generatePairingPreview(cardId, "ittest");
        service.confirmPairingPreview(cardId, "ittest");

        record Slot(int table, Integer one, Integer two) {}
        List<Slot> slots = jdbc.query("""
            SELECT table_number, player_one, player_two FROM matches
            WHERE card_id = ? AND game_number = 1 ORDER BY table_number
            """, (rs, row) -> new Slot(rs.getInt(1), (Integer) rs.getObject(2), (Integer) rs.getObject(3)), cardId);
        Slot bye = slots.stream().filter(slot -> slot.one() == null || slot.two() == null).findFirst().orElseThrow();
        boolean occupiedIsOne = bye.one() != null;
        int lone = occupiedIsOne ? bye.one() : bye.two();

        service.submitResult(cardId, "g1t" + bye.table(),
            new CardDtos.ResultRequest(occupiedIsOne ? 100 : 0, occupiedIsOne ? 0 : 100, false), "ittest");
        for (Slot slot : slots)
            if (slot != bye) service.submitResult(cardId, "g1t" + slot.table(),
                new CardDtos.ResultRequest(400, 380, false), "ittest");
        service.reviewResults(cardId, "ittest");
        service.publishResults(cardId, "ittest");

        var standing = jdbc.queryForMap(
            "SELECT wins, win_points, diff FROM standings WHERE card_id = ? AND player_code = ?", cardId, lone);
        var row = rankingSource.rankRows(cardId).stream()
            .filter(entry -> entry.playerId().equals(String.valueOf(lone))).findFirst().orElseThrow();

        assertThat(standing.get("wins")).as("dimension 1 — the lone player wins the slot").isEqualTo(1);
        assertThat(standing.get("win_points")).as("dimension 1 — an ordinary win, worth 2").isEqualTo(2);
        assertThat(standing.get("diff")).as("dimension 2 — the ordinary margin, 100 - 0").isEqualTo(100);
        assertThat(rankingSource.headToHead(cardId).hasMet(String.valueOf(lone), String.valueOf(
            slots.stream().filter(slot -> slot != bye).findFirst().orElseThrow().one())))
            .as("dimension 3 — an empty seat is not an opponent, so there is no meeting to aggregate")
            .isFalse();
        assertThat(row.scoreFor()).as("dimension 4 — the submitted score counts in full").isEqualTo(100L);
        assertThat(row.games()).as("dimension 4 — and the slot counts as a game played").isEqualTo(1);
        assertThat(row.diff()).as("the engine is fed the same differential the standings hold").isEqualTo(100);
    }

    /**
     * Owner-confirmed Average Score: every counted submitted score, whatever its sign.
     *
     * <p>A submitted 0 contributes 0 rather than being dropped, and a legal negative contributes
     * its sign. The field is even so the followed player is never alone — a no-opponent slot has
     * its own rule that the occupied player must win above zero, and
     * {@code noOpponentSlotFeedsTheRankingDimensionsLikeAnyOtherRow} covers that side.
     */
    @Test
    void averageScoreCountsEverySubmittedScoreIncludingZeroAndNegative() {
        var request = new CardDtos.CreateCardRequest(tournamentId(), "IT-" + UUID.randomUUID(), "DIV",
            3, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS), List.of(500, 500, 500),
            "NONE", 0, false, PairingRuleType.RANDOM, null);
        UUID cardId = service.create(request, "ittest").id();
        addPlayers(cardId, 6);                     // even field -> every player has an opponent
        service.finishRegistration(cardId, "ittest");

        int[] mine = { 45, 0, -3 };                // positive, zero, negative
        int followed = 0;

        for (int game = 1; game <= 3; game++) {
            service.generatePairingPreview(cardId, "ittest");
            service.confirmPairingPreview(cardId, "ittest");
            record Slot(int table, int one, int two) {}
            List<Slot> slots = jdbc.query("""
                SELECT table_number, player_one, player_two FROM matches
                WHERE card_id = ? AND game_number = ? ORDER BY table_number
                """, (rs, row) -> new Slot(rs.getInt(1), rs.getInt(2), rs.getInt(3)), cardId, game);
            if (followed == 0) followed = slots.get(0).one();

            for (Slot slot : slots) {
                boolean mineIsOne = slot.one() == followed;
                boolean isMine = mineIsOne || slot.two() == followed;
                if (!isMine) {
                    service.submitResult(cardId, "g" + game + "t" + slot.table(),
                        new CardDtos.ResultRequest(300, 280, false), "ittest");
                    continue;
                }
                int myScore = mine[game - 1];
                int theirScore = myScore + 10;     // the opponent wins; only my score is under test
                service.submitResult(cardId, "g" + game + "t" + slot.table(),
                    new CardDtos.ResultRequest(mineIsOne ? myScore : theirScore,
                        mineIsOne ? theirScore : myScore, false), "ittest");
            }
            service.reviewResults(cardId, "ittest");
            service.publishResults(cardId, "ittest");
        }

        String code = String.valueOf(followed);
        var row = rankingSource.rankRows(cardId).stream()
            .filter(entry -> entry.playerId().equals(code)).findFirst().orElseThrow();
        assertThat(row.games()).as("the zero-scoring game is still a game").isEqualTo(3);
        assertThat(row.scoreFor()).as("45 + 0 + (-3)").isEqualTo(42L);
        assertThat(RankingEngine.averageScore(row.scoreFor(), row.games())).isEqualTo(14.0);
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

    @Test
    void pairedGamesExposeLiveScoresOnlyAfterTheirOwnPairingIsPublished() {
        UUID cardId = createCard(4, PairingRuleType.RANDOM,
            List.of(PairingRuleType.SWISS, PairingRuleType.SWISS, PairingRuleType.PAIR_RESULT));
        addPlayers(cardId, 8);
        service.finishRegistration(cardId, "ittest");
        runGame(cardId);
        runGame(cardId);

        service.generatePairingPreview(cardId, "ittest");
        service.confirmPairingPreview(cardId, "ittest");
        assertThatThrownBy(() -> service.publishPairResultDestination(cardId, "ittest"))
            .isInstanceOf(IllegalArgumentException.class);
        int sourceTables = jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 3", Integer.class, cardId);
        long beforeSave = publicCard(cardId).version();
        for (int table = 1; table <= sourceTables; table++)
            service.submitResult(cardId, "g3t" + table, new CardDtos.ResultRequest(100, 72, false), "ittest");

        var visibleSource = publicCard(cardId);
        assertThat(visibleSource.version()).isEqualTo(beforeSave + sourceTables);
        var sourceOnly = visibleSource.snapshots().stream().filter(s -> s.confirmedAt().isBlank()).findFirst().orElseThrow();
        assertThat(sourceOnly.gameNumbers()).containsExactly(3);
        assertThat(sourceOnly.pairings()).allSatisfy(row -> assertThat(row.scoreOne()).isEqualTo(100));

        var privateSave = service.submitResult(cardId, "g4t3", new CardDtos.ResultRequest(90, 80, false), "ittest");
        assertThat(privateSave.publicVersion()).isNull();
        var afterPrivateSave = publicCard(cardId);
        assertThat(afterPrivateSave.version()).isEqualTo(visibleSource.version());
        assertThat(afterPrivateSave.snapshots()).isEqualTo(visibleSource.snapshots());

        // The open block can include an empty destination placeholder.
        jdbc.update("INSERT INTO matches (card_id, game_number, table_number) VALUES (?, 4, 100)", cardId);
        service.publishPairResultDestination(cardId, "ittest");
        assertThatThrownBy(() -> service.publishPairResultDestination(cardId, "ittest"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(currentGame(cardId)).isEqualTo(3);
        var publicBlock = publicCard(cardId).snapshots().stream()
            .filter(snapshot -> snapshot.confirmedAt().isBlank()).findFirst().orElseThrow();
        assertThat(publicBlock.gameNumbers()).containsExactly(3, 4);
        assertThat(publicBlock.pairings()).allSatisfy(pairing -> {
            assertThat(pairing.pairingPublished()).isTrue();
            assertThat(pairing.pairingPublishedAt()).isNotBlank();
            assertThat(pairing.tableNumber()).isNotEqualTo(100);
        });
        assertThat(publicBlock.pairings()).anySatisfy(row -> {
            assertThat(row.id()).isEqualTo("g4t3");
            assertThat(row.scoreOne()).isEqualTo(90);
        });

        var patch = service.submitResult(cardId, "g3t1", new CardDtos.ResultRequest(110, 72, true), "ittest");
        assertThat(patch.changedPairings()).anySatisfy(pair -> assertThat(pair.scoreOne()).isEqualTo(110));
        var afterEdit = publicCard(cardId);
        assertThat(patch.publicVersion()).isEqualTo(afterEdit.version());
        assertThat(patch.publicPairingsChanged()).isTrue();
        assertThat(afterEdit.snapshots().stream().filter(s -> s.confirmedAt().isBlank())
            .flatMap(s -> s.pairings().stream())).anySatisfy(row -> {
                assertThat(row.id()).isEqualTo("g3t1");
                assertThat(row.scoreOne()).isEqualTo(110);
            });
        service.autoResults(cardId, "ittest");
        service.reviewResults(cardId, "ittest");
        service.publishResults(cardId, "ittest");
        var published = service.get(cardId, false);
        var snapshot = published.snapshots().stream().filter(item -> item.gameNumbers().contains(3)).findFirst().orElseThrow();
        assertThat(snapshot.gameNumbers()).containsExactly(3, 4);
        assertThat(snapshot.confirmedAt()).isNotBlank();
        assertThat(snapshot.pairings()).allSatisfy(pairing -> assertThat(pairing.resultType()).isNotNull());
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 4 AND table_number = 100", Long.class, cardId)).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM tournament_cards WHERE id = ?", String.class, cardId)).isEqualTo("FINISHED");
    }

    private CardDtos.CardResponse publicCard(UUID cardId) {
        long version = jdbc.queryForObject("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, cardId);
        return PublicCardProjection.of(service.get(cardId, false), version);
    }

    @Test
    void voidLastSlotDoesNotDropThePreviousTableFromTheSixPlayerSwissTail() {
        UUID id = startPairedBlock(7);
        var bye = gamePairs(id, 1).get(3);
        String byePlayer = bye.playerOneId() != null ? bye.playerOneId() : bye.playerTwoId();
        int code = Integer.parseInt(byePlayer.substring(1));
        jdbc.update("UPDATE players SET terminated_at = now(), withdrawn_from_game = 1 WHERE card_id = ? AND code = ?", id, code);
        jdbc.update("UPDATE matches SET player_one = NULL, player_two = NULL, voided_at = now(), voided_by = 'ittest' "
            + "WHERE card_id = ? AND game_number = 1 AND table_number = 4", id);

        scoreSource(id, 1, 500, 400, false);
        scoreSource(id, 2, 600, 550, false);
        scoreSource(id, 3, 450, 440, false);
        assertThat(entrants(id, 2)).containsExactlyInAnyOrderElementsOf(entrants(id, 1));
        var initial = gamePairs(id, 2);

        service.publishPairResultDestination(id, "ittest");
        scoreSource(id, 3, 440, 450, true);
        assertThat(gamePairs(id, 2).stream().map(p -> java.util.Arrays.asList(p.playerOneId(), p.playerTwoId())).toList())
            .isNotEqualTo(initial.stream().map(p -> java.util.Arrays.asList(p.playerOneId(), p.playerTwoId())).toList());
        assertThat(entrants(id, 2)).containsExactlyInAnyOrderElementsOf(entrants(id, 1));

        service.applyPenalty(id, "g1t3", 100, "ittest");
        assertThat(entrants(id, 2)).containsExactlyInAnyOrderElementsOf(entrants(id, 1));
        service.revokePenalty(id, "g1t3", "ittest");
        assertThat(entrants(id, 2)).isEmpty();
        scoreSource(id, 3, 440, 450, false);
        assertThat(entrants(id, 2)).containsExactlyInAnyOrderElementsOf(entrants(id, 1));
    }

    @Test
    void fivePlayerTailSeatsFiveExactlyOnceAndKeepsOneBye() {
        UUID id = startPairedBlock(5);
        scoreSource(id, 3, 430, 0, false);
        scoreSource(id, 2, 500, 450, false);
        assertThat(entrants(id, 2)).isEmpty();
        scoreSource(id, 1, 510, 440, false);
        assertThat(entrants(id, 2)).containsExactlyInAnyOrderElementsOf(entrants(id, 1));
        assertThat(gamePairs(id, 2).stream().filter(p -> (p.playerOneId() == null) ^ (p.playerTwoId() == null))).hasSize(1);
    }

    @Test
    void threePlayerTailPairsTheByeAgainstTheWinnerAndGivesTheLoserABye() {
        UUID id = startPairedBlock(7);
        var source = gamePairs(id, 1);
        scoreSource(id, 4, 430, 0, false);
        scoreSource(id, 3, 510, 450, false);
        var tail = gamePairs(id, 2).stream().filter(pair -> pair.tableNumber() >= 3).toList();
        assertThat(tail).hasSize(2);
        assertThat(tail.get(0).playerOneId()).isEqualTo(source.get(2).playerOneId());
        assertThat(tail.get(0).playerTwoId()).isEqualTo(source.get(3).playerOneId());
        assertThat(tail.get(1).playerOneId()).isEqualTo(source.get(2).playerTwoId());
        assertThat(tail.get(1).playerTwoId()).isNull();
    }

    @Test
    void correctingSourceWinnerDoesNotDuplicateTheRemainingPlayerAfterWithdrawal() {
        UUID id = startPairedBlock(4);
        var source = gamePairs(id, 1);
        String withdrawn = source.get(0).playerTwoId();
        scoreSource(id, 1, 510, 450, false);
        scoreSource(id, 2, 530, 460, false);
        service.publishPairResultDestination(id, "ittest");
        service.terminatePlayers(id, List.of(withdrawn), 2, "ittest");

        scoreSource(id, 1, 450, 510, true);

        var dest = gamePairs(id, 2);
        assertThat(dest.get(0).playerOneId()).isNull();
        assertThat(dest.get(0).playerTwoId()).isEqualTo(source.get(1).playerOneId());
        assertThat(dest.get(1).playerOneId()).isEqualTo(source.get(0).playerOneId());
        assertThat(dest.get(1).playerTwoId()).isEqualTo(source.get(1).playerTwoId());
        assertThat(entrants(id, 2)).containsExactlyInAnyOrderElementsOf(
            entrants(id, 1).stream().filter(player -> !player.equals(withdrawn)).toList());
        service.autoResults(id, "ittest");
        service.reviewResults(id, "ittest");
        service.publishResults(id, "ittest");
    }

    @Test
    void correctingSourceWinnerClearsAnObsoleteRedirectFromTheStaffPatch() {
        UUID id = startPairedBlock(4);
        var source = gamePairs(id, 1);
        scoreSource(id, 1, 510, 450, false);
        service.forceBye(id, "g2t1", source.get(0).playerOneId(), 100, "ittest");
        scoreSource(id, 2, 530, 460, false);
        service.publishPairResultDestination(id, "ittest");
        service.terminatePlayers(id, List.of(source.get(1).playerTwoId()), 2, "ittest");

        var patch = service.submitResult(id, "g1t2", new CardDtos.ResultRequest(460, 530, true), "ittest");

        assertThat(patch.changedPairings()).anySatisfy(pair -> {
            assertThat(pair.id()).isEqualTo("g2t3");
            assertThat(pair.playerOneId()).isNull();
            assertThat(pair.playerTwoId()).isNull();
        });
        assertThat(entrants(id, 2)).containsExactlyInAnyOrder(source.get(0).playerOneId(),
            source.get(0).playerTwoId(), source.get(1).playerOneId());
        assertThat(gamePairs(id, 2).get(0).scoreOne()).isEqualTo(100);
    }

    private UUID startPairedBlock(int players) {
        UUID id = createCard(2, PairingRuleType.RANDOM, List.of(PairingRuleType.PAIR_RESULT));
        addPlayers(id, players);
        service.finishRegistration(id, "ittest");
        service.generatePairingPreview(id, "ittest");
        service.confirmPairingPreview(id, "ittest");
        return id;
    }

    private List<CardDtos.PairingResponse> gamePairs(UUID cardId, int game) {
        return service.get(cardId, true).snapshots().stream().flatMap(s -> s.pairings().stream())
            .filter(row -> row.gameNumber() == game).toList();
    }

    private List<String> entrants(UUID id, int game) {
        return gamePairs(id, game).stream().flatMap(row -> java.util.stream.Stream.of(row.playerOneId(), row.playerTwoId()))
            .filter(java.util.Objects::nonNull).toList();
    }

    private void scoreSource(UUID id, int table, int one, int two, boolean editing) {
        service.submitResult(id, "g1t" + table, new CardDtos.ResultRequest(one, two, editing), "ittest");
    }
}
