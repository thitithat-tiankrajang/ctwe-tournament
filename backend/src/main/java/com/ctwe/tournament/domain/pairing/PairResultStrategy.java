package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import org.springframework.stereotype.Component;
import java.util.List;

@Component
public class PairResultStrategy implements PairingStrategy {
    public PairingRuleType type() { return PairingRuleType.PAIR_RESULT; }
    public List<Pair> generate(List<PlayerScore> players, PairingContext context) {
        throw new IllegalStateException("PAIR_RESULT is materialized from two recorded source matches, not from standings");
    }
}
