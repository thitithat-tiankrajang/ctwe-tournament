package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import org.springframework.stereotype.Service;

import java.util.List;
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

    public List<PublicCardDtos.CardVersion> versions() {
        return cache.versions();
    }
}
