package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Component
public class SwissStrategy implements PairingStrategy {
    public PairingRuleType type() { return PairingRuleType.SWISS; }

    @Override
    public String selectBye(List<PlayerScore> players, PairingContext context) {
        var groups = scoreGroups(players);
        for (int groupIndex = 0; groupIndex < groups.size(); groupIndex++) {
            List<PlayerScore> group = groups.get(groupIndex);
            if (group.size() % 2 == 0) continue;
            int lowerIndex = nextNonEmptyGroup(groups, groupIndex + 1);
            if (lowerIndex >= 0) {
                group.add(groups.get(lowerIndex).remove(0));
                continue;
            }
            // For a final odd group, split around the middle: 15 players use an offset of 8,
            // pair ranks 1-9 through 7-15, and give rank 8 the bye.
            return group.get(group.size() / 2).playerId();
        }
        return null;
    }

    public List<Pair> generate(List<PlayerScore> players, PairingContext context) {
        var groups = scoreGroups(players);
        var pairs = new ArrayList<Pair>();

        for (int groupIndex = 0; groupIndex < groups.size(); groupIndex++) {
            List<PlayerScore> group = groups.get(groupIndex);
            if (group.isEmpty()) continue;
            if (group.size() % 2 != 0) {
                int lowerIndex = nextNonEmptyGroup(groups, groupIndex + 1);
                if (lowerIndex < 0) throw new IllegalArgumentException("Swiss pairing requires an even number of players");
                group.add(groups.get(lowerIndex).remove(0));
            }
            int half = group.size() / 2;
            for (int index = 0; index < half; index++) {
                pairs.add(new Pair(group.get(index).playerId(), group.get(index + half).playerId()));
            }
        }
        return List.copyOf(pairs);
    }

    private ArrayList<List<PlayerScore>> scoreGroups(List<PlayerScore> players) {
        // Swiss must consume the exact visible standings order. Hidden head-to-head, score-for,
        // or raw-diff tie-breakers would move players away from the ranks shown to operators.
        var ranked = new ArrayList<>(players);
        ranked.sort((first, second) -> {
            int byWinPoints = Integer.compare(second.winPoints(), first.winPoints());
            if (byWinPoints != 0) return byWinPoints;
            int byDiff = Integer.compare(second.diff(), first.diff());
            if (byDiff != 0) return byDiff;
            return PairingStrategy.comparePlayerCode(first.playerId(), second.playerId());
        });
        Map<Integer, List<PlayerScore>> byScore = new LinkedHashMap<>();
        ranked.forEach(player -> byScore.computeIfAbsent(player.winPoints(), ignored -> new ArrayList<>()).add(player));
        return new ArrayList<>(byScore.values());
    }

    private int nextNonEmptyGroup(List<List<PlayerScore>> groups, int start) {
        for (int index = start; index < groups.size(); index++) if (!groups.get(index).isEmpty()) return index;
        return -1;
    }
}
