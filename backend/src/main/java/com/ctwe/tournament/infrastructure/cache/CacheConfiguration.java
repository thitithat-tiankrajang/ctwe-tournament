package com.ctwe.tournament.infrastructure.cache;

import com.ctwe.tournament.application.PublicCardWeigher;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.cache.caffeine.CaffeineCacheManager;
import org.springframework.cache.transaction.TransactionAwareCacheManagerProxy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration(proxyBeanMethods = false)
@EnableCaching
public class CacheConfiguration {
    private static final Logger log = LoggerFactory.getLogger(CacheConfiguration.class);

    /** Retired entry-count setting. It is no longer read and is never converted into a byte budget. */
    static final String LEGACY_ENV = "PUBLIC_CARD_CACHE_MAX_SIZE";
    static final String LEGACY_PROPERTY = "app.cache.public-card-details.maximum-size";

    @Bean
    CacheManager cacheManager(
        @Value("${app.cache.public-card-details.ttl-seconds}") long publicCardTtlSeconds,
        @Value("${app.cache.public-card-details.maximum-weight-bytes}") long publicCardMaximumWeightBytes,
        @Value("${app.cache.public-card-catalog.ttl-seconds}") long publicCardCatalogTtlSeconds,
        @Value("${app.cache.public-card-versions.ttl-seconds}") long publicCardVersionsTtlSeconds,
        @Value("${app.cache.runtime-settings.ttl-seconds:5}") long runtimeSettingsTtlSeconds
    ) {
        if (publicCardTtlSeconds <= 0 || publicCardCatalogTtlSeconds <= 0
            || publicCardVersionsTtlSeconds <= 0 || publicCardMaximumWeightBytes <= 0
            || runtimeSettingsTtlSeconds <= 0)
            throw new IllegalArgumentException("Cache TTLs and the public card weight budget must be positive");

        CaffeineCacheManager caffeine = new CaffeineCacheManager();
        caffeine.setAllowNullValues(false);
        // Bounded by the SUM OF ESTIMATED WEIGHTS (PublicCardWeigher), in estimate-bytes. This is not a
        // bound on actual retained heap or on total JVM memory; see PublicCardWeigher for how the
        // estimate compares with the two measured fixtures.
        caffeine.registerCustomCache(TournamentCaches.PUBLIC_CARD_DETAILS, Caffeine.newBuilder()
            .maximumWeight(publicCardMaximumWeightBytes)
            .weigher(PublicCardWeigher::weigh)
            .expireAfterWrite(Duration.ofSeconds(publicCardTtlSeconds))
            .recordStats()
            .build());
        caffeine.registerCustomCache(TournamentCaches.PUBLIC_CARD_CATALOG, Caffeine.newBuilder()
            .maximumSize(1)
            .expireAfterWrite(Duration.ofSeconds(publicCardCatalogTtlSeconds))
            .recordStats()
            .build());
        caffeine.registerCustomCache(TournamentCaches.PUBLIC_CARD_VERSIONS, Caffeine.newBuilder()
            .maximumSize(1)
            .expireAfterWrite(Duration.ofSeconds(publicCardVersionsTtlSeconds))
            .recordStats()
            .build());
        // The evict on update() is what makes an admin change apply, not this TTL: it fires on the
        // same instance within milliseconds, and update() is the only code path that writes the
        // table (the two migrations run before the cache exists). The TTL is therefore a backstop
        // for an out-of-band write nothing performs, which is why it is 60s rather than 5s -- at 5s
        // it sat exactly on the heartbeat tick and re-read the database for the entire lifetime of
        // an idle deployment. SSE subscribes/heartbeats/config reads stay a map lookup either way.
        caffeine.registerCustomCache(TournamentCaches.RUNTIME_SETTINGS, Caffeine.newBuilder()
            .maximumSize(1)
            .expireAfterWrite(Duration.ofSeconds(runtimeSettingsTtlSeconds))
            .recordStats()
            .build());
        return new TransactionAwareCacheManagerProxy(caffeine);
    }

    /**
     * Transition guard for the retired entry-count setting: if a deployment still sets it, say so at
     * startup instead of silently ignoring it. It is never reinterpreted as a memory budget.
     */
    @Bean
    InitializingBean retiredPublicCardCacheSizeWarning(Environment environment) {
        return () -> {
            String found = legacySetting(environment);
            if (found != null)
                log.warn("{} is set but IGNORED: the public card cache is no longer bounded by entry count. "
                    + "Its budget is PUBLIC_CARD_CACHE_MAX_WEIGHT_BYTES (estimated bytes). Remove the old setting.", found);
        };
    }

    static String legacySetting(Environment environment) {
        if (environment.containsProperty(LEGACY_ENV)) return LEGACY_ENV;
        if (environment.containsProperty(LEGACY_PROPERTY)) return LEGACY_PROPERTY;
        return null;
    }
}
