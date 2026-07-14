package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.RuntimeStage;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TournamentCardReopenRegistrationTest {

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static void stubCardRow(JdbcTemplate jdbc, UUID cardId, String status, RuntimeStage stage, int currentGame) {
        when(jdbc.queryForObject(
            argThat(sql -> sql.contains("FROM tournament_cards WHERE id = ?")),
            any(RowMapper.class),
            eq(cardId)
        )).thenAnswer(invocation -> {
            ResultSet result = mock(ResultSet.class);
            when(result.getObject("id", UUID.class)).thenReturn(cardId);
            when(result.getString("name")).thenReturn("Card");
            when(result.getString("division")).thenReturn("Open");
            when(result.getInt("number_of_games")).thenReturn(4);
            when(result.getString("status")).thenReturn(status);
            when(result.getString("runtime_stage")).thenReturn(stage.name());
            when(result.getInt("current_game")).thenReturn(currentGame);
            when(result.getTimestamp("created_at")).thenReturn(Timestamp.from(Instant.EPOCH));
            when(result.getLong("version")).thenReturn(10L);
            when(result.getString("final_type")).thenReturn("NONE");
            when(result.getInt("final_games")).thenReturn(0);
            when(result.getBoolean("gibson_enabled")).thenReturn(false);
            RowMapper mapper = invocation.getArgument(1);
            return mapper.mapRow(result, 0);
        });
    }

    private static TournamentCardService serviceOver(JdbcTemplate jdbc, UUID cardId) {
        TournamentCardService service = spy(new TournamentCardService(
            jdbc,
            mock(PairingStrategyRegistry.class),
            new ObjectMapper()
        ));
        doReturn(null).when(service).get(cardId, true);
        return service;
    }

    @Test
    void reopenFromPublishedGameOnePairingDiscardsEverythingBackToRegistration() {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = serviceOver(jdbc, cardId);
        stubCardRow(jdbc, cardId, "RUNNING", RuntimeStage.RESULT_COLLECTION, 1);
        when(jdbc.queryForObject(any(String.class), eq(Long.class), any(Object[].class))).thenReturn(0L);

        service.reopenRegistration(cardId, true, "director");

        verify(jdbc).update(eq("DELETE FROM matches WHERE card_id = ?"), eq(cardId));
        verify(jdbc).update(eq("DELETE FROM table_seats WHERE card_id = ?"), eq(cardId));
        verify(jdbc).update(eq("UPDATE games SET status = 'PENDING' WHERE card_id = ?"), eq(cardId));
        verify(jdbc).update(argThat(sql -> sql.contains("terminated_at = NULL") && sql.contains("carry_losses = 0")), eq(cardId));
        assertThat(mockingDetails(jdbc).getInvocations())
            .anyMatch(invocation -> invocation.getMethod().getName().equals("update")
                && invocation.getArguments().length > 0
                && String.valueOf((Object) invocation.getArgument(0)).contains("status = 'DRAFT', runtime_stage = 'PLAYER_REGISTRATION'"));
    }

    @Test
    void reopenFromTablePairingNeedsNoDiscardConfirmation() {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = serviceOver(jdbc, cardId);
        stubCardRow(jdbc, cardId, "READY", RuntimeStage.TABLE_PAIRING, 1);
        when(jdbc.queryForObject(any(String.class), eq(Long.class), any(Object[].class))).thenReturn(0L);

        service.reopenRegistration(cardId, false, "director");

        assertThat(mockingDetails(jdbc).getInvocations())
            .anyMatch(invocation -> invocation.getMethod().getName().equals("update")
                && invocation.getArguments().length > 0
                && String.valueOf((Object) invocation.getArgument(0)).contains("runtime_stage = 'PLAYER_REGISTRATION'"));
    }

    @Test
    void reopenWithExistingPairingRequiresConfirmationEvenIfCallerSkippedIt() {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = serviceOver(jdbc, cardId);
        stubCardRow(jdbc, cardId, "RUNNING", RuntimeStage.PAIRING_PREVIEW, 1);
        when(jdbc.queryForObject(any(String.class), eq(Long.class), any(Object[].class))).thenReturn(0L);

        assertThatThrownBy(() -> service.reopenRegistration(cardId, false, "director"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("รหัสผ่าน");
        verify(jdbc, never()).update(eq("DELETE FROM matches WHERE card_id = ?"), eq(cardId));
    }

    @Test
    void reopenBlockedOnceAnyGameOneResultIsSaved() {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = serviceOver(jdbc, cardId);
        stubCardRow(jdbc, cardId, "RUNNING", RuntimeStage.RESULT_COLLECTION, 1);
        when(jdbc.queryForObject(any(String.class), eq(Long.class), any(Object[].class)))
            .thenAnswer(invocation -> String.valueOf((Object) invocation.getArgument(0)).contains("result_type IS NOT NULL") ? 1L : 0L);

        assertThatThrownBy(() -> service.reopenRegistration(cardId, true, "director"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("มีการบันทึกผล");
        verify(jdbc, never()).update(eq("DELETE FROM matches WHERE card_id = ?"), eq(cardId));
    }

    @Test
    void reopenBlockedFromGameTwoOnward() {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = serviceOver(jdbc, cardId);
        stubCardRow(jdbc, cardId, "RUNNING", RuntimeStage.TABLE_PAIRING, 2);

        assertThatThrownBy(() -> service.reopenRegistration(cardId, true, "director"))
            .isInstanceOf(IllegalArgumentException.class);
        verify(jdbc, never()).update(eq("DELETE FROM matches WHERE card_id = ?"), eq(cardId));
    }

    @Test
    void reopenBlockedDuringRegistrationItself() {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = serviceOver(jdbc, cardId);
        stubCardRow(jdbc, cardId, "DRAFT", RuntimeStage.PLAYER_REGISTRATION, 1);

        assertThatThrownBy(() -> service.reopenRegistration(cardId, false, "director"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("ลงทะเบียนอยู่แล้ว");
    }
}
