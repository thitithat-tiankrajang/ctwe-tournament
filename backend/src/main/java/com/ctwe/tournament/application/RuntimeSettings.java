package com.ctwe.tournament.application;

import java.time.Instant;
import java.util.Map;

/**
 * Immutable snapshot of the admin-tunable realtime configuration. Values are read from
 * {@code runtime_settings} and clamped into safe operating ranges, so a bad row can never
 * disable heartbeats entirely or lift the SSE caps above what the Tomcat connector survives.
 */
public record RuntimeSettings(
    boolean realtimeEnabled,
    boolean sseEnabled,
    boolean pollingEnabled,
    int maxPublicSseConnections,
    int maxStaffSseConnections,
    int pollingIntervalMs,
    int heartbeatIntervalMs,
    int reconnectDelayMs,
    Instant updatedAt
) {
    public static final int MAX_PUBLIC_SSE_CEILING = 1500;
    public static final int MAX_STAFF_SSE_CEILING = 1000;
    public static final int MIN_POLLING_INTERVAL_MS = 5_000;
    public static final int MAX_POLLING_INTERVAL_MS = 600_000;
    public static final int MIN_HEARTBEAT_INTERVAL_MS = 5_000;
    public static final int MAX_HEARTBEAT_INTERVAL_MS = 120_000;
    public static final int MIN_RECONNECT_DELAY_MS = 500;
    public static final int MAX_RECONNECT_DELAY_MS = 30_000;

    public static RuntimeSettings defaults() {
        return new RuntimeSettings(true, true, true, 600, 300, 60_000, 25_000, 2_000, null);
    }

    public static RuntimeSettings fromRows(Map<String, String> rows, Instant updatedAt) {
        RuntimeSettings base = defaults();
        return new RuntimeSettings(
            bool(rows, "realtime.enabled", base.realtimeEnabled()),
            bool(rows, "realtime.sse-enabled", base.sseEnabled()),
            bool(rows, "realtime.polling-enabled", base.pollingEnabled()),
            clamped(rows, "realtime.max-public-sse-connections", base.maxPublicSseConnections(), 0, MAX_PUBLIC_SSE_CEILING),
            clamped(rows, "realtime.max-staff-sse-connections", base.maxStaffSseConnections(), 0, MAX_STAFF_SSE_CEILING),
            clamped(rows, "realtime.polling-interval-ms", base.pollingIntervalMs(), MIN_POLLING_INTERVAL_MS, MAX_POLLING_INTERVAL_MS),
            clamped(rows, "realtime.heartbeat-interval-ms", base.heartbeatIntervalMs(), MIN_HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_INTERVAL_MS),
            clamped(rows, "realtime.reconnect-delay-ms", base.reconnectDelayMs(), MIN_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS),
            updatedAt
        );
    }

    private static boolean bool(Map<String, String> rows, String key, boolean fallback) {
        String value = rows.get(key);
        return value == null ? fallback : Boolean.parseBoolean(value);
    }

    private static int clamped(Map<String, String> rows, String key, int fallback, int min, int max) {
        String value = rows.get(key);
        if (value == null) return fallback;
        try {
            return Math.max(min, Math.min(max, Integer.parseInt(value.trim())));
        } catch (NumberFormatException malformed) {
            return fallback;
        }
    }
}
