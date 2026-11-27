package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class TournamentCreationValidationTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final ObjectMapper json = new ObjectMapper();
    private final TournamentCardService cards = new TournamentCardService(jdbc, mock(PairingStrategyRegistry.class),
        json, new RankingSource(jdbc), new ScreeningPoolStore(jdbc));
    private final UUID tournamentId = UUID.randomUUID();

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {
        "ab",
        "abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijk",
        "bad--slug",
        "UPPERCASE"
    })
    void invalidSlugNeverReservesATournament(String slug) {
        var tenant = new TenantService(jdbc, mock(PasswordEncoder.class), json, event -> {});
        assertThatThrownBy(() -> tenant.createTournament("สนามทดสอบ", slug, "admin"))
            .isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(jdbc);
    }

    @Test
    void rejectsAnIncompletePairingGraphOrScoreLimitListBeforeWriting() {
        assertThatThrownBy(() -> cards.create(input(List.of(), List.of(250, 250), "NONE", 0, null), "director"))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("pairing rule");
        assertThatThrownBy(() -> cards.create(input(List.of(PairingRuleType.SWISS), List.of(250), "NONE", 0, null), "director"))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Maximum Difference");
        verifyNoInteractions(jdbc);
    }

    @Test
    void noCardCanBeCreatedForAnAbsentTournament() {
        when(jdbc.queryForObject("SELECT COUNT(*) FROM tournaments WHERE id = ?", Long.class, tournamentId)).thenReturn(0L);
        assertThatThrownBy(() -> cards.create(input(List.of(PairingRuleType.SWISS), List.of(250, 250), "NONE", 0, null), "director"))
            .isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    void rejectsFinalsWithoutGamesAndPairResultAsTheInitialRule() {
        when(jdbc.queryForObject("SELECT COUNT(*) FROM tournaments WHERE id = ?", Long.class, tournamentId)).thenReturn(1L);
        assertThatThrownBy(() -> cards.create(input(List.of(PairingRuleType.SWISS), List.of(250, 250), "CHAMPION", 0, null), "director"))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("รอบชิง");
        assertThatThrownBy(() -> cards.create(input(List.of(PairingRuleType.SWISS), List.of(250, 250), "NONE", 0, PairingRuleType.PAIR_RESULT), "director"))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("game 1");
    }

    private CardDtos.CreateCardRequest input(List<PairingRuleType> rules, List<Integer> maxDiffs, String finalType,
                                             int finalGames, PairingRuleType initial) {
        return new CardDtos.CreateCardRequest(tournamentId, "รุ่นทดสอบ", "ประถม", 2, rules, maxDiffs,
            finalType, finalGames, false, initial, null);
    }
}
