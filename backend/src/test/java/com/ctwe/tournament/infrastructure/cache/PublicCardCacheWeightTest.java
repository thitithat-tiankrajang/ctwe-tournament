package com.ctwe.tournament.infrastructure.cache;

import com.ctwe.tournament.application.PublicCardWeigher;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import com.github.benmanes.caffeine.cache.Cache;
import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.cache.CacheManager;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.mock.env.MockEnvironment;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The public detail cache is bounded by the SUM OF ESTIMATED WEIGHTS (estimate-bytes). These tests pin
 * the budget, its configuration, and the estimates; they do not, and cannot, prove an actual heap bound.
 */
class PublicCardCacheWeightTest {
    static final long BUDGET = 20_512_768L;

    /** A public-projection card (no rules/tables/audit) with the given roster and fully paired games. */
    static CardDtos.CardResponse card(int players, int pairedGames) {
        List<CardDtos.PlayerResponse> roster = IntStream.rangeClosed(1, players).mapToObj(i -> new CardDtos.PlayerResponse(
            "P" + i, "ชื่อผู้เล่น" + i, "นามสกุลทดสอบ", "โรงเรียนทดสอบ", "Open", 0, 0, 0, 0, 0, false)).toList();
        List<CardDtos.SnapshotResponse> snapshots = new ArrayList<>();
        for (int g = 1; g <= pairedGames; g++) {
            int game = g;
            snapshots.add(new CardDtos.SnapshotResponse("s" + g, List.of(g), IntStream.range(0, players / 2).mapToObj(t ->
                new CardDtos.PairingResponse("g" + game + "t" + t, game, t + 1, "P" + (2 * t + 1), "P" + (2 * t + 2),
                    "P" + (2 * t + 1), 400, 300, "WIN", 100, false, false, true, false, false)).toList(), "2026-11-21T00:00:00Z"));
        }
        List<CardDtos.GameResponse> games = IntStream.rangeClosed(1, 5).mapToObj(n -> new CardDtos.GameResponse(String.valueOf(n), n, "เกม " + n, "PENDING", 350)).toList();
        return new CardDtos.CardResponse(UUID.randomUUID(), UUID.randomUUID(), "Card", "Open", CardStatus.RUNNING, RuntimeStage.RESULT_COLLECTION,
            pairedGames, 1, games, PairingRuleType.RANDOM, List.of(), roster, List.of(), snapshots, List.of(), "NONE", 0, null, false,
            Instant.EPOCH, "P", "PAIR", List.of());
    }

    private static Cache<Object, Object> details() {
        CacheManager manager = new CacheConfiguration().cacheManager(300, BUDGET, 300, 3, 60);
        @SuppressWarnings("unchecked")
        Cache<Object, Object> cache = (Cache<Object, Object>) manager.getCache(TournamentCaches.PUBLIC_CARD_DETAILS).getNativeCache();
        return cache;
    }

    @Test
    void applicationYamlDefaultsToTheExplicitByteBudgetAndNoLongerDefinesTheEntryCount() throws Exception {
        List<PropertySource<?>> sources = new YamlPropertySourceLoader().load("application", new ClassPathResource("application.yml"));
        PropertySource<?> yaml = sources.get(0);
        assertThat(String.valueOf(yaml.getProperty("app.cache.public-card-details.maximum-weight-bytes")))
            .isEqualTo("${PUBLIC_CARD_CACHE_MAX_WEIGHT_BYTES:20512768}");
        assertThat(yaml.getProperty(CacheConfiguration.LEGACY_PROPERTY)).isNull();
        // The default is the previous setting's 8-entry worst case at the 1,000-row reference card.
        assertThat(8 * PublicCardWeigher.REFERENCE_CARD_BYTES).isEqualTo(BUDGET);
    }

    @Test
    void retiredEntryCountSettingIsDetectedNotReinterpreted() {
        assertThat(CacheConfiguration.legacySetting(new MockEnvironment())).isNull();
        assertThat(CacheConfiguration.legacySetting(new MockEnvironment().withProperty("PUBLIC_CARD_CACHE_MAX_SIZE", "8")))
            .isEqualTo("PUBLIC_CARD_CACHE_MAX_SIZE");
        assertThat(CacheConfiguration.legacySetting(new MockEnvironment().withProperty(CacheConfiguration.LEGACY_PROPERTY, "8")))
            .isEqualTo(CacheConfiguration.LEGACY_PROPERTY);
        // Its value never reaches the budget: the cache manager takes only the explicit byte budget.
        assertThat(((Cache<?, ?>) new CacheConfiguration().cacheManager(300, BUDGET, 300, 3, 60)
            .getCache(TournamentCaches.PUBLIC_CARD_DETAILS).getNativeCache()).policy().eviction().orElseThrow().getMaximum()).isEqualTo(BUDGET);
    }

    @Test
    void estimatesMatchTheFormulaAndExceededTheTwoMeasuredFixtures() {
        int small = PublicCardWeigher.weigh(null, card(6, 1));     // 6 players + 5 games + 3 pairings = 14 rows
        int large = PublicCardWeigher.weigh(null, card(300, 3));   // 300 + 5 + 450 = 755 rows
        assertThat(small).isEqualTo(39_936);
        assertThat(large).isEqualTo(1_936_896);
        // Measured retained heap of those fixtures (heap after GC, 2026-11-21): ~18 KB and ~1.4 MB.
        // Two fixtures only: this documents the calibration, it is not a general upper bound.
        assertThat(small).isGreaterThan(18 * 1024);
        assertThat(large).isGreaterThan(1_400_000);
    }

    @Test
    void retainedCardCountFollowsActualWeightsWithinTheBudget() {
        // budget / weight: 6-player game-1 cards -> 513; 300-player 3-game -> 10; 300-player 5-game -> 7.
        assertThat(BUDGET / PublicCardWeigher.weigh(null, card(6, 1))).isEqualTo(513);
        assertThat(BUDGET / PublicCardWeigher.weigh(null, card(300, 3))).isEqualTo(10);
        assertThat(BUDGET / PublicCardWeigher.weigh(null, card(300, 5))).isEqualTo(7);

        Cache<Object, Object> cache = details();
        List<UUID> keys = new ArrayList<>();
        for (int i = 0; i < 40; i++) { UUID key = UUID.randomUUID(); keys.add(key); cache.put(key, card(6, 1)); }
        cache.cleanUp();
        assertThat(keys).as("40 small cards (~1.6 MB estimated) all fit").allSatisfy(key -> assertThat(cache.getIfPresent(key)).isNotNull());
    }

    @Test
    void largeCardsStayWithinTheEstimatedWeightBudget() {
        Cache<Object, Object> cache = details();
        for (int i = 0; i < 20; i++) cache.put(UUID.randomUUID(), card(300, 5));   // 2,704,896 estimate-bytes each
        cache.cleanUp();
        long retainedEstimate = cache.asMap().values().stream().mapToLong(v -> PublicCardWeigher.weigh(null, v)).sum();
        assertThat(retainedEstimate).isLessThanOrEqualTo(BUDGET);
        assertThat(cache.estimatedSize()).isLessThanOrEqualTo(7);
    }
}
