package com.ctwe.tournament.application.excelexport;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Guards on the DESTRUCTIVE path. The point of every test here is the same: nothing may be deleted
 * unless the operator named the exact tournament they meant to destroy.
 */
class TournamentExcelExportServiceTest {
    private static final String NAME = "CTWE 2026 รอบชิงชนะเลิศ";
    private static final String SELECT_NAME = "SELECT name FROM tournaments WHERE id = ?";

    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService cards = mock(TournamentCardService.class);
    private final TournamentExcelExportService service = new TournamentExcelExportService(jdbc, cards);
    private final UUID tournamentId = UUID.randomUUID();

    @BeforeEach
    void tournamentExists() {
        when(jdbc.queryForObject(SELECT_NAME, String.class, tournamentId)).thenReturn(NAME);
    }

    @Test
    @DisplayName("a mismatched tournament name aborts before anything is written or deleted")
    void rejectsMismatchedName() {
        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", "CTWE 2025"), "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST));

        // The decisive assertion: the guard runs BEFORE any destructive work.
        verifyNoInteractions(cards);
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    @DisplayName("a blank confirmation name aborts")
    void rejectsBlankName() {
        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", "   "), "admin"))
            .isInstanceOf(ResponseStatusException.class);

        verifyNoInteractions(cards);
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    @DisplayName("a null confirmation aborts instead of NPE-ing partway through")
    void rejectsNullConfirmation() {
        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(tournamentId, null, "admin"))
            .isInstanceOf(ResponseStatusException.class);

        verifyNoInteractions(cards);
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    @DisplayName("an unknown tournament is 404, not a partial purge")
    void rejectsUnknownTournament() {
        UUID missing = UUID.randomUUID();
        when(jdbc.queryForObject(SELECT_NAME, String.class, missing))
            .thenThrow(new EmptyResultDataAccessException(1));

        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            missing, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));

        verifyNoInteractions(cards);
    }

    @Test
    @DisplayName("an exact name (surrounding whitespace ignored) exports the workbook and purges")
    void purgesWhenNameMatches() {
        snapshotState("NOT_PUBLISHED");
        when(jdbc.queryForList(
            "SELECT id, name, division FROM tournament_cards WHERE tournament_id = ? ORDER BY created_at",
            tournamentId)).thenReturn(List.of());

        TenantDtos.ArchiveSummary summary = service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", "  " + NAME + "  "), "admin");

        assertThat(summary.tournamentName()).isEqualTo(NAME);
        assertThat(summary.fileName()).endsWith(".xlsx");
        assertThat(summary.byteSize()).isPositive();
        verify(jdbc).update("DELETE FROM tournaments WHERE id = ?", tournamentId);
    }

    // ================================================================== GUARDRAIL G1

    /**
     * G1 — purging is refused while a public snapshot is published.
     *
     * <p>A published snapshot is a permanent public artifact that must remain regenerable from
     * PostgreSQL. Deleting the live rows would leave the object serving from R2 with nothing behind
     * it: no correction, no re-verification, no rollback, ever. These tests are the runtime half of
     * the guardrail; the package-independence test is the structural half.
     */
    private void snapshotState(String state) {
        when(jdbc.queryForObject("SELECT snapshot_state FROM tournaments WHERE id = ?", String.class, tournamentId))
            .thenReturn(state);
    }

    @Test
    @DisplayName("G1: a PUBLISHED snapshot blocks the purge, and nothing is deleted")
    void refusesPurgeWhilePublished() {
        snapshotState("PUBLISHED");

        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT))
            .hasMessageContaining("ถอนการเผยแพร่");

        // The decisive assertion: the guard runs before ANY destructive work, and before the
        // workbook is even built — a correct name is not enough to get past it.
        verifyNoInteractions(cards);
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    @DisplayName("G1: a publish in flight also blocks the purge")
    void refusesPurgeWhilePublishing() {
        snapshotState("PUBLISHING");

        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class);

        verifyNoInteractions(cards);
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    @DisplayName("G1: a tournament that was never published purges normally")
    void allowsPurgeWhenNotPublished() {
        snapshotState("NOT_PUBLISHED");
        when(jdbc.queryForList(
            "SELECT id, name, division FROM tournament_cards WHERE tournament_id = ? ORDER BY created_at",
            tournamentId)).thenReturn(List.of());

        service.exportToExcelAndPurgeLiveData(tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin");

        verify(jdbc).update("DELETE FROM tournaments WHERE id = ?", tournamentId);
    }

    @Test
    @DisplayName("G1: PUBLISH_FAILED blocks the purge — a promoted-then-unverified object may be live")
    void refusesPurgeAfterFailedPublish() {
        // The state that motivates an allowlist. A publication that promotes the object and then
        // fails its post-promotion verification records no PROMOTED row, so the tournament lands in
        // PUBLISH_FAILED while s/{h}.json is being served. Purging here would delete the live rows
        // behind an object the world can still fetch — permanently unregenerable (I7).
        snapshotState("PUBLISH_FAILED");

        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));

        verifyNoInteractions(cards);
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    @DisplayName("G1: APPROVED blocks the purge, per the documented allowlist")
    void refusesPurgeWhenApproved() {
        // Phase E assigns this state. Nothing is public yet, but the guardrail is specified as
        // "throws unless NOT_PUBLISHED or RETRACTED" and is not weakened for convenience.
        snapshotState("APPROVED");

        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class);

        verifyNoInteractions(cards);
    }

    @Test
    @DisplayName("G1: an unrecognised or missing state is refused rather than assumed harmless")
    void refusesUnknownState() {
        // A future migration adding a state must fail closed here, not silently permit deletion.
        snapshotState("SOME_FUTURE_STATE");
        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class);

        snapshotState(null);
        assertThatThrownBy(() -> service.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin"))
            .isInstanceOf(ResponseStatusException.class);

        verifyNoInteractions(cards);
    }

    @Test
    @DisplayName("G1: retraction is the escape hatch — a RETRACTED tournament purges normally")
    void allowsPurgeAfterRetraction() {
        // Phase F is what sets this state; Phase B only has to not block on it. Withdrawing the
        // snapshot first, then purging, is the supported order — never weakening the check.
        snapshotState("RETRACTED");
        when(jdbc.queryForList(
            "SELECT id, name, division FROM tournament_cards WHERE tournament_id = ? ORDER BY created_at",
            tournamentId)).thenReturn(List.of());

        service.exportToExcelAndPurgeLiveData(tournamentId, new TenantDtos.PurgeConfirmation("pw", NAME), "admin");

        verify(jdbc).update("DELETE FROM tournaments WHERE id = ?", tournamentId);
    }
}
