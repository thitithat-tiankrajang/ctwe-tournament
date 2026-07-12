package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public interface PairingStrategy {
    PairingRuleType type();
    List<Pair> generate(List<PlayerScore> players, PairingContext context);

    static List<PlayerScore> ranked(List<PlayerScore> players, PairingContext context) {
        PairingContext safeContext = context == null ? new PairingContext(0, List.of()) : context;
        Map<Integer, List<PlayerScore>> byWinPoints = new java.util.TreeMap<>(Comparator.reverseOrder());
        for (PlayerScore player : players)
            byWinPoints.computeIfAbsent(player.winPoints(), ignored -> new ArrayList<>()).add(player);

        List<PlayerScore> result = new ArrayList<>(players.size());
        for (List<PlayerScore> group : byWinPoints.values()) {
            Map<String, Integer> headToHeadInGroup = new LinkedHashMap<>();
            for (PlayerScore player : group) {
                int points = 0;
                for (PlayerScore opponent : group) {
                    if (!player.playerId().equals(opponent.playerId()))
                        points += safeContext.headToHeadPoints(player.playerId(), opponent.playerId());
                }
                headToHeadInGroup.put(player.playerId(), points);
            }
            group.sort(rankingWithinSameWinPoints(headToHeadInGroup));
            result.addAll(group);
        }
        return List.copyOf(result);
    }

    private static Comparator<PlayerScore> rankingWithinSameWinPoints(Map<String, Integer> headToHeadPoints) {
        return (first, second) -> {
            // Capped cumulative diff is the tie-break every ranking surface shows (standings pages,
            // PDF, final seeding); pairing must follow it or pairs contradict the visible อันดับ.
            int byDiff = Integer.compare(second.diff(), first.diff());
            if (byDiff != 0) return byDiff;

            int byHeadToHead = Integer.compare(
                headToHeadPoints.getOrDefault(second.playerId(), 0),
                headToHeadPoints.getOrDefault(first.playerId(), 0)
            );
            if (byHeadToHead != 0) return byHeadToHead;

            int byScoreFor = Long.compare(second.scoreFor(), first.scoreFor());
            if (byScoreFor != 0) return byScoreFor;

            int byRawDiff = Long.compare(second.rawDiff(), first.rawDiff());
            if (byRawDiff != 0) return byRawDiff;

            return comparePlayerCode(first.playerId(), second.playerId());
        };
    }

    private static int comparePlayerCode(String first, String second) {
        Long firstNumber = numericPlayerCode(first);
        Long secondNumber = numericPlayerCode(second);
        if (firstNumber != null && secondNumber != null) {
            int numeric = Long.compare(firstNumber, secondNumber);
            if (numeric != 0) return numeric;
        }
        return first.compareTo(second);
    }

    private static Long numericPlayerCode(String playerId) {
        if (playerId == null || playerId.isBlank()) return null;
        // Strip any leading letter prefix (the per-card code prefix: A, B, …, AA; or legacy P).
        String value = playerId.replaceFirst("^[A-Za-z]+", "");
        if (value.isBlank()) return null;
        for (int index = 0; index < value.length(); index++)
            if (!Character.isDigit(value.charAt(index))) return null;
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    record PlayerScore(String playerId, String school, int winPoints, int diff, long scoreFor, long rawDiff) {
        public PlayerScore(String playerId, String school, int winPoints, int diff) {
            this(playerId, school, winPoints, diff, 0, diff);
        }
    }
    record Pair(String playerOneId, String playerTwoId) {}
    record PairingContext(int gameNumber, List<Pair> previousMatches, Map<String, Map<String, Integer>> headToHeadPoints) {
        public PairingContext {
            previousMatches = previousMatches == null ? List.of() : List.copyOf(previousMatches);
            headToHeadPoints = headToHeadPoints == null ? Map.of() : Map.copyOf(headToHeadPoints);
        }

        public PairingContext(int gameNumber, List<Pair> previousMatches) {
            this(gameNumber, previousMatches, Map.of());
        }

        public int headToHeadPoints(String playerId, String opponentId) {
            return headToHeadPoints.getOrDefault(playerId, Map.of()).getOrDefault(opponentId, 0);
        }

        public boolean alreadyPlayed(String first, String second) {
            return previousMatches.stream().anyMatch(pair ->
                (pair.playerOneId().equals(first) && pair.playerTwoId().equals(second)) ||
                (pair.playerOneId().equals(second) && pair.playerTwoId().equals(first)));
        }
    }
}
