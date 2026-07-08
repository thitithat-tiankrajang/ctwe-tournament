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

    public List<Pair> generate(List<PlayerScore> players, PairingContext context) {
        var ranked = PairingStrategy.ranked(players, context);
        Map<Integer, List<PlayerScore>> byScore = new LinkedHashMap<>();
        ranked.forEach(player -> byScore.computeIfAbsent(player.winPoints(), ignored -> new ArrayList<>()).add(player));
        var groups = new ArrayList<>(byScore.values());
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

    private int nextNonEmptyGroup(List<List<PlayerScore>> groups, int start) {
        for (int index = start; index < groups.size(); index++) if (!groups.get(index).isEmpty()) return index;
        return -1;
    }
}
