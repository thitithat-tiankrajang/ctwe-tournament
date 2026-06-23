package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import org.springframework.stereotype.Component;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@Component
public class KingOfTheHillStrategy implements PairingStrategy {
    public PairingRuleType type() { return PairingRuleType.KING_OF_THE_HILL; }
    public List<Pair> generate(List<PlayerScore> players, PairingContext context) {
        var ranked = players.stream().sorted(Comparator.comparingInt(PlayerScore::winPoints).reversed()
            .thenComparing(Comparator.comparingInt(PlayerScore::diff).reversed())
            .thenComparing(PlayerScore::playerId)).toList();
        var pairs = new ArrayList<Pair>();
        for (int i = 0; i + 1 < ranked.size(); i += 2) pairs.add(new Pair(ranked.get(i).playerId(), ranked.get(i + 1).playerId()));
        return List.copyOf(pairs);
    }
}
