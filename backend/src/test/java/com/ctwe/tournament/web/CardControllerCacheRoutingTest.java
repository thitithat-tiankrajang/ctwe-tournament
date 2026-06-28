package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CardControllerCacheRoutingTest {
    private final TournamentCardService cards = mock(TournamentCardService.class);
    private final PublicCardQueryService publicCards = mock(PublicCardQueryService.class);
    private final AuthorizationService authz = mock(AuthorizationService.class);
    private final CardController controller =
        new CardController(cards, publicCards, authz, mock(CardEventPublisher.class));

    @Test
    void anonymousCardReadUsesOnlyPublicCacheBoundary() {
        UUID cardId = UUID.randomUUID();
        CardDtos.CardResponse response = card(cardId);
        when(publicCards.get(cardId)).thenReturn(response);

        assertThat(controller.get(cardId, null)).isSameAs(response);

        verify(publicCards).get(cardId);
        verify(cards, never()).get(cardId, true);
    }

    @Test
    void authenticatedBackOfficeReadBypassesPublicCache() {
        UUID cardId = UUID.randomUUID();
        CardDtos.CardResponse response = card(cardId);
        var authentication = new UsernamePasswordAuthenticationToken(
            "director", "n/a", List.of(new SimpleGrantedAuthority("ROLE_DIRECTOR")));
        when(authz.isDirector(authentication)).thenReturn(true);
        when(cards.get(cardId, true)).thenReturn(response);

        assertThat(controller.get(cardId, authentication)).isSameAs(response);

        verify(cards).get(cardId, true);
        verify(publicCards, never()).get(cardId);
    }

    @Test
    void anonymousListUsesOnlyPublicCacheBoundary() {
        List<CardDtos.CardResponse> response = List.of(card(UUID.randomUUID()));
        when(publicCards.list()).thenReturn(response);

        assertThat(controller.list(null)).isSameAs(response);

        verify(publicCards).list();
        verify(cards, never()).list(true, null);
    }

    @Test
    void scopedBackOfficeListBypassesPublicCache() {
        UUID tournamentId = UUID.randomUUID();
        var authentication = new UsernamePasswordAuthenticationToken(
            "director", "n/a", List.of(new SimpleGrantedAuthority("ROLE_DIRECTOR")));
        when(authz.isDirector(authentication)).thenReturn(true);
        when(authz.accessibleTournamentIds(authentication)).thenReturn(Set.of(tournamentId));
        when(cards.list(true, Set.of(tournamentId))).thenReturn(List.of());

        assertThat(controller.list(authentication)).isEmpty();

        verify(cards).list(true, Set.of(tournamentId));
        verify(publicCards, never()).list();
    }

    private static CardDtos.CardResponse card(UUID id) {
        return new CardDtos.CardResponse(
            id, UUID.randomUUID(), "Card", "Division", CardStatus.DRAFT,
            RuntimeStage.PLAYER_REGISTRATION, 1, 0,
            List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH);
    }
}
