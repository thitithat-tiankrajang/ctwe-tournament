package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.TenantDtos;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Account and tenant management for the multi-tenant model.
 *
 * <p>Admin operations create/delete tournaments and director accounts and wire directors to
 * tournaments. Director operations manage their own result-entry staff. All mutations are audited.
 */
@Service
public class TenantService {
    private final JdbcTemplate jdbc;
    private final PasswordEncoder passwordEncoder;
    private final ObjectMapper objectMapper;

    public TenantService(JdbcTemplate jdbc, PasswordEncoder passwordEncoder, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.passwordEncoder = passwordEncoder;
        this.objectMapper = objectMapper;
    }

    // ----------------------------------------------------------------- tournaments (admin)

    @Transactional
    public TenantDtos.TournamentResponse createTournament(String name, String actor) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, created_by) VALUES (?, ?, ?)", id, name.trim(), actor);
        audit(actor, "CREATE_TOURNAMENT", null, Map.of("id", id.toString(), "name", name.trim()));
        return getTournament(id);
    }

    /** restrictTo == null lists every tournament (admin); an empty list yields no rows. */
    @Transactional(readOnly = true)
    public List<TenantDtos.TournamentResponse> listTournaments(List<UUID> restrictTo) {
        if (restrictTo != null && restrictTo.isEmpty()) return List.of();
        String where = restrictTo == null ? ""
            : " WHERE t.id IN (" + String.join(", ", java.util.Collections.nCopies(restrictTo.size(), "?")) + ")";
        String sql = """
            SELECT t.id, t.name, t.status, t.access_token, t.created_by, t.created_at, t.version,
                   (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id) AS card_count
            FROM tournaments t""" + where + " ORDER BY t.created_at DESC";
        List<TenantDtos.TournamentResponse> base = restrictTo == null
            ? jdbc.query(sql, this::mapTournament)
            : jdbc.query(sql, this::mapTournament, restrictTo.toArray());
        return base.stream().map(t -> new TenantDtos.TournamentResponse(
            t.id(), t.name(), t.status(), t.createdBy(), t.createdAt(), t.version(), directorsOf(t.id()), t.cardCount(), t.accessToken())).toList();
    }

    @Transactional(readOnly = true)
    public TenantDtos.TournamentResponse getTournament(UUID id) {
        try {
            TenantDtos.TournamentResponse base = jdbc.queryForObject("""
                SELECT t.id, t.name, t.status, t.access_token, t.created_by, t.created_at, t.version,
                       (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id) AS card_count
                FROM tournaments t WHERE t.id = ?
                """, this::mapTournament, id);
            return new TenantDtos.TournamentResponse(base.id(), base.name(), base.status(), base.createdBy(), base.createdAt(),
                base.version(), directorsOf(id), base.cardCount(), base.accessToken());
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament not found");
        }
    }

    @Transactional
    public TenantDtos.TournamentResponse setTournamentStatus(UUID id, boolean open, String actor) {
        getTournament(id);
        jdbc.update("UPDATE tournaments SET status = ?, version = version + 1 WHERE id = ?", open ? "OPEN" : "CLOSED", id);
        audit(actor, open ? "OPEN_TOURNAMENT" : "CLOSE_TOURNAMENT", null, Map.of("id", id.toString()));
        return getTournament(id);
    }

    @Transactional
    public void deleteTournament(UUID id, String actor) {
        getTournament(id); // 404 if missing
        // SAFETY (2026-06-25 incident): never cascade-delete cards. A tournament can only be removed
        // once it is empty, so deleting one can never wipe player/match data by accident. Cards must be
        // deleted (or moved) one-by-one and deliberately first.
        Integer cardCount = jdbc.queryForObject("SELECT count(*) FROM tournament_cards WHERE tournament_id = ?", Integer.class, id);
        if (cardCount != null && cardCount > 0)
            throw new IllegalArgumentException("ลบทัวร์นาเมนต์ไม่ได้: ยังมี " + cardCount + " การ์ดอยู่ข้างใน — ต้องลบหรือย้ายการ์ดออกให้หมดก่อน");
        jdbc.update("DELETE FROM tournaments WHERE id = ?", id); // cascades tournament_members only (no cards left)
        audit(actor, "DELETE_TOURNAMENT", Map.of("id", id.toString()), null);
    }

    @Transactional
    public TenantDtos.TournamentResponse assignDirector(UUID tournamentId, String username, String actor) {
        getTournament(tournamentId);
        requireRole(username, "ROLE_DIRECTOR");
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?) ON CONFLICT DO NOTHING",
            tournamentId, username);
        audit(actor, "ASSIGN_DIRECTOR", null, Map.of("tournament", tournamentId.toString(), "director", username));
        return getTournament(tournamentId);
    }

    @Transactional
    public TenantDtos.TournamentResponse unassignDirector(UUID tournamentId, String username, String actor) {
        getTournament(tournamentId);
        jdbc.update("DELETE FROM tournament_members WHERE tournament_id = ? AND username = ?", tournamentId, username);
        audit(actor, "UNASSIGN_DIRECTOR", Map.of("tournament", tournamentId.toString(), "director", username), null);
        return getTournament(tournamentId);
    }

    // ----------------------------------------------------------------- directors (admin)

    @Transactional
    public TenantDtos.UserResponse createDirector(TenantDtos.CreateDirectorRequest request, String actor) {
        createAccount(request.username(), request.password(), "ROLE_DIRECTOR", null);
        if (request.tournamentIds() != null) {
            for (UUID tournamentId : request.tournamentIds()) {
                getTournament(tournamentId);
                jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?) ON CONFLICT DO NOTHING",
                    tournamentId, request.username());
            }
        }
        audit(actor, "CREATE_DIRECTOR", null, Map.of("username", request.username(),
            "tournaments", request.tournamentIds() == null ? List.of() : request.tournamentIds()));
        return getUser(request.username());
    }

    @Transactional(readOnly = true)
    public List<TenantDtos.UserResponse> listDirectors() {
        return jdbc.query("""
            SELECT sa.username, sa.enabled, sa.created_by, sa.created_at
            FROM staff_accounts sa JOIN staff_authorities a ON a.username = sa.username
            WHERE a.authority = 'ROLE_DIRECTOR' ORDER BY sa.created_at
            """, (rs, row) -> toUser(rs.getString("username"), "ROLE_DIRECTOR", rs.getBoolean("enabled"),
                rs.getString("created_by"), rs.getTimestamp("created_at").toInstant()));
    }

    @Transactional
    public void deleteDirector(String username, String actor) {
        requireRole(username, "ROLE_DIRECTOR");
        // Remove the staff the director created (their authorities cascade), then the director.
        jdbc.update("DELETE FROM staff_accounts WHERE created_by = ?", username);
        jdbc.update("DELETE FROM staff_accounts WHERE username = ?", username); // cascades authorities + memberships
        audit(actor, "DELETE_DIRECTOR", Map.of("username", username), null);
    }

    // ----------------------------------------------------------------- staff (director)

    @Transactional
    public TenantDtos.UserResponse createStaff(TenantDtos.CreateStaffRequest request, String director) {
        createAccount(request.username(), request.password(), "ROLE_STAFF", director);
        audit(director, "CREATE_STAFF", null, Map.of("username", request.username(), "createdBy", director));
        return getUser(request.username());
    }

    @Transactional(readOnly = true)
    public List<TenantDtos.UserResponse> listStaff(String director) {
        return jdbc.query("""
            SELECT username, enabled, created_by, created_at FROM staff_accounts
            WHERE created_by = ? ORDER BY created_at
            """, (rs, row) -> toUser(rs.getString("username"), "ROLE_STAFF", rs.getBoolean("enabled"),
                rs.getString("created_by"), rs.getTimestamp("created_at").toInstant()), director);
    }

    @Transactional
    public void deleteStaff(String username, String director, String actor) {
        requireOwnedStaff(username, director);
        jdbc.update("DELETE FROM staff_accounts WHERE username = ?", username);
        audit(actor, "DELETE_STAFF", Map.of("username", username), null);
    }

    /** Grant a staff access to one of the director's own tournaments (sees all its cards). */
    @Transactional
    public TenantDtos.UserResponse grantStaffTournament(String staff, UUID tournamentId, String director) {
        requireOwnedStaff(staff, director);
        Long inScope = jdbc.queryForObject(
            "SELECT COUNT(*) FROM tournament_members WHERE username = ? AND tournament_id = ?", Long.class, director, tournamentId);
        if (inScope == null || inScope == 0)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "คุณไม่มีสิทธิ์ในรายการแข่งขันนี้ จึงมอบให้เจ้าหน้าที่ไม่ได้");
        // A staff account is bound to exactly one tournament: granting a new one replaces the old.
        jdbc.update("DELETE FROM staff_tournament_access WHERE username = ?", staff);
        jdbc.update("INSERT INTO staff_tournament_access (username, tournament_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            staff, tournamentId);
        audit(director, "GRANT_STAFF_TOURNAMENT", null, Map.of("staff", staff, "tournament", tournamentId.toString()));
        return getUser(staff);
    }

    @Transactional
    public TenantDtos.UserResponse revokeStaffTournament(String staff, UUID tournamentId, String director) {
        requireOwnedStaff(staff, director);
        jdbc.update("DELETE FROM staff_tournament_access WHERE username = ? AND tournament_id = ?", staff, tournamentId);
        audit(director, "REVOKE_STAFF_TOURNAMENT", Map.of("staff", staff, "tournament", tournamentId.toString()), null);
        return getUser(staff);
    }

    // ----------------------------------------------------------------- shared account ops

    @Transactional
    public void setEnabled(String username, boolean enabled, String actor) {
        if (jdbc.update("UPDATE staff_accounts SET enabled = ?, failed_attempts = 0, locked_until = NULL WHERE username = ?",
            enabled, username) == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Account not found");
        audit(actor, enabled ? "ENABLE_ACCOUNT" : "DISABLE_ACCOUNT", null, Map.of("username", username));
    }

    @Transactional
    public void resetPassword(String username, String password, String actor) {
        if (jdbc.update("""
            UPDATE staff_accounts SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE username = ?
            """, passwordEncoder.encode(password), username) == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Account not found");
        audit(actor, "RESET_PASSWORD", null, Map.of("username", username));
    }

    public void requireOwnedStaff(String username, String director) {
        Long owned = jdbc.queryForObject(
            "SELECT COUNT(*) FROM staff_accounts WHERE username = ? AND created_by = ?", Long.class, username, director);
        if (owned == null || owned == 0)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "บัญชีนี้ไม่ได้อยู่ภายใต้การดูแลของคุณ");
    }

    public String roleOf(String username) {
        try {
            return jdbc.queryForObject("SELECT authority FROM staff_authorities WHERE username = ?", String.class, username);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Account not found");
        }
    }

    // ----------------------------------------------------------------- helpers

    private void createAccount(String username, String password, String authority, String createdBy) {
        Long exists = jdbc.queryForObject("SELECT COUNT(*) FROM staff_accounts WHERE username = ?", Long.class, username);
        if (exists != null && exists > 0)
            throw new ResponseStatusException(HttpStatus.CONFLICT, "มีชื่อผู้ใช้นี้อยู่แล้ว");
        jdbc.update("INSERT INTO staff_accounts (username, password_hash, enabled, created_by) VALUES (?, ?, true, ?)",
            username, passwordEncoder.encode(password), createdBy);
        jdbc.update("INSERT INTO staff_authorities (username, authority) VALUES (?, ?)", username, authority);
    }

    private void requireRole(String username, String authority) {
        if (!authority.equals(roleOf(username)))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "บัญชีนี้ไม่ใช่บทบาทที่ถูกต้องสำหรับการดำเนินการนี้");
    }

    private TenantDtos.UserResponse getUser(String username) {
        return jdbc.queryForObject("""
            SELECT sa.username, sa.enabled, sa.created_by, sa.created_at, a.authority
            FROM staff_accounts sa JOIN staff_authorities a ON a.username = sa.username WHERE sa.username = ?
            """, (rs, row) -> toUser(rs.getString("username"), rs.getString("authority"), rs.getBoolean("enabled"),
                rs.getString("created_by"), rs.getTimestamp("created_at").toInstant()), username);
    }

    private TenantDtos.UserResponse toUser(String username, String role, boolean enabled, String createdBy,
                                           java.time.Instant createdAt) {
        List<UUID> tournamentIds = switch (role) {
            case "ROLE_DIRECTOR" -> jdbc.queryForList(
                "SELECT tournament_id FROM tournament_members WHERE username = ?", UUID.class, username);
            case "ROLE_STAFF" -> jdbc.queryForList(
                "SELECT tournament_id FROM staff_tournament_access WHERE username = ?", UUID.class, username);
            default -> List.of();
        };
        return new TenantDtos.UserResponse(username, role, enabled, createdBy, createdAt, tournamentIds);
    }

    private List<String> directorsOf(UUID tournamentId) {
        return jdbc.queryForList("SELECT username FROM tournament_members WHERE tournament_id = ? ORDER BY username",
            String.class, tournamentId);
    }

    private TenantDtos.TournamentResponse mapTournament(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new TenantDtos.TournamentResponse(
            rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("status"), rs.getString("created_by"),
            rs.getTimestamp("created_at").toInstant(), rs.getLong("version"), null, rs.getInt("card_count"),
            rs.getString("access_token"));
    }

    // ----------------------------------------------------------------- public (anonymous) read model

    /** OPEN tournaments only, for the public root landing — published-card count drives "เปิดให้ติดตาม". */
    @Transactional(readOnly = true)
    public List<TenantDtos.PublicTournamentResponse> listOpenTournaments() {
        return jdbc.query("""
            SELECT t.id, t.name, t.access_token,
                   (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id) AS card_count,
                   (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id
                        AND c.status IN ('FINISHED', 'CLOSED')) AS published_card_count
            FROM tournaments t WHERE t.status = 'OPEN' ORDER BY t.created_at DESC
            """, (rs, row) -> new TenantDtos.PublicTournamentResponse(
                rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("access_token"),
                rs.getInt("card_count"), rs.getInt("published_card_count")));
    }

    /** Resolve a shared access token to its OPEN tournament; 404 when missing or CLOSED (the link gate). */
    @Transactional(readOnly = true)
    public TenantDtos.PublicTournamentResponse resolveOpenTournament(String accessToken) {
        try {
            return jdbc.queryForObject("""
                SELECT t.id, t.name, t.access_token,
                       (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id) AS card_count,
                       (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id
                            AND c.status IN ('FINISHED', 'CLOSED')) AS published_card_count
                FROM tournaments t WHERE t.access_token = ? AND t.status = 'OPEN'
                """, (rs, row) -> new TenantDtos.PublicTournamentResponse(
                    rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("access_token"),
                    rs.getInt("card_count"), rs.getInt("published_card_count")), accessToken);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament not found or not open");
        }
    }

    private void audit(String actor, String action, Object oldValue, Object newValue) {
        jdbc.update("""
            INSERT INTO audit_logs (card_id, actor, action, old_value, new_value)
            VALUES (NULL, ?, ?, ?, ?)
            """, actor, action, auditText(oldValue), auditText(newValue));
    }

    /** Audit values are stored as plain TEXT: strings as-is, structured values as compact JSON text. */
    private String auditText(Object value) {
        if (value == null) return null;
        if (value instanceof String text) return text;
        try { return objectMapper.writeValueAsString(value); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Cannot serialize audit data", error); }
    }
}
