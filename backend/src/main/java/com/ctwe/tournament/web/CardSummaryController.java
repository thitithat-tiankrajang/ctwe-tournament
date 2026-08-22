package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.web.dto.BackOfficeCardDtos;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Lean, authenticated card rows for the back-office list and sidebar.
 *
 * <p><b>Why not {@code /api/cards/summaries}.</b> {@code SecurityConfiguration} matches
 * {@code GET /api/cards, /api/cards/**} with {@code permitAll()}, so anything placed under that
 * prefix is anonymous-reachable unless a narrower matcher is inserted ahead of it. Living outside
 * that prefix means this endpoint falls through to the {@code /api/**} rule, which already requires
 * ADMIN, DIRECTOR or STAFF — no change to the security configuration at all. It also removes a
 * failure mode: a literal {@code summaries} segment competing with {@code /api/cards/{cardId}} would
 * fail UUID conversion and return 400, which a 404-only client fallback would not catch.
 *
 * <p><b>There is deliberately no anonymous branch.</b> {@code CardController.list()} falls back to
 * the public projection for callers without a back-office role, and that is exactly why a staff
 * session evicted by {@code maximumSessions(2)} silently receives public data — public stage and
 * public version — instead of a 401. Measured: staff version 11 vs public 7, real stage
 * PAIRING_PREVIEW vs public TABLE_PAIRING. This endpoint answers 401 instead, so an evicted session
 * is told it is dead rather than handed a plausible, wrong card list.
 */
@RestController
@RequestMapping("/api/card-summaries")
public class CardSummaryController {
    private final TournamentCardService service;
    private final AuthorizationService authz;

    public CardSummaryController(TournamentCardService service, AuthorizationService authz) {
        this.service = service;
        this.authz = authz;
    }

    @GetMapping
    public List<BackOfficeCardDtos.CardSummary> summaries(Authentication authentication) {
        // Belt and braces: the security matcher already rejects anonymous callers, but the whole
        // point of this endpoint is that it never degrades to public data, so it refuses locally too.
        if (!backOffice(authentication)) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        // Same tenant scoping as CardController.list(): admins are unrestricted, everyone else is
        // limited to the tournaments they are actually assigned to.
        Set<UUID> restrict = (authz.isDirector(authentication) || authz.isStaff(authentication))
            ? authz.accessibleTournamentIds(authentication) : null;
        return service.summaries(restrict);
    }

    private boolean backOffice(Authentication authentication) {
        return authz.isAdmin(authentication) || authz.isDirector(authentication) || authz.isStaff(authentication);
    }
}
