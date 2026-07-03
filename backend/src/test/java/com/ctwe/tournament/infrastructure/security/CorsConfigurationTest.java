package com.ctwe.tournament.infrastructure.security;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class CorsConfigurationTest {
    private static final String WORKER_ORIGIN = "https://ctwe-tournament.ctwe.workers.dev";

    @Test
    void allowsOnlyConfiguredCredentialedOrigins() {
        var source = new SecurityConfiguration().corsConfigurationSource(
            WORKER_ORIGIN + ", https://preview.example.com"
        );
        var configuration = source.getCorsConfiguration(new MockHttpServletRequest("OPTIONS", "/api/auth/me"));

        assertThat(configuration).isNotNull();
        assertThat(configuration.getAllowedOrigins())
            .containsExactly(WORKER_ORIGIN, "https://preview.example.com");
        assertThat(configuration.getAllowedMethods())
            .containsExactly("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");
        assertThat(configuration.getAllowedHeaders())
            .contains("Content-Type", "X-CSRF-TOKEN", "X-XSRF-TOKEN");
        assertThat(configuration.getAllowCredentials()).isTrue();
        assertThat(configuration.checkOrigin(WORKER_ORIGIN)).isEqualTo(WORKER_ORIGIN);
        assertThat(configuration.checkOrigin("https://attacker.example")).isNull();
    }
}
