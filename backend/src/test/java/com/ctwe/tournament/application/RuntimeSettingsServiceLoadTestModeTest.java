package com.ctwe.tournament.application;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

class RuntimeSettingsServiceLoadTestModeTest {

    private JdbcTemplate jdbcReturning(String maxPublicSse) {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        doAnswer(invocation -> {
            // JdbcTemplate.query(sql, RowCallbackHandler) — feed a single settings row when given.
            if (maxPublicSse != null) {
                var rs = mock(java.sql.ResultSet.class);
                org.mockito.Mockito.when(rs.getString("key")).thenReturn("realtime.max-public-sse-connections");
                org.mockito.Mockito.when(rs.getString("value")).thenReturn(maxPublicSse);
                org.mockito.Mockito.when(rs.getTimestamp("updated_at")).thenReturn(null);
                invocation.getArgument(1, RowCallbackHandler.class).processRow(rs);
            }
            return null;
        }).when(jdbc).query(anyString(), any(RowCallbackHandler.class));
        return jdbc;
    }

    @Test
    void productionModeKeepsDatabaseValueAndCeiling() {
        var service = new RuntimeSettingsService(jdbcReturning("999999"), false, 10_000);

        RuntimeSettings settings = service.current();

        // The 1500 ceiling still clamps absurd database rows when the flag is off.
        assertThat(settings.maxPublicSseConnections()).isEqualTo(RuntimeSettings.MAX_PUBLIC_SSE_CEILING);
    }

    @Test
    void loadTestModeOverridesPublicCapAboveCeiling() {
        var service = new RuntimeSettingsService(jdbcReturning("800"), true, 10_000);

        RuntimeSettings settings = service.current();

        assertThat(settings.maxPublicSseConnections()).isEqualTo(10_000);
        // Only the public viewer cap is overridden; everything else keeps production behavior.
        assertThat(settings.maxStaffSseConnections()).isEqualTo(RuntimeSettings.defaults().maxStaffSseConnections());
        assertThat(settings.heartbeatIntervalMs()).isEqualTo(RuntimeSettings.defaults().heartbeatIntervalMs());
        assertThat(settings.sseEnabled()).isTrue();
    }

    @Test
    void loadTestModeRejectsNonPositiveOverride() {
        assertThatThrownBy(() -> new RuntimeSettingsService(jdbcReturning("800"), true, 0))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("MAX_SSE_CONNECTIONS");
    }

    @Test
    void loadTestModeOffIsIdentity() {
        var service = new RuntimeSettingsService(jdbcReturning("800"), false, 10_000);

        assertThat(service.current().maxPublicSseConnections()).isEqualTo(800);
    }
}
