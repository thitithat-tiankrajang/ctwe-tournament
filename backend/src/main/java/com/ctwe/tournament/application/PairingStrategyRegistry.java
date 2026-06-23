package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.pairing.PairingStrategy;
import org.springframework.stereotype.Service;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

@Service
public class PairingStrategyRegistry {
    private final Map<PairingRuleType, PairingStrategy> strategies = new EnumMap<>(PairingRuleType.class);
    public PairingStrategyRegistry(List<PairingStrategy> strategies) { strategies.forEach(strategy -> this.strategies.put(strategy.type(), strategy)); }
    public PairingStrategy resolve(PairingRuleType type) {
        var strategy = strategies.get(type);
        if (strategy == null) throw new IllegalArgumentException("No pairing strategy registered for " + type);
        return strategy;
    }
}
