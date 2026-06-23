package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentCardService;
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

    public CardController(TournamentCardService service) { this.service = service; }

    @GetMapping
    public List<CardDtos.CardResponse> list(Authentication authentication) {
        return service.list(isStaff(authentication));
    }

    @GetMapping("/{cardId}")
    public CardDtos.CardResponse get(@PathVariable UUID cardId, Authentication authentication) {
        return service.get(cardId, isStaff(authentication));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse create(@Valid @RequestBody CardDtos.CreateCardRequest request, Authentication authentication) {
        return service.create(request, authentication.getName());
    }

    @PostMapping("/{cardId}/close")
    public CardDtos.CardResponse close(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.close(cardId, authentication.getName());
    }

    @DeleteMapping("/{cardId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID cardId) {
        service.delete(cardId);
    }

    @PostMapping("/{cardId}/players")
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse addPlayer(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.addPlayer(cardId, request, authentication.getName());
    }

    @PutMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse updatePlayer(@PathVariable UUID cardId, @PathVariable String playerId, @RequestHeader("If-Match") String ifMatch,
                                               @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.updatePlayer(cardId, playerId, request, authentication.getName());
    }

    @DeleteMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse removePlayer(@PathVariable UUID cardId, @PathVariable String playerId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.removePlayer(cardId, playerId, authentication.getName());
    }

    @PostMapping("/{cardId}/registration/finish")
    public CardDtos.CardResponse finishRegistration(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.finishRegistration(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/tables/swap")
    public CardDtos.CardResponse swap(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, @Valid @RequestBody CardDtos.SwapRequest request, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.swapPlayers(cardId, request, authentication.getName());
    }

    @PostMapping("/{cardId}/pairings/preview")
    public CardDtos.CardResponse previewPairings(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.generatePairingPreview(cardId, authentication.getName());
    }

    @PutMapping("/{cardId}/matches/{matchId}/result")
    public CardDtos.CardResponse submitResult(@PathVariable UUID cardId, @PathVariable UUID matchId, @RequestHeader("If-Match") String ifMatch,
                                               @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.submitResult(cardId, matchId, request, authentication.getName());
    }

    @PostMapping("/{cardId}/pairings/confirm")
    public CardDtos.CardResponse confirm(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.confirmPairingPreview(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/results/review")
    public CardDtos.CardResponse reviewResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.reviewResults(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/results/reopen")
    public CardDtos.CardResponse reopenResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.reopenResults(cardId, authentication.getName());
    }

    @PostMapping("/{cardId}/results/publish")
    public CardDtos.CardResponse publishResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.publishResults(cardId, authentication.getName());
    }

    private boolean isStaff(Authentication authentication) {
        return authentication != null && authentication.isAuthenticated()
            && authentication.getAuthorities().stream().anyMatch(authority -> authority.getAuthority().equals("ROLE_STAFF"));
    }

    private void checkVersion(UUID cardId, String ifMatch) {
        try {
            service.assertVersion(cardId, Long.parseLong(ifMatch.replace("\"", "").trim()));
        } catch (NumberFormatException error) {
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid If-Match header");
        }
    }
}
