package com.ctwe.tournament.web.dto;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;

import java.time.Instant;
import java.util.UUID;

/**
 * Lean card rows for an authenticated back-office list or sidebar.
 *
 * <p><b>Structurally identical to {@link PublicCardDtos.CardSummary} and deliberately a separate
 * type.</b> The public summary carries public-projected <em>values</em>: {@code runtimeStage} is a
 * derived public stage, {@code playerCount} is forced to 0 while a card is in PLAYER_REGISTRATION,
 * and {@code version} is {@code public_version}. Measured divergence on one real card: staff stage
 * PAIRING_PREVIEW vs public TABLE_PAIRING, staff version 11 vs public 7.
 *
 * <p>Sharing the type would let the frontend's {@code publicSummaryCard()} silently convert one of
 * these into a card and file it under the staff card store, where the wrong version would then be
 * compared against {@code replaceCard}'s guard. Two types make that impossible rather than merely
 * discouraged.
 */
public final class BackOfficeCardDtos {
    private BackOfficeCardDtos() {}

    /**
     * @param runtimeStage the card's real workflow stage, never a public projection of it
     * @param playerCount  the real roster size, including during registration
     * @param version      the staff-facing card version, never {@code public_version}
     */
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
}
