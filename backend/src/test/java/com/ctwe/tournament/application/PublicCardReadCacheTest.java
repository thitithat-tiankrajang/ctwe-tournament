package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.cache.CacheConfiguration;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.CacheManager;
import org.springframework.cache.transaction.TransactionAwareCacheManagerProxy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doReturn;

@ExtendWith(SpringExtension.class)
@ContextConfiguration(classes = {CacheConfiguration.class, PublicCardReadCacheTest.TestConfiguration.class})
@TestPropertySource(properties = {
    "app.cache.public-card-details.ttl-seconds=60",
    "app.cache.public-card-details.maximum-size=8",
    "app.cache.public-card-catalog.ttl-seconds=300",
    "app.cache.public-card-versions.ttl-seconds=3"
})
class PublicCardReadCacheTest {
    @Autowired private PublicCardReadCache cache;
    @Autowired private TournamentCardService cards;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private CacheManager cacheManager;

    @BeforeEach
    void resetState() {
        reset(cards, jdbc);
        cacheManager.getCacheNames().forEach(name -> cacheManager.getCache(name).clear());
    }

    @Test
    void cachesPublicCardByCardIdAndAlwaysUsesPublicView() {
        UUID cardId = UUID.randomUUID();
        CardDtos.CardResponse response = card(cardId);
        when(cards.get(cardId, false)).thenReturn(response);
        when(jdbc.queryForList("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, cardId))
            .thenReturn(List.of(7L));

        assertThat(cache.card(cardId).version()).isEqualTo(7);
        assertThat(cache.card(cardId)).isSameAs(cache.card(cardId));

        verify(cards).get(cardId, false);
    }

    @Test
    void isolatesDifferentCardKeys() {
        UUID firstId = UUID.randomUUID();
        UUID secondId = UUID.randomUUID();
        when(cards.get(firstId, false)).thenReturn(card(firstId));
        when(cards.get(secondId, false)).thenReturn(card(secondId));
        when(jdbc.queryForList("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, firstId))
            .thenReturn(List.of(1L));
        when(jdbc.queryForList("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, secondId))
            .thenReturn(List.of(2L));

        cache.card(firstId);
        cache.card(secondId);
        cache.card(firstId);

        verify(cards).get(firstId, false);
        verify(cards).get(secondId, false);
    }

    @Test
    void removesBackOfficeOnlyFieldsAndShowsCollectingFinalRound() {
        UUID cardId = UUID.randomUUID();
        var finalRound = new CardDtos.FinalRoundResponse(List.of(
            new CardDtos.FinalSlotResponse(0, "P0001", "P0002", List.of(), null, null, null, null)));
        CardDtos.CardResponse source = new CardDtos.CardResponse(
            cardId, UUID.randomUUID(), "Final", "Open", CardStatus.RUNNING,
            RuntimeStage.FINAL_COLLECTION, 8, 42,
            List.of(), com.ctwe.tournament.domain.model.PairingRuleType.RANDOM,
            List.of(new CardDtos.RuleResponse(1, 2,
                com.ctwe.tournament.domain.model.PairingRuleType.SWISS)),
            List.of(), List.of(), List.of(), List.of(), "CHAMPION", 3,
            finalRound, false, Instant.EPOCH, "A");
        when(cards.get(cardId, false)).thenReturn(source);
        when(jdbc.queryForList("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, cardId))
            .thenReturn(List.of(9L));

        CardDtos.CardResponse result = cache.card(cardId);

        assertThat(result.version()).isEqualTo(9);
        assertThat(result.rules()).isEmpty();
        assertThat(result.tables()).isEmpty();
        assertThat(result.audit()).isEmpty();
        assertThat(result.finalRound()).isEqualTo(finalRound);
        assertThat(result.runtimeStage()).isEqualTo(RuntimeStage.FINAL_COLLECTION);
    }

    @Test
    void cachesTheOrderedPublicCatalog() {
        var summary = new com.ctwe.tournament.web.dto.PublicCardDtos.CardSummary(
            UUID.randomUUID(), UUID.randomUUID(), "Card", "Division", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 2, 8, 400, 1, 3, Instant.EPOCH);
        doReturn(List.of(summary)).when(jdbc).query(anyString(), any(RowMapper.class));

        assertThat(cache.summaries()).containsExactly(summary);
        assertThat(cache.summaries()).containsExactly(summary);

        verify(jdbc, times(1)).query(anyString(), any(RowMapper.class));
    }

    @Test
    void usesOnlyDeclaredCaffeineCachesWithStatisticsEnabled() {
        assertThat(cacheManager).isInstanceOf(TransactionAwareCacheManagerProxy.class);
        assertThat(cacheManager.getCacheNames())
            .containsExactlyInAnyOrder(
                TournamentCaches.PUBLIC_CARD_DETAILS,
                TournamentCaches.PUBLIC_CARD_CATALOG,
                TournamentCaches.PUBLIC_CARD_VERSIONS,
                TournamentCaches.RUNTIME_SETTINGS);

        Object nativeCache = cacheManager.getCache(TournamentCaches.PUBLIC_CARD_DETAILS).getNativeCache();
        assertThat(nativeCache).isInstanceOf(com.github.benmanes.caffeine.cache.Cache.class);
        @SuppressWarnings("unchecked")
        com.github.benmanes.caffeine.cache.Cache<Object, Object> caffeine =
            (com.github.benmanes.caffeine.cache.Cache<Object, Object>) nativeCache;
        long missesBefore = caffeine.stats().missCount();
        caffeine.getIfPresent(UUID.randomUUID());
        assertThat(caffeine.stats().missCount()).isEqualTo(missesBefore + 1);
        assertThat(caffeine.policy().eviction().orElseThrow().getMaximum()).isEqualTo(8);
    }

    @Test
    void appliesEvictionAfterCommitAndDiscardsItOnRollback() {
        org.springframework.cache.Cache details =
            cacheManager.getCache(TournamentCaches.PUBLIC_CARD_DETAILS);
        UUID cardId = UUID.randomUUID();
        details.put(cardId, card(cardId));
        TransactionTemplate transactions = new TransactionTemplate(new TestTransactionManager());

        transactions.executeWithoutResult(status -> {
            details.evict(cardId);
            assertThat(details.get(cardId)).isNotNull();
        });
        assertThat(details.get(cardId)).isNull();

        details.put(cardId, card(cardId));
        assertThatThrownBy(() -> transactions.executeWithoutResult(status -> {
            details.evict(cardId);
            throw new IllegalStateException("rollback");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(details.get(cardId)).isNotNull();
    }

    private static CardDtos.CardResponse card(UUID id) {
        return new CardDtos.CardResponse(
            id, UUID.randomUUID(), "Card", "Division", CardStatus.DRAFT,
            RuntimeStage.PLAYER_REGISTRATION, 1, 0,
            List.of(), com.ctwe.tournament.domain.model.PairingRuleType.RANDOM,
            List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH, "A");
    }

    @Configuration(proxyBeanMethods = false)
    static class TestConfiguration {
        @Bean JdbcTemplate jdbcTemplate() { return mock(JdbcTemplate.class); }
        @Bean TournamentCardService tournamentCardService() { return mock(TournamentCardService.class); }
        @Bean PublicCardReadCache publicCardReadCache(JdbcTemplate jdbc, TournamentCardService cards) {
            return new PublicCardReadCache(jdbc, cards);
        }
    }

    static class TestTransactionManager extends AbstractPlatformTransactionManager {
        @Override protected Object doGetTransaction() { return new Object(); }
        @Override protected void doBegin(Object transaction, TransactionDefinition definition) {}
        @Override protected void doCommit(DefaultTransactionStatus status) {}
        @Override protected void doRollback(DefaultTransactionStatus status) {}
    }
}
