package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import java.util.List;

public interface PairingStrategy {
    PairingRuleType type();
    List<Pair> generate(List<PlayerScore> players, PairingContext context);

    record PlayerScore(String playerId, String school, int winPoints, int diff) {}
    record Pair(String playerOneId, String playerTwoId) {}
    record PairingContext(int gameNumber, List<Pair> previousMatches) {
        public boolean alreadyPlayed(String first, String second) {
            return previousMatches.stream().anyMatch(pair ->
                (pair.playerOneId().equals(first) && pair.playerTwoId().equals(second)) ||
                (pair.playerOneId().equals(second) && pair.playerTwoId().equals(first)));
        }
    }
}
