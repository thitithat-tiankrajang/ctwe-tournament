package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.application.WebPushService;
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
    private final WebPushService push = mock(WebPushService.class);
    private final CardController controller =
        new CardController(cards, publicCards, authz, reauthentication, events, push);

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
        var request = new CardDtos.SwapRequest("P001", "P002", "director-password", false, null);
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
            "g1-t1", 1, 1, "P001", "P002", "P001", 100, 70, "WIN", 30, false, false, true);
        var privateDestination = new CardDtos.PairingResponse(
            "g2-t1", 2, 1, "P001", null, null, null, null, null, null, false, false, false);
        var patch = new CardDtos.ResultPatch(8, List.of(publishedSource, privateDestination));
        when(cards.submitResult(cardId, "g1-t1", request, "staff")).thenReturn(patch);
        when(publicCards.version(cardId)).thenReturn(5L);

        assertThat(controller.submitResult(cardId, "g1-t1", request, authentication)).isSameAs(patch);

        verify(events).publishResult(cardId, patch);
        verify(events).publishPublicResult(eq(cardId), eq(5L), eq(List.of(publishedSource)));
        verify(cards).submitResult(cardId, "g1-t1", request, "staff");
    }

    @Test
    void penaltyAndWithdrawalRequireDirectorCapabilityAndCurrentPassword() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        var penaltyRequest = new CardDtos.PenaltyRequest(100, "director-password");
        var revokeRequest = new CardDtos.PasswordRequest("director-password");
        CardDtos.CardResponse response = card(cardId);
        when(cards.applyPenalty(cardId, "g1-t1", 100, "director")).thenReturn(response);
        when(cards.revokePenalty(cardId, "g1-t1", "director")).thenReturn(response);

        assertThat(controller.penalty(cardId, "g1-t1", penaltyRequest, authentication)).isSameAs(response);
        assertThat(controller.revokePenalty(cardId, "g1-t1", revokeRequest, authentication)).isSameAs(response);

        verify(authz, org.mockito.Mockito.times(2)).requireCardCapability(
            authentication, cardId, AuthorizationService.Capability.PENALIZE_RESULT);
        verify(reauthentication, org.mockito.Mockito.times(2))
            .requireCurrentPassword(authentication, "director-password");
        verify(cards).applyPenalty(cardId, "g1-t1", 100, "director");
        verify(cards).revokePenalty(cardId, "g1-t1", "director");
    }

    @Test
    void confirmedPairingQueuesDevicePushForThatGame() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        CardDtos.CardResponse response = withStage(card(cardId), RuntimeStage.RESULT_COLLECTION, 2, List.of());
        when(cards.confirmPairingPreview(cardId, "director")).thenReturn(response);

        assertThat(controller.confirm(cardId, authentication)).isSameAs(response);

        verify(push).pairingPublished(cardId, 2);
    }

    @Test
    void publishedRankingAndCompletedCardQueueBothDevicePushes() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        var snapshot = new CardDtos.SnapshotResponse("2", List.of(2, 3), List.of(), Instant.EPOCH.toString());
        CardDtos.CardResponse response = withStage(card(cardId), RuntimeStage.FINAL_PUBLISHED, 3, List.of(snapshot));
        when(cards.publishResults(cardId, "director")).thenReturn(response);

        assertThat(controller.publishResults(cardId, authentication)).isSameAs(response);

        verify(push).rankingPublished(cardId, 2, 3);
        verify(push).competitionCompleted(cardId);
    }

    @Test
    void startingAndPublishingFinalQueueLifecyclePushes() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        CardDtos.CardResponse started = withStage(card(cardId), RuntimeStage.FINAL_COLLECTION, 3, List.of());
        CardDtos.CardResponse completed = withStage(card(cardId), RuntimeStage.FINAL_PUBLISHED, 3, List.of());
        when(cards.startFinalRound(cardId, "director")).thenReturn(started);
        when(cards.publishFinalRound(cardId, "director")).thenReturn(completed);

        assertThat(controller.startFinal(cardId, authentication)).isSameAs(started);
        assertThat(controller.publishFinal(cardId, authentication)).isSameAs(completed);

        verify(push).finalStarted(cardId);
        verify(push).competitionCompleted(cardId);
    }

    @Test
    void mutationThatBumpsPublicVersionNotifiesViewerStreams() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        var snapshot = new CardDtos.SnapshotResponse("2", List.of(2, 3), List.of(), Instant.EPOCH.toString());
        CardDtos.CardResponse response = withStage(card(cardId), RuntimeStage.RESULT_COLLECTION, 3, List.of(snapshot));
        when(cards.publishResults(cardId, "director")).thenReturn(response);
        when(publicCards.version(cardId)).thenReturn(4L, 5L);

        controller.publishResults(cardId, authentication);

        verify(events).publish(response);
        verify(events).publishPublic(cardId, 5L);
    }

    @Test
    void mutationWithoutPublicEffectStaysOffTheViewerStream() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        CardDtos.CardResponse response = card(cardId);
        var request = new CardDtos.PlayerRequest(null, "First", "Last", "School");
        when(authz.isDirector(authentication)).thenReturn(true);
        when(cards.updatePlayer(cardId, "P001", request, "director", true)).thenReturn(response);
        when(publicCards.version(cardId)).thenReturn(4L);

        controller.updatePlayer(cardId, "P001", request, authentication);

        verify(events).publish(response);
        verify(events, never()).publishPublic(org.mockito.ArgumentMatchers.eq(cardId), org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    void deletingACardForcesViewerStreamsToResync() {
        UUID cardId = UUID.randomUUID();
        var authentication = director();
        when(publicCards.version(cardId)).thenReturn(9L);

        controller.delete(cardId, authentication);

        verify(cards).delete(cardId);
        verify(events).publish(cardId, -1);
        verify(events).publishPublic(cardId, 10L);
    }

    private static UsernamePasswordAuthenticationToken director() {
        return new UsernamePasswordAuthenticationToken(
            "director", "n/a", List.of(new SimpleGrantedAuthority("ROLE_DIRECTOR")));
    }

    private static CardDtos.CardResponse withStage(
        CardDtos.CardResponse source,
        RuntimeStage stage,
        int currentGame,
        List<CardDtos.SnapshotResponse> snapshots
    ) {
        return new CardDtos.CardResponse(
            source.id(), source.tournamentId(), source.name(), source.division(), source.status(),
            stage, currentGame, source.version(), source.games(), source.rules(), source.players(),
            source.tables(), snapshots, source.audit(), source.finalType(), source.finalGames(),
            source.finalRound(), source.gibsonEnabled(), source.createdAt(), source.codePrefix());
    }

    private static CardDtos.CardResponse card(UUID id) {
        return new CardDtos.CardResponse(
            id, UUID.randomUUID(), "Card", "Division", CardStatus.DRAFT,
            RuntimeStage.PLAYER_REGISTRATION, 1, 0,
            List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH, "A");
    }
}
