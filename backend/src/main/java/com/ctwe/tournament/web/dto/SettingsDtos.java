package com.ctwe.tournament.web.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

import java.time.Instant;

public final class SettingsDtos {
    private SettingsDtos() {}

    /** Admin write model. Ranges mirror the server-side clamps in RuntimeSettings. */
    public record RealtimeSettingsRequest(
        @NotNull Boolean realtimeEnabled,
        @NotNull Boolean sseEnabled,
        @NotNull Boolean pollingEnabled,
        @NotNull @Min(0) @Max(1500) Integer maxPublicSseConnections,
        @NotNull @Min(0) @Max(1000) Integer maxStaffSseConnections,
        @NotNull @Min(5_000) @Max(600_000) Integer pollingIntervalMs,
        @NotNull @Min(5_000) @Max(120_000) Integer heartbeatIntervalMs,
        @NotNull @Min(500) @Max(30_000) Integer reconnectDelayMs
    ) {}

    /** Admin read model: the stored settings plus live stream occupancy for context. */
    public record RealtimeSettingsResponse(
        boolean realtimeEnabled,
        boolean sseEnabled,
        boolean pollingEnabled,
        int maxPublicSseConnections,
        int maxStaffSseConnections,
        int pollingIntervalMs,
        int heartbeatIntervalMs,
        int reconnectDelayMs,
        int activePublicStreams,
        int activeStaffStreams,
        Instant updatedAt
    ) {}

    /** Anonymous client contract: only what a browser needs to pick its sync strategy. */
    public record PublicRealtimeConfig(
        boolean realtimeEnabled,
        boolean sseEnabled,
        boolean pollingEnabled,
        int pollingIntervalMs,
        int reconnectDelayMs
    ) {}
}
