package com.ctwe.tournament.domain.pairing;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.stream.IntStream;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

class PairingStrategiesTest {
    private static final PairingStrategy.PairingContext CONTEXT = new PairingStrategy.PairingContext(2, List.of());

    @Test
    void kingOfTheHillPairsAdjacentPlayersAfterRankingByWinPointsAndDiff() {
        var players = List.of(
            score("D", 2, 10), score("B", 4, 20), score("A", 4, 40), score("C", 2, 30)
        );

        assertThat(new KingOfTheHillStrategy().generate(players, CONTEXT)).containsExactly(
            pair("A", "B"), pair("C", "D")
        );
    }

    @Test
    void pairingConsumesTheRankingOrderItIsGiven() {
        // Pairing no longer decides who is ahead. The ranking engine does, and hands the order in.
        var players = List.of(score("A", 4, 0), score("B", 4, 0), score("C", 4, 0), score("D", 4, 0));
        var context = rankedContext("C", "A", "D", "B");

        assertThat(new KingOfTheHillStrategy().generate(players, context)).containsExactly(
            pair("C", "A"), pair("D", "B")
        );
    }

    @Test
    void pairingNeverReRanksPlayersItWasHandedInOrder() {
        // Identical win points and diff, so any order pairing produced on its own would be its own
        // invention. It must follow the supplied ranking even where that contradicts player code.
        var players = List.of(score("1", 4, 0), score("2", 4, 0));
        assertThat(PairingStrategy.ranked(players, rankedContext("2", "1")).stream().map(PairingStrategy.PlayerScore::playerId))
            .containsExactly("2", "1");
    }

    @Test
    void aPlayerTheRankingDoesNotCoverSortsLastOnTheirCode() {
        // A field can legitimately contain someone with no standing yet; pairing must still work
        // rather than throwing, and must stay deterministic.
        var players = List.of(score("10", 0, 0), score("2", 0, 0), score("7", 4, 0));
        var context = rankedContext("7");

        assertThat(PairingStrategy.ranked(players, context).stream().map(PairingStrategy.PlayerScore::playerId))
            .containsExactly("7", "2", "10");
    }

    @Test
    void withoutAnyRankingPairingFallsBackToNumericPlayerCode() {
        var players = List.of(score("10", 4, 0), score("2", 4, 0), score("3", 4, 0));
        assertThat(PairingStrategy.ranked(players, CONTEXT).stream().map(PairingStrategy.PlayerScore::playerId))
            .containsExactly("2", "3", "10");
    }

    @Test
    void byeSelectionTakesTheLastPlayerInRankingOrder() {
        var players = List.of(score("A", 4, 0), score("B", 4, 0), score("C", 4, 0));
        assertThat(new KingOfTheHillStrategy().selectBye(players, rankedContext("C", "A", "B"))).isEqualTo("B");
    }

    @Test
    void swissPairsTopHalfAgainstBottomHalfInsideEachScoreGroup() {
        var players = List.of(
            score("D", 4, 10), score("B", 4, 30), score("H", 2, 10), score("F", 2, 30),
            score("A", 4, 40), score("C", 4, 20), score("E", 2, 40), score("G", 2, 20)
        );

        assertThat(new SwissStrategy().generate(players, CONTEXT)).containsExactly(
            pair("A", "C"), pair("B", "D"), pair("E", "G"), pair("F", "H")
        );
    }

    @Test
    void swissPullsBestRankedPlayerFromNextLowerGroupWhenUpperGroupIsOdd() {
        var players = List.of(
            score("A", 4, 30), score("B", 4, 20), score("C", 4, 10),
            score("D", 2, 50), score("E", 2, 40), score("F", 2, 30),
            score("G", 0, 20), score("H", 0, 10)
        );

        assertThat(new SwissStrategy().generate(players, CONTEXT)).containsExactly(
            pair("A", "C"), pair("B", "D"), pair("E", "F"), pair("G", "H")
        );
    }

    @Test
    void swissUsesCeilingHalfAndGivesTheMiddlePlayerAByeInAnOddFinalGroup() {
        var players = new java.util.ArrayList<PairingStrategy.PlayerScore>();
        for (int rank = 1; rank <= 16; rank++) players.add(score(String.valueOf(rank), 2, 100 - rank));
        for (int rank = 17; rank <= 31; rank++) players.add(score(String.valueOf(rank), 0, 100 - rank));
        var strategy = new SwissStrategy();

        String bye = strategy.selectBye(players, CONTEXT);
        players.removeIf(player -> player.playerId().equals(bye));
        var pairs = strategy.generate(players, CONTEXT);
        var finalGroupPairs = pairs.stream()
            .filter(current -> Integer.parseInt(current.playerOneId()) >= 17)
            .toList();

        assertThat(bye).isEqualTo("24");
        assertThat(finalGroupPairs).containsExactly(
            pair("17", "25"), pair("18", "26"), pair("19", "27"), pair("20", "28"),
            pair("21", "29"), pair("22", "30"), pair("23", "31")
        );
        assertThat(pairs).doesNotContain(pair("17", "24"));
    }

    @Test
    void swissOrdersInsideEachScoreGroupByTheRankingItIsGiven() {
        // The invariant this replaces is unchanged in spirit: Swiss consumes the order the standings
        // show. What changed is that the order now arrives from the ranking engine instead of being
        // recomputed here from win points, diff and the player's registration number.
        var players = List.of(
            score("8", 0, -350), score("7", 0, -350), score("6", 0, -350), score("5", 0, -350),
            score("4", 0, -350), score("3", 0, -350), score("2", 0, -350), score("1", 0, -350)
        );
        var context = rankedContext("8", "7", "6", "5", "4", "3", "2", "1");

        assertThat(new SwissStrategy().generate(players, context)).containsExactly(
            pair("8", "4"), pair("7", "3"), pair("6", "2"), pair("5", "1")
        );
    }

    @Test
    void swissStillGroupsByWinPointsEvenWhenRankingOrdersAcrossGroups() {
        // Score groups are a Swiss mechanic and are untouched: the ranking decides order WITHIN a
        // group, never whether a 4-point player may meet a 2-point one.
        var players = List.of(score("A", 4, 0), score("B", 4, 0), score("C", 2, 0), score("D", 2, 0));
        var context = rankedContext("A", "B", "C", "D");

        assertThat(new SwissStrategy().generate(players, context)).containsExactly(
            pair("A", "B"), pair("C", "D")
        );
    }

    @Test
    void randomPairingAvoidsSameSchoolAndSpreadsSchoolsAcrossFourSeatTables() {
        var players = List.of(
            score("A1", "A"), score("A2", "A"),
            score("B1", "B"), score("B2", "B"),
            score("C1", "C"), score("C2", "C"),
            score("D1", "D"), score("D2", "D")
        );
        var schools = players.stream().collect(Collectors.toMap(
            PairingStrategy.PlayerScore::playerId, PairingStrategy.PlayerScore::school));

        var pairs = SchoolAwarePairing.randomPairs(players, new Random(42));

        assertThat(pairs).hasSize(4);
        assertThat(pairs).allSatisfy(pair ->
            assertThat(schools.get(pair.playerOneId())).isNotEqualTo(schools.get(pair.playerTwoId())));
        for (int index = 0; index < pairs.size(); index += 2) {
            Set<String> tableSchools = Set.of(
                schools.get(pairs.get(index).playerOneId()),
                schools.get(pairs.get(index).playerTwoId()),
                schools.get(pairs.get(index + 1).playerOneId()),
                schools.get(pairs.get(index + 1).playerTwoId())
            );
            assertThat(tableSchools).hasSize(4);
        }
    }

    @Test
    void randomPairingUsesOnlyMinimumUnavoidableSameSchoolMatches() {
        var players = List.of(
            score("A1", "A"), score("A2", "A"), score("A3", "A"),
            score("A4", "A"), score("A5", "A"), score("A6", "A"),
            score("B1", "B"), score("B2", "B"), score("C1", "C"), score("C2", "C")
        );
        Map<String, String> schools = players.stream().collect(Collectors.toMap(
            PairingStrategy.PlayerScore::playerId, PairingStrategy.PlayerScore::school));

        var pairs = SchoolAwarePairing.randomPairs(players, new Random(7));
        long sameSchool = pairs.stream().filter(pair ->
            schools.get(pair.playerOneId()).equals(schools.get(pair.playerTwoId()))).count();

        assertThat(pairs).hasSize(5);
        assertThat(sameSchool).isEqualTo(1);
        assertThat(pairs.stream().flatMap(pair -> List.of(pair.playerOneId(), pair.playerTwoId()).stream()))
            .containsExactlyInAnyOrderElementsOf(players.stream().map(PairingStrategy.PlayerScore::playerId).toList());
    }

    @Test
    void randomPairingPlansElevenAndThirtyOnePlayerFieldsWithoutDroppingAnyone() {
        for (int fieldSize : List.of(11, 31)) {
            var field = new java.util.ArrayList<>(IntStream.rangeClosed(1, fieldSize)
                .mapToObj(index -> score("P" + index, "S" + (index % 8))).toList());
            var bye = field.remove(field.size() - 1);

            var pairs = SchoolAwarePairing.randomPairs(field, new Random(fieldSize));
            pairs = SchoolAwarePairing.orderForTables(pairs, field, new Random(fieldSize + 1), bye.playerId());

            assertThat(pairs).hasSize(fieldSize / 2);
            assertThat(pairs.stream().flatMap(pair -> List.of(pair.playerOneId(), pair.playerTwoId()).stream()))
                .containsExactlyInAnyOrderElementsOf(field.stream().map(PairingStrategy.PlayerScore::playerId).toList());
            assertThat(bye.playerId()).isNotIn(
                pairs.stream().flatMap(pair -> List.of(pair.playerOneId(), pair.playerTwoId()).stream()).toList());
        }
    }

    /** A context carrying an explicit ranked order, as the ranking engine would supply it. */
    private static PairingStrategy.PairingContext rankedContext(String... playerIdsInOrder) {
        Map<String, Integer> order = new java.util.LinkedHashMap<>();
        for (int index = 0; index < playerIdsInOrder.length; index++) order.put(playerIdsInOrder[index], index);
        return new PairingStrategy.PairingContext(2, List.of(), order);
    }

    private static PairingStrategy.PlayerScore score(String id, int winPoints, int diff) {
        return new PairingStrategy.PlayerScore(id, "school", winPoints, diff);
    }

    private static PairingStrategy.PlayerScore score(String id, String school) {
        return new PairingStrategy.PlayerScore(id, school, 0, 0);
    }

    private static PairingStrategy.Pair pair(String one, String two) {
        return new PairingStrategy.Pair(one, two);
    }
}
