package com.ctwe.tournament.domain.pairing;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Gibsonization analysis — decides which players have CLINCHED a top-K finish (guaranteed champion or
 * guaranteed to qualify for the final) given only the remaining regular games.
 *
 * <p>Scoring model: standings rank by (winPoints, diff). Per remaining game a player gains at most 2
 * winPoints (a win) and at most that game's max-diff of spread; at worst 0 winPoints and minus that
 * spread (a capped loss). Over the remaining games (count R, total max-diff D) a player's reachable
 * window is therefore:
 * <pre>  best  = (wp + 2R, diff + D)      worst = (wp, diff - D)  </pre>
 * Both extremes are individually achievable (win/lose every remaining game by the cap), so they are
 * tight bounds on that player's possible final standing.
 *
 * <p>Player X has clinched a top-K place iff fewer than K OTHER players can still reach X's worst case
 * (i.e. their best is >= X's worst, lexicographically). If at most K-1 others can possibly catch X, then
 * X finishes no lower than position K in every outcome — a sound proof that never yields a false
 * positive (we never Gibsonize unless mathematically guaranteed). Symmetrically, a player is eliminated
 * (out of contention) when at least K players' worst case already beats that player's best case.
 *
 * <p>Pure (no I/O) so it can be brute-force verified in isolation.
 */
public final class GibsonAnalysis {
    public record PlayerStanding(String playerId, long winPoints, long diff) {}
    public record Result(Set<String> gibsonized, Set<String> eliminated, List<String> proof) {}

    private GibsonAnalysis() {}

    /**
     * @param players      current standings of all active players
     * @param remainingGames R — regular games still to be played, INCLUDING the one being paired
     * @param maxDiffSum   D — sum of max_diff over those remaining games
     * @param qualifyCut   K — number of places that "qualify" (1 = champion only; 2/4 with a final round)
     */
    public static Result analyze(List<PlayerStanding> players, int remainingGames, long maxDiffSum, int qualifyCut) {
        int n = players.size();
        long[] bestWp = new long[n], bestDiff = new long[n], worstWp = new long[n], worstDiff = new long[n];
        for (int i = 0; i < n; i++) {
            PlayerStanding p = players.get(i);
            bestWp[i] = p.winPoints() + 2L * remainingGames;
            bestDiff[i] = p.diff() + maxDiffSum;
            worstWp[i] = p.winPoints();
            worstDiff[i] = p.diff() - maxDiffSum;
        }

        Set<String> gibsonized = new LinkedHashSet<>();
        Set<String> eliminated = new LinkedHashSet<>();
        List<String> proof = new ArrayList<>();

        for (int i = 0; i < n; i++) {
            PlayerStanding p = players.get(i);
            int canStillReach = 0;   // other players whose BEST can still reach this player's WORST
            int guaranteedAhead = 0; // other players whose WORST already beats this player's BEST
            for (int j = 0; j < n; j++) {
                if (j == i) continue;
                if (cmp(bestWp[j], bestDiff[j], worstWp[i], worstDiff[i]) >= 0) canStillReach++;
                if (cmp(worstWp[j], worstDiff[j], bestWp[i], bestDiff[i]) > 0) guaranteedAhead++;
            }
            if (canStillReach < qualifyCut) {
                gibsonized.add(p.playerId());
                proof.add("CLINCHED top-" + qualifyCut + ": player " + p.playerId() + " worst-case after "
                    + remainingGames + " game(s) = (WP " + worstWp[i] + ", diff " + worstDiff[i] + "); only "
                    + canStillReach + " other player(s) can still reach it (need < " + qualifyCut + ").");
            }
            if (guaranteedAhead >= qualifyCut) eliminated.add(p.playerId());
        }
        return new Result(gibsonized, eliminated, proof);
    }

    /** Lexicographic compare of a standing (winPoints first, then diff); positive => a ranks ahead of b. */
    private static int cmp(long wpA, long diffA, long wpB, long diffB) {
        return wpA != wpB ? Long.compare(wpA, wpB) : Long.compare(diffA, diffB);
    }
}
