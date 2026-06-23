package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.web.dto.CardDtos;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/dev/cards/{cardId}")
@ConditionalOnProperty(name = "app.dev-tools-enabled", havingValue = "true")
public class DevToolsController {
    private final TournamentCardService service;

    public DevToolsController(TournamentCardService service) { this.service = service; }

    @PostMapping("/players")
    public CardDtos.CardResponse players(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, @RequestParam int count, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.generateTestPlayers(cardId, count, authentication.getName());
    }

    @PostMapping("/results/auto")
    public CardDtos.CardResponse autoResults(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.autoResults(cardId, authentication.getName());
    }

    @PostMapping("/simulate")
    public CardDtos.CardResponse simulate(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.simulate(cardId, authentication.getName());
    }

    @PostMapping("/reset")
    public CardDtos.CardResponse reset(@PathVariable UUID cardId, @RequestHeader("If-Match") String ifMatch, Authentication authentication) {
        checkVersion(cardId, ifMatch);
        return service.resetRuntime(cardId, authentication.getName());
    }

    private void checkVersion(UUID cardId, String ifMatch) {
        try { service.assertVersion(cardId, Long.parseLong(ifMatch.replace("\"", "").trim())); }
        catch (NumberFormatException error) { throw new IllegalArgumentException("Invalid If-Match header"); }
    }
}
