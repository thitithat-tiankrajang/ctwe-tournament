package com.ctwe.tournament.application;

import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.SettingsDtos;
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
    private final JdbcTemplate jdbc;

    public RuntimeSettingsService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
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
        return RuntimeSettings.fromRows(rows, latest[0]);
    }

    @CacheEvict(cacheNames = TournamentCaches.RUNTIME_SETTINGS, allEntries = true)
    @Transactional
    public RuntimeSettings update(SettingsDtos.RealtimeSettingsRequest request, String actor) {
        upsert("realtime.enabled", String.valueOf(request.realtimeEnabled()), actor);
        upsert("realtime.sse-enabled", String.valueOf(request.sseEnabled()), actor);
        upsert("realtime.polling-enabled", String.valueOf(request.pollingEnabled()), actor);
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
        return RuntimeSettings.fromRows(rows, latest[0]);
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
