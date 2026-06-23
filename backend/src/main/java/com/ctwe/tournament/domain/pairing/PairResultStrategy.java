package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import org.springframework.stereotype.Component;
import java.util.ArrayList;
import java.util.List;

@Component
public class PairResultStrategy implements PairingStrategy {
    public PairingRuleType type() { return PairingRuleType.PAIR_RESULT; }
    public List<Pair> generate(List<PlayerScore> players, PairingContext context) {
        if (context.gameNumber() < 2) throw new IllegalArgumentException("PAIR_RESULT requires a preceding game");
        var pairs = new ArrayList<Pair>();
        for (int i = 0; i + 1 < players.size(); i += 2) pairs.add(new Pair(players.get(i).playerId(), players.get(i + 1).playerId()));
        return List.copyOf(pairs);
    }
}
