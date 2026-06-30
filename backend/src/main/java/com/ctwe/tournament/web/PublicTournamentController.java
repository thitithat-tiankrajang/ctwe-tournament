package com.ctwe.tournament.web;

import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Anonymous, link-scoped entry point. The root landing lists OPEN tournaments; a shared access
 * token resolves to a single OPEN tournament and its published cards. A CLOSED (or unknown) token
 * 404s, which is how the admin OPEN/CLOSE toggle gates each private link.
 */
@RestController
@RequestMapping("/api/public/tournaments")
public class PublicTournamentController {
    private final TenantService tenant;
    private final PublicCardQueryService cards;

    public PublicTournamentController(TenantService tenant, PublicCardQueryService cards) {
        this.tenant = tenant;
        this.cards = cards;
    }

    @GetMapping
    public List<TenantDtos.PublicTournamentResponse> open() {
        return tenant.listOpenTournaments();
    }

    @GetMapping("/{token}")
    public TenantDtos.PublicTournamentResponse resolve(@PathVariable String token) {
        return tenant.resolveOpenTournament(token);
    }

    @GetMapping("/{token}/cards")
    public List<PublicCardDtos.CardSummary> cards(@PathVariable String token) {
        TenantDtos.PublicTournamentResponse tournament = tenant.resolveOpenTournament(token);
        return cards.summaries(tournament.id());
    }
}
