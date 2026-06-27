package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService.Capability;
import com.ctwe.tournament.web.dto.CardDtos;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Card operations are designed for concurrent multi-user editing (several staff/directors on the
 * same card from different machines). There is no card-level optimistic If-Match gate: every
 * mutation locks the card row ({@code SELECT ... FOR UPDATE}) and re-validates stage/snapshot
 * invariants, so concurrent writes serialize and all apply with nothing dropped.
 */
@RestController
@RequestMapping("/api/cards")
public class CardController {
    private final TournamentCardService service;
    private final AuthorizationService authz;
    private final CardEventPublisher events;

    public CardController(TournamentCardService service, AuthorizationService authz, CardEventPublisher events) {
        this.service = service;
        this.authz = authz;
        this.events = events;
    }

    @GetMapping
    public List<CardDtos.CardResponse> list(Authentication authentication) {
        Set<UUID> restrict = (authz.isDirector(authentication) || authz.isStaff(authentication))
            ? authz.accessibleTournamentIds(authentication) : null;
        return service.list(backOffice(authentication), restrict);
    }

    @GetMapping("/{cardId}")
    public CardDtos.CardResponse get(@PathVariable UUID cardId, Authentication authentication) {
        return service.get(cardId, backOffice(authentication));
    }

    /** On-demand audit log (kept out of the card payload). Role-gated to ADMIN/DIRECTOR by SecurityConfiguration. */
    @GetMapping("/{cardId}/audit")
    public List<CardDtos.AuditResponse> audit(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return service.auditLog(cardId);
    }

    /** Tiny change-detector for live-sync polling (full card is fetched only when this changes). */
    @GetMapping("/{cardId}/version")
    public Map<String, Long> version(@PathVariable UUID cardId) {
        return Map.of("version", service.cardVersion(cardId));
    }

    @GetMapping(value = "/{cardId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable UUID cardId, Authentication authentication) {
        service.get(cardId, backOffice(authentication));
        return events.subscribe(cardId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse create(@Valid @RequestBody CardDtos.CreateCardRequest request, Authentication authentication) {
        authz.requireTournamentCapability(authentication, request.tournamentId(), Capability.RUN_TOURNAMENT);
        return changed(service.create(request, authentication.getName()));
    }

    @PostMapping("/{cardId}/close")
    public CardDtos.CardResponse close(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.close(cardId, authentication.getName()));
    }

    @DeleteMapping("/{cardId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        service.delete(cardId);
        events.publish(cardId, -1);
    }

    @PostMapping("/{cardId}/players")
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse addPlayer(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        return changed(service.addPlayer(cardId, request, authentication.getName()));
    }

    @PostMapping("/{cardId}/players/bulk")
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse importPlayers(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.BulkPlayersRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        return changed(service.addPlayersBulk(cardId, request.players(), authentication.getName()));
    }

    @PutMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse updatePlayer(@PathVariable UUID cardId, @PathVariable String playerId,
                                               @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        boolean operator = authz.isAdmin(authentication) || authz.isDirector(authentication);
        return changed(service.updatePlayer(cardId, playerId, request, authentication.getName(), operator));
    }

    @DeleteMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse removePlayer(@PathVariable UUID cardId, @PathVariable String playerId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        return changed(service.removePlayer(cardId, playerId, authentication.getName()));
    }

    @PostMapping("/{cardId}/registration/finish")
    public CardDtos.CardResponse finishRegistration(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.finishRegistration(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/tables/swap")
    public CardDtos.CardResponse swap(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.SwapRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.swapPlayers(cardId, request, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/preview")
    public CardDtos.CardResponse previewPairings(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.generatePairingPreview(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/undo")
    public CardDtos.CardResponse undoPairing(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.undoPairing(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/unpair-to-preview")
    public CardDtos.CardResponse unpairToPreview(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.unpairToPreview(cardId, authentication.getName()));
    }

    @PutMapping("/{cardId}/matches/{matchId}/result")
    public CardDtos.ResultPatch submitResult(@PathVariable UUID cardId, @PathVariable UUID matchId,
                                             @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.SUBMIT_RESULT);
        CardDtos.ResultPatch patch = service.submitResult(cardId, matchId, request, authentication.getName());
        events.publish(cardId, patch.version()); // notify other screens to resync (they fetch the full card)
        return patch;
    }

    @PutMapping("/{cardId}/matches/{matchId}/override")
    public CardDtos.CardResponse overrideResult(@PathVariable UUID cardId, @PathVariable UUID matchId,
                                                @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.overrideResult(cardId, matchId, request, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/confirm")
    public CardDtos.CardResponse confirm(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.confirmPairingPreview(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/results/review")
    public CardDtos.CardResponse reviewResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.reviewResults(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/results/reopen")
    public CardDtos.CardResponse reopenResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.reopenResults(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/results/publish")
    public CardDtos.CardResponse publishResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.publishResults(cardId, authentication.getName()));
    }

    // ---- final / championship round ----
    @PostMapping("/{cardId}/final/start")
    public CardDtos.CardResponse startFinal(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.startFinalRound(cardId, authentication.getName()));
    }

    @PutMapping("/{cardId}/final/{slot}/games/{gameIndex}")
    public CardDtos.CardResponse submitFinalResult(@PathVariable UUID cardId, @PathVariable int slot, @PathVariable int gameIndex,
                                                   @Valid @RequestBody CardDtos.FinalResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.SUBMIT_RESULT);
        return changed(service.submitFinalResult(cardId, slot, gameIndex, request.scoreOne(), request.scoreTwo(), authentication.getName()));
    }

    @PutMapping("/{cardId}/final/{slot}/winner")
    public CardDtos.CardResponse setFinalWinner(@PathVariable UUID cardId, @PathVariable int slot,
                                                @Valid @RequestBody CardDtos.FinalWinnerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.SUBMIT_RESULT);
        return changed(service.setFinalWinner(cardId, slot, request.winnerId(), authentication.getName()));
    }

    @PostMapping("/{cardId}/final/publish")
    public CardDtos.CardResponse publishFinal(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(service.publishFinalRound(cardId, authentication.getName()));
    }

    private CardDtos.CardResponse changed(CardDtos.CardResponse card) {
        events.publish(card);
        return card;
    }

    /** Any authenticated back-office principal (admin/director/staff) sees the internal staff view. */
    private boolean backOffice(Authentication authentication) {
        return authz.isAdmin(authentication) || authz.isDirector(authentication) || authz.isStaff(authentication);
    }
}
