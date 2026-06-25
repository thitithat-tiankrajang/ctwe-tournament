package com.ctwe.tournament.infrastructure.security;

import com.ctwe.tournament.infrastructure.security.AuthorizationService.Capability;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AuthorizationServiceTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final AuthorizationService authz = new AuthorizationService(jdbc);
    private final UUID cardId = UUID.randomUUID();
    private final UUID tournamentId = UUID.randomUUID();

    private Authentication auth(String role) {
        return new UsernamePasswordAuthenticationToken("user", "n/a", List.of(new SimpleGrantedAuthority(role)));
    }

    private void cardBelongsToTournament() {
        when(jdbc.queryForObject(anyString(), eq(UUID.class), any())).thenReturn(tournamentId);
    }

    private void userTournaments(UUID... ids) {
        when(jdbc.queryForList(anyString(), eq(UUID.class), any())).thenReturn(List.of(ids));
    }

    @Test
    void adminMayRunAnyTournamentRegardlessOfAssignment() {
        cardBelongsToTournament();
        userTournaments(); // admin has no membership rows, must still pass
        assertThatCode(() -> authz.requireCardCapability(auth("ROLE_ADMIN"), cardId, Capability.RUN_TOURNAMENT))
            .doesNotThrowAnyException();
    }

    @Test
    void directorAssignedToTournamentMayRunIt() {
        cardBelongsToTournament();
        userTournaments(tournamentId);
        assertThatCode(() -> authz.requireCardCapability(auth("ROLE_DIRECTOR"), cardId, Capability.RUN_TOURNAMENT))
            .doesNotThrowAnyException();
    }

    @Test
    void directorNotAssignedToTournamentIsForbidden() {
        cardBelongsToTournament();
        userTournaments(); // assigned to nothing
        assertThatThrownBy(() -> authz.requireCardCapability(auth("ROLE_DIRECTOR"), cardId, Capability.RUN_TOURNAMENT))
            .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void staffMayEnterDataButNotRunTournament() {
        cardBelongsToTournament();
        userTournaments(tournamentId); // staff is in scope of this tournament
        assertThatCode(() -> authz.requireCardCapability(auth("ROLE_STAFF"), cardId, Capability.SUBMIT_RESULT))
            .doesNotThrowAnyException();
        assertThatCode(() -> authz.requireCardCapability(auth("ROLE_STAFF"), cardId, Capability.MANAGE_PLAYERS))
            .doesNotThrowAnyException();
        assertThatThrownBy(() -> authz.requireCardCapability(auth("ROLE_STAFF"), cardId, Capability.RUN_TOURNAMENT))
            .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void staffOutsideTournamentScopeIsForbiddenEvenForResultEntry() {
        cardBelongsToTournament();
        userTournaments(); // not scoped to this card's tournament
        assertThatThrownBy(() -> authz.requireCardCapability(auth("ROLE_STAFF"), cardId, Capability.SUBMIT_RESULT))
            .isInstanceOf(ResponseStatusException.class);
    }
}
