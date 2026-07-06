package com.ctwe.tournament.domain.pairing;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/**
 * Shared school-aware helpers for random matchups and physical-table ordering.
 *
 * <p>A physical table contains two consecutive matches (four seats). Match generation minimises
 * same-school opponents first; table ordering then minimises schools repeated across those two
 * matches. Every step has a fallback, so even a one-school field is always pairable.</p>
 */
public final class SchoolAwarePairing {
    private SchoolAwarePairing() {}

    /**
     * Pair an even field with the mathematically minimum number of same-school matchups.
     * Players are shuffled before grouping and all equal-size choices are random.
     */
    public static List<PairingStrategy.Pair> randomPairs(
        List<PairingStrategy.PlayerScore> players,
        Random random
    ) {
        if (players.size() % 2 != 0)
            throw new IllegalArgumentException("Random pairing requires an even number of players");

        List<PairingStrategy.PlayerScore> shuffled = new ArrayList<>(players);
        Collections.shuffle(shuffled, random);
        Map<String, List<PairingStrategy.PlayerScore>> grouped = new HashMap<>();
        for (PairingStrategy.PlayerScore player : shuffled)
            grouped.computeIfAbsent(schoolKey(player.school()), ignored -> new ArrayList<>()).add(player);

        List<List<PairingStrategy.PlayerScore>> buckets = new ArrayList<>(grouped.values());
        for (List<PairingStrategy.PlayerScore> bucket : buckets) Collections.shuffle(bucket, random);
        List<PairingStrategy.Pair> pairs = new ArrayList<>();
        while (true) {
            buckets.removeIf(List::isEmpty);
            if (buckets.isEmpty()) break;
            Collections.shuffle(buckets, random);
            buckets.sort((left, right) -> Integer.compare(right.size(), left.size()));
            List<PairingStrategy.PlayerScore> first = buckets.get(0);
            List<PairingStrategy.PlayerScore> second = buckets.size() > 1 ? buckets.get(1) : first;
            PairingStrategy.PlayerScore one = first.remove(first.size() - 1);
            PairingStrategy.PlayerScore two = second.remove(second.size() - 1);
            if (random.nextBoolean()) pairs.add(new PairingStrategy.Pair(one.playerId(), two.playerId()));
            else pairs.add(new PairingStrategy.Pair(two.playerId(), one.playerId()));
        }
        return orderForTables(pairs, players, random);
    }

    /**
     * Order already-decided matchups so each pair of consecutive matches shares as few schools as
     * possible. The matchups themselves never change. Table groups and match order inside each group
     * are shuffled after optimisation, keeping regenerated pairings difficult to predict.
     */
    public static List<PairingStrategy.Pair> orderForTables(
        List<PairingStrategy.Pair> pairs,
        List<PairingStrategy.PlayerScore> players,
        Random random
    ) {
        return orderForTables(pairs, players, random, null);
    }

    public static List<PairingStrategy.Pair> orderForTables(
        List<PairingStrategy.Pair> pairs,
        List<PairingStrategy.PlayerScore> players,
        Random random,
        String byePlayerId
    ) {
        if (pairs.size() < 2) return randomisedOrientation(pairs, random);
        Map<String, String> schools = new HashMap<>();
        players.forEach(player -> schools.put(player.playerId(), schoolKey(player.school())));

        List<PairingStrategy.Pair> remaining = randomisedOrientation(pairs, random);
        List<List<PairingStrategy.Pair>> tables = new ArrayList<>();
        while (!remaining.isEmpty()) {
            int anchorIndex = mostConstrainedIndex(remaining, schools);
            PairingStrategy.Pair anchor = remaining.remove(anchorIndex);
            if (remaining.isEmpty()) {
                tables.add(new ArrayList<>(List.of(anchor)));
                break;
            }
            int bestCost = Integer.MAX_VALUE;
            List<Integer> best = new ArrayList<>();
            for (int index = 0; index < remaining.size(); index++) {
                int cost = tableConflictCost(anchor, remaining.get(index), schools);
                if (cost < bestCost) {
                    bestCost = cost;
                    best.clear();
                    best.add(index);
                } else if (cost == bestCost) best.add(index);
            }
            int partnerIndex = best.get(random.nextInt(best.size()));
            PairingStrategy.Pair partner = remaining.remove(partnerIndex);
            List<PairingStrategy.Pair> table = new ArrayList<>(List.of(anchor, partner));
            Collections.shuffle(table, random);
            tables.add(table);
        }
        optimiseByeTable(tables, schools, byePlayerId, random);
        List<PairingStrategy.Pair> incomplete = tables.stream()
            .filter(table -> table.size() == 1).findFirst().map(ArrayList::new).orElse(null);
        tables.removeIf(table -> table.size() == 1);
        Collections.shuffle(tables, random);
        // The incomplete group must stay last; flattening it in the middle would join it to the next
        // group when the caller assigns every two matches to a physical table.
        if (incomplete != null) tables.add(incomplete);
        return tables.stream().flatMap(List::stream).toList();
    }

    private static void optimiseByeTable(
        List<List<PairingStrategy.Pair>> tables,
        Map<String, String> schools,
        String byePlayerId,
        Random random
    ) {
        if (byePlayerId == null) return;
        List<PairingStrategy.Pair> incomplete = tables.stream()
            .filter(table -> table.size() == 1).findFirst().orElse(null);
        if (incomplete == null) return;
        String byeSchool = schools.getOrDefault(byePlayerId, "");
        PairingStrategy.Pair original = incomplete.get(0);
        int bestCost = byeConflictCost(original, byeSchool, schools);
        List<int[]> bestSwaps = new ArrayList<>();
        for (int tableIndex = 0; tableIndex < tables.size(); tableIndex++) {
            List<PairingStrategy.Pair> table = tables.get(tableIndex);
            if (table.size() != 2) continue;
            for (int pairIndex = 0; pairIndex < 2; pairIndex++) {
                PairingStrategy.Pair candidate = table.get(pairIndex);
                PairingStrategy.Pair other = table.get(1 - pairIndex);
                int cost = byeConflictCost(candidate, byeSchool, schools)
                    + tableConflictCost(original, other, schools);
                if (cost < bestCost) {
                    bestCost = cost;
                    bestSwaps.clear();
                    bestSwaps.add(new int[] { tableIndex, pairIndex });
                } else if (cost == bestCost) bestSwaps.add(new int[] { tableIndex, pairIndex });
            }
        }
        if (bestSwaps.isEmpty()) return;
        int[] chosen = bestSwaps.get(random.nextInt(bestSwaps.size()));
        List<PairingStrategy.Pair> donor = tables.get(chosen[0]);
        PairingStrategy.Pair candidate = donor.set(chosen[1], original);
        incomplete.set(0, candidate);
    }

    private static int byeConflictCost(
        PairingStrategy.Pair pair,
        String byeSchool,
        Map<String, String> schools
    ) {
        return pairSchools(pair, schools).contains(byeSchool) ? 1 : 0;
    }

    private static List<PairingStrategy.Pair> randomisedOrientation(
        List<PairingStrategy.Pair> pairs,
        Random random
    ) {
        List<PairingStrategy.Pair> result = new ArrayList<>(pairs.size());
        for (PairingStrategy.Pair pair : pairs) {
            if (random.nextBoolean()) result.add(pair);
            else result.add(new PairingStrategy.Pair(pair.playerTwoId(), pair.playerOneId()));
        }
        Collections.shuffle(result, random);
        return result;
    }

    private static int mostConstrainedIndex(
        List<PairingStrategy.Pair> pairs,
        Map<String, String> schools
    ) {
        Map<String, Integer> frequency = new HashMap<>();
        for (PairingStrategy.Pair pair : pairs)
            pairSchools(pair, schools).forEach(school -> frequency.merge(school, 1, Integer::sum));
        int bestIndex = 0;
        int bestPressure = -1;
        for (int index = 0; index < pairs.size(); index++) {
            int pressure = pairSchools(pairs.get(index), schools).stream()
                .mapToInt(school -> frequency.getOrDefault(school, 0)).sum();
            if (pressure > bestPressure) {
                bestPressure = pressure;
                bestIndex = index;
            }
        }
        return bestIndex;
    }

    private static int tableConflictCost(
        PairingStrategy.Pair first,
        PairingStrategy.Pair second,
        Map<String, String> schools
    ) {
        Set<String> firstSchools = pairSchools(first, schools);
        Set<String> secondSchools = pairSchools(second, schools);
        int cost = 0;
        for (String school : firstSchools) if (secondSchools.contains(school)) cost++;
        return cost;
    }

    private static Set<String> pairSchools(
        PairingStrategy.Pair pair,
        Map<String, String> schools
    ) {
        Set<String> result = new HashSet<>();
        result.add(schools.getOrDefault(pair.playerOneId(), ""));
        result.add(schools.getOrDefault(pair.playerTwoId(), ""));
        return result;
    }

    private static String schoolKey(String school) {
        return school == null ? "" : school.trim().toLowerCase(Locale.ROOT);
    }
}
