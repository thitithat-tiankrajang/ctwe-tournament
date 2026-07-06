package com.ctwe.tournament.application;

import com.ctwe.tournament.infrastructure.cache.EvictPublicCard;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import org.junit.jupiter.api.Test;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Caching;
import org.springframework.core.annotation.AnnotatedElementUtils;

import java.lang.reflect.Method;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class TournamentCardCacheEvictionTest {
    private static final Set<String> PUBLIC_MUTATIONS = Set.of(
        "updatePlayer", "removePlayer", "finishRegistration", "swapPlayers",
        "confirmPairingPreview", "unpairCurrentPairing", "submitResult", "publishResults", "publishFinalRound",
        "undoPairing", "overrideResult", "applyPenalty", "revokePenalty", "close",
        "generateTestPlayers", "resetRuntime", "simulate"
    );
    private static final Set<String> PRIVATE_MUTATIONS = Set.of(
        "addPlayer", "addPlayersBulk", "generatePairingPreview",
        "reviewResults", "reopenResults", "startFinalRound", "submitFinalResult",
        "setFinalWinner", "autoResults"
    );

    @Test
    void publicVisibleMutationsEvictThePublicReadModel() {
        for (String methodName : PUBLIC_MUTATIONS) {
            Method method = findMethod(methodName);
            assertThat(AnnotatedElementUtils.hasAnnotation(method, EvictPublicCard.class))
                .as(methodName + " must evict public caches")
                .isTrue();
        }
    }

    @Test
    void unpublishedHotPathMutationsDoNotEvictPublicCaches() {
        for (String methodName : PRIVATE_MUTATIONS) {
            Method method = findMethod(methodName);
            assertThat(AnnotatedElementUtils.hasAnnotation(method, EvictPublicCard.class))
                .as(methodName + " must keep the public representation stable")
                .isFalse();
        }
    }

    @Test
    void createEvictsOnlyCatalogMembership() {
        Caching caching = findMethod("create").getAnnotation(Caching.class);
        assertThat(caching).isNotNull();
        assertThat(caching.evict()).anySatisfy(eviction ->
            assertThat(eviction.cacheNames()).containsExactly(TournamentCaches.PUBLIC_CARD_CATALOG));
        assertThat(caching.evict()).anySatisfy(eviction ->
            assertThat(eviction.cacheNames()).containsExactly(TournamentCaches.PUBLIC_CARD_VERSIONS));
    }

    @Test
    void deleteEvictsBothCardAndCatalog() {
        Caching caching = findMethod("delete").getAnnotation(Caching.class);
        assertThat(caching).isNotNull();
        assertThat(caching.evict()).anySatisfy(eviction -> {
            assertThat(eviction.cacheNames()).containsExactly(TournamentCaches.PUBLIC_CARD_DETAILS);
            assertThat(eviction.key()).isEqualTo("#cardId");
        });
        assertThat(caching.evict()).anySatisfy(eviction -> {
            assertThat(eviction.cacheNames()).containsExactly(TournamentCaches.PUBLIC_CARD_CATALOG);
            assertThat(eviction.allEntries()).isTrue();
        });
        assertThat(caching.evict()).anySatisfy(eviction -> {
            assertThat(eviction.cacheNames()).containsExactly(TournamentCaches.PUBLIC_CARD_VERSIONS);
            assertThat(eviction.allEntries()).isTrue();
        });
    }

    private static Method findMethod(String name) {
        return java.util.Arrays.stream(TournamentCardService.class.getDeclaredMethods())
            .filter(method -> method.getName().equals(name))
            .findFirst()
            .orElseThrow();
    }
}
