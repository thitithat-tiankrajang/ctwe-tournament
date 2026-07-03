package com.ctwe.tournament.application;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RuntimeSettingsTest {
    @Test
    void clampsOutOfRangeRowsAndFallsBackOnGarbage() {
        RuntimeSettings settings = RuntimeSettings.fromRows(Map.of(
            "realtime.enabled", "false",
            "realtime.max-public-sse-connections", "999999",
            "realtime.max-staff-sse-connections", "-5",
            "realtime.polling-interval-ms", "banana",
            "realtime.heartbeat-interval-ms", "1",
            "realtime.reconnect-delay-ms", "100"
        ), null);

        assertThat(settings.realtimeEnabled()).isFalse();
        assertThat(settings.sseEnabled()).isTrue(); // missing row -> default
        assertThat(settings.maxPublicSseConnections()).isEqualTo(RuntimeSettings.MAX_PUBLIC_SSE_CEILING);
        assertThat(settings.maxStaffSseConnections()).isZero();
        assertThat(settings.pollingIntervalMs()).isEqualTo(RuntimeSettings.defaults().pollingIntervalMs());
        assertThat(settings.heartbeatIntervalMs()).isEqualTo(RuntimeSettings.MIN_HEARTBEAT_INTERVAL_MS);
        assertThat(settings.reconnectDelayMs()).isEqualTo(RuntimeSettings.MIN_RECONNECT_DELAY_MS);
    }

    @Test
    void settingsChangesAffectOnlyNewSubscribersAndNeverExistingStreams() {
        UUID cardId = UUID.randomUUID();
        RuntimeSettings open = new RuntimeSettings(true, true, true, 2, 2, 60_000, 25_000, 2_000, null);
        AtomicReference<RuntimeSettings> live = new AtomicReference<>(open);
        CardEventPublisher publisher = new CardEventPublisher(live::get, Runnable::run) {
            @Override SseEmitter createEmitter() { return new SseEmitter(); }
        };

        publisher.subscribePublic(cardId, () -> 1);
        publisher.subscribePublic(cardId, () -> 1);
        assertThat(publisher.activePublicStreams()).isEqualTo(2);

        // Admin lowers the cap below current occupancy: existing streams stay, new ones are refused.
        live.set(new RuntimeSettings(true, true, true, 1, 2, 60_000, 25_000, 2_000, null));
        assertThat(publisher.activePublicStreams()).isEqualTo(2);
        assertThatThrownBy(() -> publisher.subscribePublic(cardId, () -> 1))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));

        // Admin disables SSE entirely: same story — refuse new, keep existing.
        live.set(new RuntimeSettings(true, false, true, 10, 10, 60_000, 25_000, 2_000, null));
        assertThat(publisher.activePublicStreams()).isEqualTo(2);
        assertThatThrownBy(() -> publisher.subscribe(cardId, () -> 1))
            .isInstanceOf(ResponseStatusException.class);

        // Re-enabling with headroom admits new subscribers again, no restart involved.
        live.set(new RuntimeSettings(true, true, true, 10, 10, 60_000, 25_000, 2_000, null));
        publisher.subscribePublic(cardId, () -> 1);
        assertThat(publisher.activePublicStreams()).isEqualTo(3);
    }
}
