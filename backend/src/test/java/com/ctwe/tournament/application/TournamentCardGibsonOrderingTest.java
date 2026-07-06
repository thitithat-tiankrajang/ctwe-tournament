package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.pairing.PairingStrategy;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class TournamentCardGibsonOrderingTest {
    @Test
    void movesEveryGibsonPairToTheEndAndPlacesClinchedPlayerInFinalSeat() {
        var pairs = List.of(
            new PairingStrategy.Pair("1", "9"),
            new PairingStrategy.Pair("2", "3"),
            new PairingStrategy.Pair("8", "5"),
            new PairingStrategy.Pair("4", "6")
        );

        var ordered = TournamentCardService.moveGibsonPairsLast(pairs, Set.of("1", "5"));

        assertThat(ordered).containsExactly(
            new PairingStrategy.Pair("2", "3"),
            new PairingStrategy.Pair("4", "6"),
            new PairingStrategy.Pair("9", "1"),
            new PairingStrategy.Pair("8", "5")
        );
    }

    @Test
    void leavesRegularPairingOrderUntouched() {
        var pairs = List.of(
            new PairingStrategy.Pair("1", "2"),
            new PairingStrategy.Pair("3", "4")
        );

        assertThat(TournamentCardService.moveGibsonPairsLast(pairs, Set.of()))
            .isSameAs(pairs);
    }
}
