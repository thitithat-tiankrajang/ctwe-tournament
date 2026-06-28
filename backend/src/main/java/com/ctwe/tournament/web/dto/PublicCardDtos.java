package com.ctwe.tournament.web.dto;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;

import java.time.Instant;
import java.util.UUID;

public final class PublicCardDtos {
    private PublicCardDtos() {}

    public record CardSummary(
        UUID id,
        UUID tournamentId,
        String name,
        String division,
        CardStatus status,
        RuntimeStage runtimeStage,
        int currentGame,
        int gameCount,
        int playerCount,
        int publishedGameCount,
        long version,
        Instant createdAt
    ) {}

    public record CardVersion(UUID id, long version) {}
}
