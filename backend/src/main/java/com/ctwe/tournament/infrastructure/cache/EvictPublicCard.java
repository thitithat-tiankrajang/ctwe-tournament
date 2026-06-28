package com.ctwe.tournament.infrastructure.cache;

import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Caching;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Caching(evict = {
    @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_DETAILS, key = "#cardId"),
    @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_CATALOG, allEntries = true),
    @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_VERSIONS, allEntries = true)
})
public @interface EvictPublicCard {}
