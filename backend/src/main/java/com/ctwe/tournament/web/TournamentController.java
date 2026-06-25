package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Tournaments visible to the authenticated operator (admin = all, director/staff = their scope). */
@RestController
@RequestMapping("/api/tournaments")
public class TournamentController {
    private final TenantService tenant;
    private final AuthorizationService authz;

    public TournamentController(TenantService tenant, AuthorizationService authz) {
        this.tenant = tenant;
        this.authz = authz;
    }

    @GetMapping
    public List<TenantDtos.TournamentResponse> mine(Authentication auth) {
        if (authz.isAdmin(auth)) return tenant.listTournaments(null);
        return tenant.listTournaments(List.copyOf(authz.accessibleTournamentIds(auth)));
    }
}
