package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;

/**
 * Estimated weight of one cached public card, used by the weight-bounded detail cache. The cache
 * limits the SUM OF THESE ESTIMATES (app.cache.public-card-details.maximum-weight-bytes); it does not
 * measure or bound actual retained heap, and it says nothing about total JVM memory.
 *
 * <p>The estimate is {@value #BASE_BYTES} bytes plus {@value #ROW_BYTES} bytes per row (player,
 * pairing, game, rule, final slot/game). Calibration evidence is two local fixtures only (heap after
 * GC, 2026-11-21): a 6-player game-1 card retained about 18 KB against a 39,936-byte estimate, and a
 * 300-player card with three scored games (Thai names) retained about 1.4 MB against a 1,936,896-byte
 * estimate. The estimate exceeded both measurements, but two fixtures do not establish that it
 * exceeds the real footprint of every card shape.
 */
public final class PublicCardWeigher {
    static final int BASE_BYTES = 4 * 1024;
    static final int ROW_BYTES = 2_560;
    /** A 1,000-row card (about 300 players with three scored games): 2,564,096 estimate-bytes. */
    public static final long REFERENCE_CARD_BYTES = BASE_BYTES + 1_000L * ROW_BYTES;

    private PublicCardWeigher() {}

    public static int weigh(Object key, Object value) {
        if (!(value instanceof CardDtos.CardResponse card)) return BASE_BYTES;
        long rows = size(card.players()) + size(card.games()) + size(card.rules()) + size(card.tables())
            + size(card.audit()) + size(card.screeningPool());
        if (card.snapshots() != null)
            for (CardDtos.SnapshotResponse snapshot : card.snapshots()) rows += size(snapshot.pairings());
        if (card.finalRound() != null && card.finalRound().slots() != null)
            for (CardDtos.FinalSlotResponse slot : card.finalRound().slots()) rows += 1 + size(slot.games());
        return (int) Math.min(Integer.MAX_VALUE, BASE_BYTES + rows * ROW_BYTES);
    }

    private static long size(java.util.Collection<?> items) {
        return items == null ? 0 : items.size();
    }
}
