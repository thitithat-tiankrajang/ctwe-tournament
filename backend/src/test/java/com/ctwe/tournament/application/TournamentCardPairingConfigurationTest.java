package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.pairing.PairingStrategy;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class TournamentCardPairingConfigurationTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService service = new TournamentCardService(
        jdbc, mock(PairingStrategyRegistry.class), new ObjectMapper());

    @Test
    void gameOneReadsTheConfiguredInitialRuleInsteadOfFallingBackToRandom() {
        UUID cardId = UUID.randomUUID();
        when(jdbc.queryForObject(
            "SELECT initial_pairing_rule FROM tournament_cards WHERE id = ?", String.class, cardId
        )).thenReturn("KING_OF_THE_HILL");

        assertThat(service.ruleForGame(cardId, 1)).isEqualTo(PairingRuleType.KING_OF_THE_HILL);
    }

    @Test
    void laterGamesReadTheRuleForTheirIncomingEdge() {
        UUID cardId = UUID.randomUUID();
        when(jdbc.queryForObject(
            "SELECT rule_type FROM pairing_rules WHERE card_id = ? AND from_game = ?",
            String.class, cardId, 2
        )).thenReturn("SWISS");

        assertThat(service.ruleForGame(cardId, 3)).isEqualTo(PairingRuleType.SWISS);
    }

    @Test
    void rankedRulesKeepStrategyOrderInsteadOfLookingRandomOnTheTable() {
        UUID cardId = UUID.randomUUID();
        List<PairingStrategy.Pair> pairs = List.of(
            new PairingStrategy.Pair("1", "2"),
            new PairingStrategy.Pair("3", "4")
        );

        assertThat(service.orderPairsForRule(cardId, PairingRuleType.KING_OF_THE_HILL, pairs, null))
            .containsExactlyElementsOf(pairs);
        assertThat(service.orderPairsForRule(cardId, PairingRuleType.SWISS, pairs, null))
            .containsExactlyElementsOf(pairs);
        verifyNoInteractions(jdbc);
    }
}
