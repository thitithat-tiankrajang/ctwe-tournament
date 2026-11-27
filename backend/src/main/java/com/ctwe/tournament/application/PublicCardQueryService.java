package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class PublicCardQueryService {
    private final PublicCardReadCache cache;

    public PublicCardQueryService(PublicCardReadCache cache) {
        this.cache = cache;
    }

    public List<CardDtos.CardResponse> list() {
        return cache.summaries().stream().map(PublicCardDtos.CardSummary::id).map(cache::card).toList();
    }

    public CardDtos.CardResponse get(UUID cardId) {
        return cache.card(cardId);
    }

    /** One tournament's card ids and public versions straight from the database (uncached, no payloads). */
    public List<PublicCardDtos.CardVersion> manifest(UUID tournamentId) {
        return cache.manifest(tournamentId);
    }

    /**
     * Stale repairs currently running, at most one per card. An entry lives only for the duration of
     * its repair (removed in {@code finally}, success or failure), so the map is bounded by the number
     * of cards being repaired at this instant and never holds a failed entry.
     */
    private final ConcurrentHashMap<UUID, CompletableFuture<CardDtos.CardResponse>> repairs = new ConcurrentHashMap<>();

    /**
     * Brings a card whose cached payload was seen older than {@code requiredVersion} up to date —
     * without destroying a repair someone else already made.
     *
     * <ol>
     *   <li>Recheck the cache: if another caller has already repaired it, reuse that entry.</li>
     *   <li>Otherwise claim this card's repair slot. A caller that finds a repair already running
     *       waits for it and reuses its result, whatever version it reached — it never evicts again,
     *       which is what used to throw away a fresh entry and rebuild the same card twice.</li>
     *   <li>The slot owner rechecks once more (a repair may have finished between steps 1 and 2),
     *       evicts only if still stale, and reloads through the cache's single-flight load.</li>
     * </ol>
     *
     * <p>At most one rebuild per card per repair; no retry loop. If publication keeps moving, the
     * returned payload may still trail {@code requiredVersion}; callers tag responses from the payload,
     * so that is reported honestly rather than retried. A failed repair is propagated to its owner;
     * waiters are released and fall back to an ordinary cache read instead of repeating the failure.
     * Coordination is per card — unrelated cards never wait on each other.
     */
    public CardDtos.CardResponse reload(UUID cardId, long requiredVersion) {
        CardDtos.CardResponse current = cache.card(cardId);
        if (current.version() >= requiredVersion) return current;

        CompletableFuture<CardDtos.CardResponse> mine = new CompletableFuture<>();
        CompletableFuture<CardDtos.CardResponse> running = repairs.putIfAbsent(cardId, mine);
        if (running != null) {
            try {
                return running.join();
            } catch (CompletionException | CancellationException failed) {
                return cache.card(cardId);
            }
        }
        try {
            CardDtos.CardResponse repaired = cache.card(cardId);
            if (repaired.version() < requiredVersion) {
                cache.evictCard(cardId);
                repaired = cache.card(cardId);
            }
            mine.complete(repaired);
            return repaired;
        } catch (RuntimeException failure) {
            mine.completeExceptionally(failure);
            throw failure;
        } finally {
            repairs.remove(cardId, mine);
        }
    }

    /** Diagnostic: stale repairs running right now (0 when idle). */
    public int repairsInFlight() {
        return repairs.size();
    }

    public List<PublicCardDtos.CardSummary> summaries() {
        return cache.summaries();
    }

    /** Published-card summaries scoped to one tournament (the link-scoped public viewer). */
    public List<PublicCardDtos.CardSummary> summaries(UUID tournamentId) {
        return cache.summaries().stream()
            .filter(summary -> tournamentId.equals(summary.tournamentId()))
            .toList();
    }

    /** One card's public summary, absent if the card no longer exists. */
    public Optional<PublicCardDtos.CardSummary> summaryOf(UUID cardId) {
        return cache.summaries().stream()
            .filter(summary -> cardId.equals(summary.id()))
            .findFirst();
    }

    /** Cheap change fingerprint of one tournament's catalog (membership + every card version). */
    public long catalogFingerprint(UUID tournamentId) {
        return summaries(tournamentId).stream()
            .mapToLong(summary -> summary.version() + 1)
            .sum();
    }

    public List<PublicCardDtos.CardVersion> versions() {
        return cache.versions();
    }

    public long version(UUID cardId) {
        return cache.version(cardId);
    }
}
