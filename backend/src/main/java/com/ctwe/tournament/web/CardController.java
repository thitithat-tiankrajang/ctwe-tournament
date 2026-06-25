package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService.Capability;
import com.ctwe.tournament.web.dto.CardDtos;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/cards")
public class CardController {
    private final TournamentCardService service;
    private final AuthorizationService authz;

    public CardController(TournamentCardService service, AuthorizationService authz) {
        this.service = service;
        this.authz = authz;
    }

    @GetMapping
    public List<CardDtos.CardResponse> list(Authentication authentication) {
        // Directors/staff see only their tenant's cards; admins and public see all.
        java.util.Set<UUID> restrict = (authz.isDirector(authentication) || authz.isStaff(authentication))
            ? authz.accessibleTournamentIds(authentication) : null;
        return service.list(backOffice(authentication), restrict);
    }

    @GetMapping("/{cardId}")
    public CardDtos.CardResponse get(@PathVariable UUID cardId, Authentication authentication) {
        return service.get(cardId, backOffice(authentication));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse create(@Valid @RequestBody CardDtos.CreateCardRequest request, Authentication authentication) {
        authz.requireTournamentCapability(authentication, request.tournamentId(), Capability.RUN_TOURNAMENT);
        return service.create(request, authentication.getName());
    }

    @PostMapping("/{cardId}/close")
    public CardDtos.CardResponse close(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.close(cardId, authentication.getName());
    }

    @DeleteMapping("/{cardId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        service.delete(cardId);
    }

    @PostMapping("/{cardId}/players")
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse addPlayer(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        checkVersion(cardId, ifMatch);
        return service.addPlayer(cardId, request, authentication.getName());
    }

    @PutMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse updatePlayer(@PathVariable UUID cardId, @PathVariable String playerId, @RequestHeader("If-Match") String ifMatch,
                                               @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        checkVersion(cardId, ifMatch);
        boolean operator = authz.isAdmin(authentication) || authz.isDirector(authentication);
        return service.updatePlayer(cardId, playerId, request, authentication.getName(), operator);
    }

    @DeleteMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse removePlayer(@PathVariable UUID cardId, @PathVariable String playerId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        checkVersion(cardId, ifMatch);
        return service.removePlayer(cardId, playerId, authentication.getName());
    }

    @PostMapping("/{cardId}/registration/finish")
    public CardDtos.CardResponse finishRegistration(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.finishRegistration(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/tables/swap")
    public CardDtos.CardResponse swap(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, @Valid @RequestBody CardDtos.SwapRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.swapPlayers(cardId, request, authentication.getName());
    }

    @PostMapping("/{cardId}/pairings/preview")
    public CardDtos.CardResponse previewPairings(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.generatePairingPreview(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/pairings/undo")
    public CardDtos.CardResponse undoPairing(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.undoPairing(cardId, authentication.getName());
    }

    @PutMapping("/{cardId}/matches/{matchId}/result")
    public CardDtos.CardResponse submitResult(@PathVariable UUID cardId, @PathVariable UUID matchId, @RequestHeader("If-Match") String ifMatch,
                                               @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.SUBMIT_RESULT);
        checkVersion(cardId, ifMatch);
        return service.submitResult(cardId, matchId, request, authentication.getName());
    }

    @PutMapping("/{cardId}/matches/{matchId}/override")
    public CardDtos.CardResponse overrideResult(@PathVariable UUID cardId, @PathVariable UUID matchId, @RequestHeader("If-Match") String ifMatch,
                                                @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.overrideResult(cardId, matchId, request, authentication.getName());
    }

    @PostMapping("/{cardId}/pairings/confirm")
    public CardDtos.CardResponse confirm(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.confirmPairingPreview(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/results/review")
    public CardDtos.CardResponse reviewResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.reviewResults(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/results/reopen")
    public CardDtos.CardResponse reopenResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.reopenResults(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/results/publish")
    public CardDtos.CardResponse publishResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        checkVersion(cardId, ifMatch);
        return service.publishResults(cardId, authentication.getName());
    }

    /** Any authenticated back-office principal (admin/director/staff) sees the internal staff view. */
    private boolean backOffice(Authentication authentication) {
        return authz.isAdmin(authentication) || authz.isDirector(authentication) || authz.isStaff(authentication);
    }

    private void checkVersion(UUID cardId, String ifMatch) {
        try {
            service.assertVersion(cardId, Long.parseLong(ifMatch.replace("\"", "").trim()));
        } catch (NumberFormatException error) {
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid If-Match header");
        }
    }
}
