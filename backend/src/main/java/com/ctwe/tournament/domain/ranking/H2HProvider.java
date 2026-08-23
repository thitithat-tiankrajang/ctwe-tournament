package com.ctwe.tournament.domain.ranking;

/**
 * Head-to-head, resolved on demand.
 *
 * The engine asks about a pair only when that pair is adjacent in the current order AND the player
 * above has a strictly higher Average Score — i.e. only when the answer could actually move someone.
 * {@link #hasMet} exists so the overwhelmingly common "these two never played" case costs a set
 * lookup instead of an aggregation, which is what keeps a tournament-wide matrix from being built.
 */
public interface H2HProvider {

    /** Aggregate outcome of every qualifying meeting between two players. */
    enum Verdict { BETTER, TIED, WORSE }

    /** Have these two met in a qualifying game? A penalty is not a game and never counts here. */
    boolean hasMet(String playerId, String opponentId);

    /**
     * Aggregate of ALL their meetings: wins, then aggregate Diff, then aggregate points scored.
     * A draw is a win for neither. All three level means neither beat the other.
     */
    Verdict verdict(String playerId, String opponentId);

    /** Answers "never met" to everything — for fields with no match history. */
    H2HProvider NONE = new H2HProvider() {
        public boolean hasMet(String playerId, String opponentId) { return false; }
        public Verdict verdict(String playerId, String opponentId) { return Verdict.TIED; }
    };
}
