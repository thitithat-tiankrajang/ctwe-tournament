package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.RuntimeSettingsService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class PublicCardControllerTest {
    private final PublicCardQueryService cards = mock(PublicCardQueryService.class);
    private final PublicCardController controller =
        new PublicCardController(cards, mock(CardEventPublisher.class), mock(RuntimeSettingsService.class));

    @Test
    void marksOnlyPublicReadModelAsSharedCacheable() {
        var summary = summary();
        when(cards.summaries()).thenReturn(List.of(summary));

        var response = controller.cards(new MockHttpServletRequest());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getHeaders().getCacheControl())
            .isEqualTo("public, max-age=2, s-maxage=5, stale-while-revalidate=10");
        assertThat(response.getHeaders().getETag()).isNotBlank();
        assertThat(response.getHeaders()).doesNotContainKey(HttpHeaders.SET_COOKIE);
    }

    @Test
    void returnsNotModifiedForMatchingCatalogEtag() {
        when(cards.summaries()).thenReturn(List.of(summary()));
        var first = controller.cards(new MockHttpServletRequest());
        MockHttpServletRequest conditional = new MockHttpServletRequest();
        conditional.addHeader(HttpHeaders.IF_NONE_MATCH, first.getHeaders().getETag());

        var response = controller.cards(conditional);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_MODIFIED);
        assertThat(response.getBody()).isNull();
    }

    @Test
    void marksMatchingVersionedCardUrlsImmutable() {
        UUID cardId = UUID.randomUUID();
        when(cards.get(cardId)).thenReturn(cardResponse(cardId, 7));
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setParameter("v", "7");

        var response = controller.card(cardId, request);

        assertThat(response.getHeaders().getCacheControl())
            .isEqualTo("public, max-age=31536000, immutable");
    }

    @Test
    void keepsUnversionedCardUrlsNearLive() {
        UUID cardId = UUID.randomUUID();
        when(cards.get(cardId)).thenReturn(cardResponse(cardId, 7));

        var response = controller.card(cardId, new MockHttpServletRequest());

        assertThat(response.getHeaders().getCacheControl())
            .isEqualTo("public, max-age=2, s-maxage=5, stale-while-revalidate=10");
    }

    @Test
    void keepsStaleVersionedCardUrlsNearLive() {
        UUID cardId = UUID.randomUUID();
        when(cards.get(cardId)).thenReturn(cardResponse(cardId, 7));
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setParameter("v", "6");

        var response = controller.card(cardId, request);

        assertThat(response.getHeaders().getCacheControl())
            .isEqualTo("public, max-age=2, s-maxage=5, stale-while-revalidate=10");
    }

    private CardDtos.CardResponse cardResponse(UUID cardId, long version) {
        return new CardDtos.CardResponse(
            cardId, UUID.randomUUID(), "Card", "Division", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 2, version, List.of(),
            com.ctwe.tournament.domain.model.PairingRuleType.RANDOM, List.of(), List.of(),
            List.of(), List.of(), List.of(), "NONE", 0, null, false, Instant.EPOCH, "A");
    }

    private PublicCardDtos.CardSummary summary() {
        return new PublicCardDtos.CardSummary(
            UUID.randomUUID(), UUID.randomUUID(), "Card", "Division", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 2, 8, 400, 1, 4, Instant.EPOCH);
    }
}
