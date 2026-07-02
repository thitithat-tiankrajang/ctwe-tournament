package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.infrastructure.security.ReauthenticationService;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CardControllerCacheRoutingTest {
    private final TournamentCardService cards = mock(TournamentCardService.class);
    private final PublicCardQueryService publicCards = mock(PublicCardQueryService.class);
    private final AuthorizationService authz = mock(AuthorizationService.class);
    private final ReauthenticationService reauthentication = mock(ReauthenticationService.class);
    private final CardEventPublisher events = mock(CardEventPublisher.class);
    private final CardController controller =
        new CardController(cards, publicCards, authz, reauthentication, events);

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

    @Test
    void pairingSwapRequiresCurrentPasswordBeforeMutation() {
        UUID cardId = UUID.randomUUID();
        var authentication = new UsernamePasswordAuthenticationToken(
            "director", "n/a", List.of(new SimpleGrantedAuthority("ROLE_DIRECTOR")));
        var request = new CardDtos.SwapRequest("P001", "P002", "director-password", false);
        CardDtos.CardResponse response = card(cardId);
        when(cards.swapPlayers(cardId, request, "director")).thenReturn(response);

        assertThat(controller.swap(cardId, request, authentication)).isSameAs(response);

        verify(authz).requireCardCapability(authentication, cardId, AuthorizationService.Capability.RUN_TOURNAMENT);
        verify(reauthentication).requireCurrentPassword(authentication, "director-password");
        verify(cards).swapPlayers(cardId, request, "director");
    }

    @Test
    void resultEventNeverLeaksAnUnpublishedDestinationPairingToPublicViewers() {
        UUID cardId = UUID.randomUUID();
        var authentication = new UsernamePasswordAuthenticationToken(
            "staff", "n/a", List.of(new SimpleGrantedAuthority("ROLE_STAFF")));
        var request = new CardDtos.ResultRequest(100, 70, false);
        var publishedSource = new CardDtos.PairingResponse(
            "g1-t1", 1, 1, "P001", "P002", "P001", 100, 70, "WIN", 30, true);
        var privateDestination = new CardDtos.PairingResponse(
            "g2-t1", 2, 1, "P001", null, null, null, null, null, null, false);
        var patch = new CardDtos.ResultPatch(8, List.of(publishedSource, privateDestination));
        when(authz.isStaff(authentication)).thenReturn(true);
        when(cards.submitResult(cardId, "g1-t1", request, "staff", false)).thenReturn(patch);
        when(publicCards.version(cardId)).thenReturn(5L);

        assertThat(controller.submitResult(cardId, "g1-t1", request, authentication)).isSameAs(patch);

        verify(events).publishResult(cardId, patch);
        verify(events).publishPublicResult(eq(cardId), eq(5L), eq(List.of(publishedSource)));
        verify(cards).submitResult(cardId, "g1-t1", request, "staff", false);
    }

    private static CardDtos.CardResponse card(UUID id) {
        return new CardDtos.CardResponse(
            id, UUID.randomUUID(), "Card", "Division", CardStatus.DRAFT,
            RuntimeStage.PLAYER_REGISTRATION, 1, 0,
            List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH);
    }
}
