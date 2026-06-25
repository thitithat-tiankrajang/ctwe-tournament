package com.ctwe.tournament.infrastructure.security;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.util.Set;
import java.util.UUID;

/**
 * Central authorization for the three-tier RBAC model.
 *
 * <ul>
 *   <li>ADMIN  - platform provider: full access to every tournament.</li>
 *   <li>DIRECTOR - runs the tournaments assigned to them (tournament_members).</li>
 *   <li>STAFF - data entry only, scoped to their creator director's tournaments.</li>
 * </ul>
 *
 * Stage windows (e.g. results only during RESULT_COLLECTION) are enforced downstream in
 * {@code TournamentCardService}; this layer only decides role + tenant scope.
 */
@Service
public class AuthorizationService {
    /** RUN_TOURNAMENT covers every operator action (pairing, publish, manage cards/players any time). */
    public enum Capability { MANAGE_PLAYERS, SUBMIT_RESULT, RUN_TOURNAMENT }

    private final JdbcTemplate jdbc;

    public AuthorizationService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public boolean hasRole(Authentication auth, String role) {
        return auth != null && auth.isAuthenticated()
            && auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals(role));
    }

    public boolean isAdmin(Authentication auth) { return hasRole(auth, "ROLE_ADMIN"); }
    public boolean isDirector(Authentication auth) { return hasRole(auth, "ROLE_DIRECTOR"); }
    public boolean isStaff(Authentication auth) { return hasRole(auth, "ROLE_STAFF"); }

    /** Tournament ids this user may touch. Admins are unrestricted (callers must special-case). */
    public Set<UUID> accessibleTournamentIds(Authentication auth) {
        String user = auth.getName();
        if (isDirector(auth))
            return idSet("SELECT tournament_id FROM tournament_members WHERE username = ?", user);
        if (isStaff(auth))
            return idSet("SELECT tournament_id FROM staff_tournament_access WHERE username = ?", user);
        return Set.of();
    }

    public UUID tournamentOfCard(UUID cardId) {
        try {
            return jdbc.queryForObject("SELECT tournament_id FROM tournament_cards WHERE id = ?", UUID.class, cardId);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found");
        }
    }

    public void requireTournamentAccess(Authentication auth, UUID tournamentId) {
        if (isAdmin(auth)) return;
        if (tournamentId == null || !accessibleTournamentIds(auth).contains(tournamentId))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "ไม่มีสิทธิ์เข้าถึงรายการแข่งขันนี้");
    }

    public void requireTournamentCapability(Authentication auth, UUID tournamentId, Capability capability) {
        requireTournamentAccess(auth, tournamentId);
        requireTournamentOpen(tournamentId);
        enforceRole(auth, capability);
    }

    public void requireCardCapability(Authentication auth, UUID cardId, Capability capability) {
        UUID tournamentId = tournamentOfCard(cardId);
        requireTournamentAccess(auth, tournamentId);
        requireTournamentOpen(tournamentId);
        enforceRole(auth, capability);
    }

    /** A CLOSED tournament is read-only for everyone (an admin must reopen it first). */
    private void requireTournamentOpen(UUID tournamentId) {
        if (tournamentId == null) return; // legacy cards without a tournament
        String status;
        try { status = jdbc.queryForObject("SELECT status FROM tournaments WHERE id = ?", String.class, tournamentId); }
        catch (EmptyResultDataAccessException error) { throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament not found"); }
        if ("CLOSED".equals(status))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "รายการแข่งขันนี้ถูกปิดอยู่ (CLOSED) — ผู้ดูแลระบบต้องเปิดก่อนจึงจะแก้ไขได้");
    }

    private void enforceRole(Authentication auth, Capability capability) {
        if (isAdmin(auth) || isDirector(auth)) return; // operators may do everything within scope
        // Remaining principals are result-entry staff.
        if (capability == Capability.RUN_TOURNAMENT)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "การดำเนินการนี้สงวนสำหรับผู้อำนวยการเท่านั้น");
        // MANAGE_PLAYERS and SUBMIT_RESULT are permitted; the stage window is enforced downstream.
    }

    private Set<UUID> idSet(String sql, Object... args) {
        return Set.copyOf(jdbc.queryForList(sql, UUID.class, args));
    }
}
