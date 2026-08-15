package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.web.dto.CardDtos;

import java.util.List;
import java.util.UUID;

/**
 * The viewer-facing half of a Public Snapshot: exactly what
 * {@code GET /api/public/tournaments/{token}/bundle} returns, so the existing frontend can consume a
 * snapshot without any component change.
 *
 * <p>One deliberate difference from {@code TenantDtos.PublicTournamentBundle}: {@code accessToken} is
 * <b>omitted</b>. The viewer already holds the token (it is in the URL it navigated to), so echoing it
 * into a permanently public file would publish the routing identifier for no benefit. Every other
 * field matches the bundle contract, and {@code cards} carries the same public projection produced by
 * {@link com.ctwe.tournament.application.PublicCardProjection}.
 *
 * <p>This record is the checksummed unit. Nothing about *when* or *which version* a snapshot was
 * generated may appear here — those live in {@link PublicSnapshotEnvelope} so that identical source
 * data always produces identical payload bytes.
 */
public record PublicSnapshotPayload(
    UUID id,
    String name,
    int cardCount,
    int publishedCardCount,
    List<CardDtos.CardResponse> cards
) {}
