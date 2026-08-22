package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Authorization and tenant scoping for {@code GET /api/card-summaries}. No database, so this runs in
 * CI; the real SQL and the value contract are covered by {@code CardSummaryEndpointDatabaseTest}.
 *
 * <p>The behaviour under test that matters most is a <em>negative</em> one: unlike
 * {@code CardController.list()}, this endpoint must never fall back to the public projection. That
 * fallback is why an evicted staff session is handed public data instead of a 401.
 */
class CardSummaryControllerTest {
    private final TournamentCardService service = mock(TournamentCardService.class);
    private final AuthorizationService authz = mock(AuthorizationService.class);
    private final CardSummaryController controller = new CardSummaryController(service, authz);

    private static Authentication principal(String name, String... roles) {
        return new UsernamePasswordAuthenticationToken(name, "n/a",
            java.util.Arrays.stream(roles).map(SimpleGrantedAuthority::new).map(a -> (org.springframework.security.core.GrantedAuthority) a).toList());
    }

    @Test
    @DisplayName("an anonymous caller gets 401 — never a public projection, unlike GET /api/cards")
    void anonymousIsRefusedRatherThanDowngraded() {
        Authentication anonymous = new AnonymousAuthenticationToken("key", "anonymousUser",
            List.of(new SimpleGrantedAuthority("ROLE_ANONYMOUS")));
        when(authz.isAdmin(any())).thenReturn(false);
        when(authz.isDirector(any())).thenReturn(false);
        when(authz.isStaff(any())).thenReturn(false);

        assertThatThrownBy(() -> controller.summaries(anonymous))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED));
    }

    @Test
    @DisplayName("a null authentication is refused too")
    void nullAuthenticationIsRefused() {
        when(authz.isAdmin(any())).thenReturn(false);
        when(authz.isDirector(any())).thenReturn(false);
        when(authz.isStaff(any())).thenReturn(false);

        assertThatThrownBy(() -> controller.summaries(null))
            .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    @DisplayName("an admin is unrestricted — null restriction, preserving today's contract (D3 narrowing is P2/P3)")
    void adminIsUnrestricted() {
        Authentication admin = principal("admin", "ROLE_ADMIN");
        when(authz.isAdmin(admin)).thenReturn(true);
        when(authz.isDirector(admin)).thenReturn(false);
        when(authz.isStaff(admin)).thenReturn(false);
        when(service.summaries(null)).thenReturn(List.of());

        controller.summaries(admin);

        verify(service).summaries(null);
    }

    @Test
    @DisplayName("a director sees only their assigned tournaments")
    void directorIsScopedToAssignedTournaments() {
        Authentication director = principal("director", "ROLE_DIRECTOR");
        Set<UUID> assigned = Set.of(UUID.randomUUID(), UUID.randomUUID());
        when(authz.isAdmin(director)).thenReturn(false);
        when(authz.isDirector(director)).thenReturn(true);
        when(authz.accessibleTournamentIds(director)).thenReturn(assigned);
        when(service.summaries(assigned)).thenReturn(List.of());

        controller.summaries(director);

        verify(service).summaries(assigned);
    }

    @Test
    @DisplayName("staff see only their granted tournaments")
    void staffIsScopedToGrantedTournaments() {
        Authentication staff = principal("staff", "ROLE_STAFF");
        Set<UUID> granted = Set.of(UUID.randomUUID());
        when(authz.isAdmin(staff)).thenReturn(false);
        when(authz.isDirector(staff)).thenReturn(false);
        when(authz.isStaff(staff)).thenReturn(true);
        when(authz.accessibleTournamentIds(staff)).thenReturn(granted);
        when(service.summaries(granted)).thenReturn(List.of());

        controller.summaries(staff);

        verify(service).summaries(granted);
    }

    @Test
    @DisplayName("a director with no assignments asks for the empty set, not for everything")
    void directorWithNoAssignmentsIsNotTreatedAsUnrestricted() {
        Authentication director = principal("newcomer", "ROLE_DIRECTOR");
        when(authz.isAdmin(director)).thenReturn(false);
        when(authz.isDirector(director)).thenReturn(true);
        when(authz.accessibleTournamentIds(director)).thenReturn(Set.of());
        when(service.summaries(Set.of())).thenReturn(List.of());

        assertThat(controller.summaries(director)).isEmpty();

        // The dangerous bug would be passing null here, which means "unrestricted".
        verify(service).summaries(Set.of());
    }
}
