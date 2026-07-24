package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

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
