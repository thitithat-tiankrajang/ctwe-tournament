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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TournamentCardUndoPairingTest {
    @Test
    @SuppressWarnings({"rawtypes", "unchecked"})
    void gameTwoUnpairDiscardsOnlyCurrentPreviewAndKeepsPublishedGameOne() throws Exception {
        UUID cardId = UUID.randomUUID();
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService service = spy(new TournamentCardService(
            jdbc,
            mock(PairingStrategyRegistry.class),
            new ObjectMapper()
        ));
        doReturn(null).when(service).get(cardId, true);

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
            when(result.getString("status")).thenReturn("RUNNING");
            when(result.getString("runtime_stage")).thenReturn(RuntimeStage.PAIRING_PREVIEW.name());
            when(result.getInt("current_game")).thenReturn(2);
            when(result.getTimestamp("created_at")).thenReturn(Timestamp.from(Instant.EPOCH));
            when(result.getLong("version")).thenReturn(10L);
            when(result.getString("final_type")).thenReturn("NONE");
            when(result.getInt("final_games")).thenReturn(0);
            when(result.getBoolean("gibson_enabled")).thenReturn(false);
            RowMapper mapper = invocation.getArgument(1);
            return mapper.mapRow(result, 0);
        });

        service.undoPairing(cardId, "director");

        verify(jdbc).update(
            argThat(sql -> sql.contains("DELETE FROM matches") && sql.contains("g.game_number > ?")),
            eq(cardId),
            eq(1)
        );
        verify(jdbc).update(
            argThat(sql -> sql.contains("UPDATE games SET status = 'PENDING'")),
            eq(cardId),
            eq(2)
        );
        assertThat(mockingDetails(jdbc).getInvocations())
            .noneMatch(invocation -> invocation.getMethod().getName().equals("update")
                && invocation.getArguments().length > 0
                && String.valueOf((Object) invocation.getArgument(0)).contains("UPDATE pairing_snapshots"));
        assertThat(mockingDetails(jdbc).getInvocations())
            .anyMatch(invocation -> invocation.getMethod().getName().equals("update")
                && invocation.getArguments().length > 0
                && String.valueOf((Object) invocation.getArgument(0)).contains("runtime_stage = 'TABLE_PAIRING'"));
    }
}
