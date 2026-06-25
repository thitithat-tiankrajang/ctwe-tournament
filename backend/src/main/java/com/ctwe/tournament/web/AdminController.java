package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.web.dto.TenantDtos;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/** Platform-admin API: provision tournaments and director accounts, wire directors to tournaments. */
@RestController
@RequestMapping("/api/admin")
public class AdminController {
    private final TenantService tenant;

    public AdminController(TenantService tenant) { this.tenant = tenant; }

    // --- tournaments ---
    @GetMapping("/tournaments")
    public List<TenantDtos.TournamentResponse> listTournaments() {
        return tenant.listTournaments(null);
    }

    @PostMapping("/tournaments")
    @ResponseStatus(HttpStatus.CREATED)
    public TenantDtos.TournamentResponse createTournament(@Valid @RequestBody TenantDtos.CreateTournamentRequest request,
                                                          Authentication auth) {
        return tenant.createTournament(request.name(), auth.getName());
    }

    @DeleteMapping("/tournaments/{tournamentId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteTournament(@PathVariable UUID tournamentId, Authentication auth) {
        tenant.deleteTournament(tournamentId, auth.getName());
    }

    @PatchMapping("/tournaments/{tournamentId}/status")
    public TenantDtos.TournamentResponse setTournamentStatus(@PathVariable UUID tournamentId,
                                                             @Valid @RequestBody TenantDtos.TournamentStatusRequest request,
                                                             Authentication auth) {
        return tenant.setTournamentStatus(tournamentId, request.open(), auth.getName());
    }

    @PostMapping("/tournaments/{tournamentId}/directors")
    public TenantDtos.TournamentResponse assignDirector(@PathVariable UUID tournamentId,
                                                        @Valid @RequestBody TenantDtos.AssignDirectorRequest request,
                                                        Authentication auth) {
        return tenant.assignDirector(tournamentId, request.username(), auth.getName());
    }

    @DeleteMapping("/tournaments/{tournamentId}/directors/{username}")
    public TenantDtos.TournamentResponse unassignDirector(@PathVariable UUID tournamentId, @PathVariable String username,
                                                          Authentication auth) {
        return tenant.unassignDirector(tournamentId, username, auth.getName());
    }

    // --- directors ---
    @GetMapping("/directors")
    public List<TenantDtos.UserResponse> listDirectors() {
        return tenant.listDirectors();
    }

    @PostMapping("/directors")
    @ResponseStatus(HttpStatus.CREATED)
    public TenantDtos.UserResponse createDirector(@Valid @RequestBody TenantDtos.CreateDirectorRequest request,
                                                  Authentication auth) {
        return tenant.createDirector(request, auth.getName());
    }

    @DeleteMapping("/directors/{username}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteDirector(@PathVariable String username, Authentication auth) {
        tenant.deleteDirector(username, auth.getName());
    }

    @PatchMapping("/directors/{username}/enabled")
    public void setDirectorEnabled(@PathVariable String username, @Valid @RequestBody TenantDtos.EnabledRequest request,
                                   Authentication auth) {
        requireDirector(username);
        tenant.setEnabled(username, request.enabled(), auth.getName());
    }

    @PostMapping("/directors/{username}/password")
    public void resetDirectorPassword(@PathVariable String username, @Valid @RequestBody TenantDtos.PasswordRequest request,
                                      Authentication auth) {
        requireDirector(username);
        tenant.resetPassword(username, request.password(), auth.getName());
    }

    private void requireDirector(String username) {
        if (!"ROLE_DIRECTOR".equals(tenant.roleOf(username)))
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.BAD_REQUEST, "บัญชีนี้ไม่ใช่ผู้อำนวยการ");
    }
}
