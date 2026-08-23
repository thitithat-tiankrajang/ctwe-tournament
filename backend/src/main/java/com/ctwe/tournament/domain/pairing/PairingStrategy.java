package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.ranking.PlayerCodes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * How a game's matchups are chosen.
 *
 * <p><b>Pairing consumes a ranking; it never computes one.</b> The order comes in through
 * {@link PairingContext#rankOrder()}, produced by the ranking engine from the same rule the
 * standings display. Strategies used to carry their own comparators — two of them, which disagreed
 * with each other and with the screen — and that is what made pairing look wrong when players tied.
 */
public interface PairingStrategy {
    PairingRuleType type();
    List<Pair> generate(List<PlayerScore> players, PairingContext context);

    /** Select the player removed as a bye before generating an odd-sized field. */
    default String selectBye(List<PlayerScore> players, PairingContext context) {
        List<PlayerScore> ranked = ranked(players, context);
        return ranked.isEmpty() ? null : ranked.get(ranked.size() - 1).playerId();
    }

    /**
     * The players in ranking order.
     *
     * <p>A player the ranking did not cover sorts last on their code rather than throwing — a field
     * can legitimately contain someone with no standing yet (game 1), and pairing must still work.
     */
    static List<PlayerScore> ranked(List<PlayerScore> players, PairingContext context) {
        PairingContext safeContext = context == null ? new PairingContext(0, List.of()) : context;
        List<PlayerScore> result = new ArrayList<>(players);
        result.sort(Comparator
            .comparingInt((PlayerScore player) -> safeContext.rankOf(player.playerId()))
            .thenComparing(PlayerScore::playerId, PlayerCodes::compare));
        return List.copyOf(result);
    }

    /** Numeric player-code ordering. One implementation, shared with the ranking engine. */
    static int comparePlayerCode(String first, String second) {
        return PlayerCodes.compare(first, second);
    }

    record PlayerScore(String playerId, String school, int winPoints, int diff) {}

    record Pair(String playerOneId, String playerTwoId) {}

    /**
     * @param rankOrder player code → position in the internal total order the ranking engine
     *                  produced. Empty only where no ranking exists yet, in which case every
     *                  strategy falls back to player-code order.
     */
    record PairingContext(int gameNumber, List<Pair> previousMatches, Map<String, Integer> rankOrder) {
        public PairingContext {
            previousMatches = previousMatches == null ? List.of() : List.copyOf(previousMatches);
            rankOrder = rankOrder == null ? Map.of() : Map.copyOf(rankOrder);
        }

        public PairingContext(int gameNumber, List<Pair> previousMatches) {
            this(gameNumber, previousMatches, Map.of());
        }

        /** Position in the ranked order; unranked players sort last. */
        public int rankOf(String playerId) {
            return rankOrder.getOrDefault(playerId, Integer.MAX_VALUE);
        }

        public boolean alreadyPlayed(String first, String second) {
            return previousMatches.stream().anyMatch(pair ->
                (pair.playerOneId().equals(first) && pair.playerTwoId().equals(second)) ||
                (pair.playerOneId().equals(second) && pair.playerTwoId().equals(first)));
        }
    }
}
