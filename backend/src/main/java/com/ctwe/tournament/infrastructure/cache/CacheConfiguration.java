package com.ctwe.tournament.infrastructure.cache;

import com.github.benmanes.caffeine.cache.Caffeine;
import org.springframework.beans.factory.annotation.Value;
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
    @Bean
    CacheManager cacheManager(
        @Value("${app.cache.public-card-details.ttl-seconds}") long publicCardTtlSeconds,
        @Value("${app.cache.public-card-details.maximum-size}") long publicCardMaximumSize,
        @Value("${app.cache.public-card-catalog.ttl-seconds}") long publicCardCatalogTtlSeconds,
        @Value("${app.cache.public-card-versions.ttl-seconds}") long publicCardVersionsTtlSeconds
    ) {
        if (publicCardTtlSeconds <= 0 || publicCardCatalogTtlSeconds <= 0
            || publicCardVersionsTtlSeconds <= 0 || publicCardMaximumSize <= 0)
            throw new IllegalArgumentException("Cache TTL and maximum size must be positive");

        CaffeineCacheManager caffeine = new CaffeineCacheManager();
        caffeine.setAllowNullValues(false);
        caffeine.registerCustomCache(TournamentCaches.PUBLIC_CARD_DETAILS, Caffeine.newBuilder()
            .maximumSize(publicCardMaximumSize)
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
        return new TransactionAwareCacheManagerProxy(caffeine);
    }
}
