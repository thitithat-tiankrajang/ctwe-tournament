package com.ctwe.tournament.application;

import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.SettingsDtos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Database-backed realtime configuration. {@link #current()} is served from a short-TTL Caffeine
 * cache, so the hot paths (every SSE subscribe, heartbeat tick, config endpoint) cost a map lookup,
 * and the database sees at most one settings query per TTL window. Updates evict the cache, so an
 * admin change takes effect on this instance within milliseconds — no redeploy, no restart.
 */
@Service
public class RuntimeSettingsService {
    private static final Logger log = LoggerFactory.getLogger(RuntimeSettingsService.class);

    private final JdbcTemplate jdbc;
    private final boolean loadTestMode;
    private final int loadTestMaxSseConnections;

    public RuntimeSettingsService(
        JdbcTemplate jdbc,
        @Value("${app.load-test.enabled:false}") boolean loadTestMode,
        @Value("${app.load-test.max-sse-connections:10000}") int loadTestMaxSseConnections
    ) {
        this.jdbc = jdbc;
        this.loadTestMode = loadTestMode;
        this.loadTestMaxSseConnections = loadTestMaxSseConnections;
        if (loadTestMode) {
            if (loadTestMaxSseConnections < 1)
                throw new IllegalArgumentException("MAX_SSE_CONNECTIONS must be at least 1 in load-test mode");
            log.warn("LOAD_TEST_MODE is ENABLED: public SSE cap overridden to {} (ceiling bypassed). "
                + "This must never be set on a production deployment serving a real event.",
                loadTestMaxSseConnections);
        }
    }

    @Cacheable(cacheNames = TournamentCaches.RUNTIME_SETTINGS, key = "'all'", sync = true)
    @Transactional(readOnly = true)
    public RuntimeSettings current() {
        Map<String, String> rows = new LinkedHashMap<>();
        Instant[] latest = { null };
        jdbc.query("SELECT key, value, updated_at FROM runtime_settings", rs -> {
            rows.put(rs.getString("key"), rs.getString("value"));
            Timestamp updated = rs.getTimestamp("updated_at");
            if (updated != null && (latest[0] == null || updated.toInstant().isAfter(latest[0])))
                latest[0] = updated.toInstant();
        });
        return withLoadTestOverride(RuntimeSettings.fromRows(rows, latest[0]));
    }

    /**
     * Load-test escape hatch: with {@code LOAD_TEST_MODE=true} the public SSE cap (and its
     * hard ceiling) is replaced by {@code MAX_SSE_CONNECTIONS} so capacity tests can push the
     * connector to its real limit. Everything else — switches, staff cap, heartbeats, reconnect
     * delay — behaves exactly as in production, and with the flag off (the default) this method
     * is an identity function.
     */
    private RuntimeSettings withLoadTestOverride(RuntimeSettings settings) {
        if (!loadTestMode) return settings;
        return new RuntimeSettings(
            settings.realtimeEnabled(), settings.sseEnabled(), settings.pollingEnabled(),
            loadTestMaxSseConnections, settings.maxStaffSseConnections(),
            settings.pollingIntervalMs(), settings.heartbeatIntervalMs(), settings.reconnectDelayMs(),
            settings.updatedAt());
    }

    @CacheEvict(cacheNames = TournamentCaches.RUNTIME_SETTINGS, allEntries = true)
    @Transactional
    public RuntimeSettings update(SettingsDtos.RealtimeSettingsRequest request, String actor) {
        upsert("realtime.enabled", String.valueOf(request.realtimeEnabled()), actor);
        upsert("realtime.sse-enabled", String.valueOf(request.sseEnabled()), actor);
        // SSE-only architecture: retain the legacy setting for compatibility, but never enable it.
        upsert("realtime.polling-enabled", "false", actor);
        upsert("realtime.max-public-sse-connections", String.valueOf(request.maxPublicSseConnections()), actor);
        upsert("realtime.max-staff-sse-connections", String.valueOf(request.maxStaffSseConnections()), actor);
        upsert("realtime.polling-interval-ms", String.valueOf(request.pollingIntervalMs()), actor);
        upsert("realtime.heartbeat-interval-ms", String.valueOf(request.heartbeatIntervalMs()), actor);
        upsert("realtime.reconnect-delay-ms", String.valueOf(request.reconnectDelayMs()), actor);
        jdbc.update("""
            INSERT INTO audit_logs (card_id, actor, action, old_value, new_value)
            VALUES (NULL, ?, 'UPDATE_REALTIME_SETTINGS', NULL, ?)
            """, actor, summary(request));
        return readUncached();
    }

    /** Post-update read that bypasses the (just evicted) cache so the caller sees the saved state. */
    private RuntimeSettings readUncached() {
        Map<String, String> rows = new LinkedHashMap<>();
        Instant[] latest = { null };
        jdbc.query("SELECT key, value, updated_at FROM runtime_settings", rs -> {
            rows.put(rs.getString("key"), rs.getString("value"));
            Timestamp updated = rs.getTimestamp("updated_at");
            if (updated != null && (latest[0] == null || updated.toInstant().isAfter(latest[0])))
                latest[0] = updated.toInstant();
        });
        return withLoadTestOverride(RuntimeSettings.fromRows(rows, latest[0]));
    }

    private void upsert(String key, String value, String actor) {
        jdbc.update("""
            INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, now(), ?)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
            WHERE runtime_settings.value IS DISTINCT FROM EXCLUDED.value
            """, key, value, actor);
    }

    private String summary(SettingsDtos.RealtimeSettingsRequest request) {
        return "realtime=" + request.realtimeEnabled() + " sse=" + request.sseEnabled()
            + " polling=" + request.pollingEnabled()
            + " maxPublicSse=" + request.maxPublicSseConnections()
            + " maxStaffSse=" + request.maxStaffSseConnections()
            + " pollMs=" + request.pollingIntervalMs()
            + " heartbeatMs=" + request.heartbeatIntervalMs()
            + " reconnectMs=" + request.reconnectDelayMs();
    }
}
