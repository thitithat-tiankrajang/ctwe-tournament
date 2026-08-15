package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;

import java.util.List;

/**
 * THE anonymous public view of a tournament card — the single definition of what a viewer may see.
 *
 * <p>A pure function: no I/O, no caching, no Spring, no state. It takes the internal (staff) card
 * response plus the card's {@code public_version} and returns the projection served to anonymous
 * viewers. Everything it drops is dropped for a reason:
 * <ul>
 *   <li>{@code rules} — pairing configuration is back-office only.</li>
 *   <li>{@code tables} — seating is back-office only.</li>
 *   <li>{@code audit} — restricted to {@code ROLE_ADMIN} / {@code ROLE_DIRECTOR}.</li>
 *   <li>{@code finalRound} — hidden until the final round is actually visible to the audience.</li>
 * </ul>
 * It also replaces {@code runtimeStage} with a public-safe stage and {@code version} with the
 * public version, so viewers never observe internal workflow states or staff-side version churn.
 *
 * <p><b>Why this is a separate, pure function.</b> It is called from two places that must never
 * diverge: the cached live read model ({@link PublicCardReadCache#card}) and — from Phase A2 onward —
 * the Public Snapshot builder, which reads straight from PostgreSQL without the cache. If the two
 * had their own copies of this logic, adding a field to {@link CardDtos.CardResponse} would silently
 * produce snapshots that disagree with the live API, and a published snapshot is permanent. One
 * function means that class of bug cannot exist. See {@code docs/PUBLIC_SNAPSHOT_ARCHITECTURE.md}.
 *
 * <p>Characterized by {@code PublicCardProjectionGoldenTest}: any change to the output shape must be
 * a deliberate update of the committed golden document.
 */
public final class PublicCardProjection {
    private PublicCardProjection() {}

    /**
     * @param source        the internal card response ({@code staffView = false})
     * @param publicVersion the card's {@code public_version}, which is what viewers cache against
     */
    public static CardDtos.CardResponse of(CardDtos.CardResponse source, long publicVersion) {
        boolean finalPublished = source.runtimeStage() == RuntimeStage.FINAL_PUBLISHED
            || source.status() == CardStatus.FINISHED
            || source.status() == CardStatus.CLOSED;
        boolean finalVisible = finalPublished
            || source.runtimeStage() == RuntimeStage.FINAL_COLLECTION;
        boolean collectingPublishedPairing = source.snapshots().stream()
            .anyMatch(snapshot -> snapshot.confirmedAt() == null || snapshot.confirmedAt().isBlank());
        RuntimeStage publicStage = finalPublished
            ? RuntimeStage.FINAL_PUBLISHED
            : finalVisible
                ? RuntimeStage.FINAL_COLLECTION
            : source.runtimeStage() == RuntimeStage.PLAYER_REGISTRATION
                ? RuntimeStage.PLAYER_REGISTRATION
                : collectingPublishedPairing
                    ? RuntimeStage.RESULT_COLLECTION
                    : RuntimeStage.TABLE_PAIRING;
        return new CardDtos.CardResponse(
            source.id(), source.tournamentId(), source.name(), source.division(), source.status(), publicStage,
            source.currentGame(), publicVersion, source.games(), source.initialPairingRule(), List.of(), source.players(), List.of(),
            source.snapshots(), List.of(), source.finalType(), source.finalGames(),
            finalVisible ? source.finalRound() : null, source.gibsonEnabled(), source.createdAt(), source.codePrefix()
        );
    }
}
