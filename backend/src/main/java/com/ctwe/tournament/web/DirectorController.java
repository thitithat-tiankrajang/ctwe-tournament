package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.web.dto.TenantDtos;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/** Director API: manage the result-entry staff accounts the director owns. */
@RestController
@RequestMapping("/api/director")
public class DirectorController {
    private final TenantService tenant;

    public DirectorController(TenantService tenant) { this.tenant = tenant; }

    @GetMapping("/staff")
    public List<TenantDtos.UserResponse> listStaff(Authentication auth) {
        return tenant.listStaff(auth.getName());
    }

    @PostMapping("/staff")
    @ResponseStatus(HttpStatus.CREATED)
    public TenantDtos.UserResponse createStaff(@Valid @RequestBody TenantDtos.CreateStaffRequest request,
                                               Authentication auth) {
        return tenant.createStaff(request, auth.getName());
    }

    @DeleteMapping("/staff/{username}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteStaff(@PathVariable String username, Authentication auth) {
        tenant.deleteStaff(username, auth.getName(), auth.getName());
    }

    @PatchMapping("/staff/{username}/enabled")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void setStaffEnabled(@PathVariable String username, @Valid @RequestBody TenantDtos.EnabledRequest request,
                                Authentication auth) {
        tenant.requireOwnedStaff(username, auth.getName());
        tenant.setEnabled(username, request.enabled(), auth.getName());
    }

    @PostMapping("/staff/{username}/password")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void resetStaffPassword(@PathVariable String username, @Valid @RequestBody TenantDtos.PasswordRequest request,
                                   Authentication auth) {
        tenant.requireOwnedStaff(username, auth.getName());
        tenant.resetPassword(username, request.password(), auth.getName());
    }

    @PostMapping("/staff/{username}/tournaments")
    public TenantDtos.UserResponse grantTournament(@PathVariable String username,
                                                   @Valid @RequestBody TenantDtos.GrantTournamentRequest request,
                                                   Authentication auth) {
        return tenant.grantStaffTournament(username, request.tournamentId(), auth.getName());
    }

    @DeleteMapping("/staff/{username}/tournaments/{tournamentId}")
    public TenantDtos.UserResponse revokeTournament(@PathVariable String username, @PathVariable UUID tournamentId,
                                                    Authentication auth) {
        return tenant.revokeStaffTournament(username, tournamentId, auth.getName());
    }
}
