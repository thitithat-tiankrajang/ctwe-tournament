package com.ctwe.tournament.infrastructure.storage;

import com.ctwe.tournament.infrastructure.cdn.CachePurgeClient;
import com.ctwe.tournament.infrastructure.cdn.CloudflareCachePurgeClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires Public Snapshot storage, or cleanly wires its absence.
 *
 * <p>The three-state policy is defined and enforced by {@link SnapshotStorageProperties#validate()}:
 * ABSENT disables publication, COMPLETE enables it, and anything in between fails startup. This
 * class only turns that verdict into beans.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SnapshotStorageProperties.class)
public class SnapshotStorageConfiguration {
    private static final Logger log = LoggerFactory.getLogger(SnapshotStorageConfiguration.class);

    @Bean
    SnapshotObjectStore snapshotObjectStore(SnapshotStorageProperties properties) {
        if (properties.validate() == SnapshotStorageProperties.Mode.ABSENT) {
            log.info("Public Snapshot storage is not configured — publication is unavailable, "
                + "every other feature is unaffected");
            return new UnconfiguredSnapshotStorage.Store();
        }
        return R2SnapshotObjectStore.from(properties);
    }

    @Bean
    PublicSnapshotFetcher publicSnapshotFetcher(SnapshotStorageProperties properties) {
        if (properties.validate() == SnapshotStorageProperties.Mode.ABSENT)
            return new UnconfiguredSnapshotStorage.Fetcher();
        return new HttpPublicSnapshotFetcher(properties);
    }

    @Bean
    CachePurgeClient cachePurgeClient(SnapshotStorageProperties properties) {
        if (properties.validate() == SnapshotStorageProperties.Mode.COMPLETE && !properties.purgeConfigured())
            log.info("Cloudflare cache purge is not configured — staleness is bounded by max-age only");
        return new CloudflareCachePurgeClient(properties);
    }
}
