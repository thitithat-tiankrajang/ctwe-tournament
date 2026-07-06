package com.ctwe.tournament.domain.pairing;

import com.ctwe.tournament.domain.model.PairingRuleType;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;
import java.util.List;

@Component
public class RandomStrategy implements PairingStrategy {
    private final SecureRandom random = new SecureRandom();

    public PairingRuleType type() { return PairingRuleType.RANDOM; }

    public List<Pair> generate(List<PlayerScore> players, PairingContext context) {
        return SchoolAwarePairing.randomPairs(players, random);
    }
}
