package com.ctwe.tournament.infrastructure.security;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class CorsConfigurationTest {
    private static final String WORKER_ORIGIN = "https://ctwe-tournament.ctwe.workers.dev";
    private static final String CUSTOM_DOMAIN_ORIGIN = "https://ct-we.com";
    private static final String LAN_DEVELOPMENT_ORIGIN = "http://192.168.1.36:3000";

    @Test
    void allowsOnlyConfiguredCredentialedOrigins() {
        var source = new SecurityConfiguration().corsConfigurationSource(
            WORKER_ORIGIN + ", " + CUSTOM_DOMAIN_ORIGIN + ", " + LAN_DEVELOPMENT_ORIGIN
        );
        var configuration = source.getCorsConfiguration(new MockHttpServletRequest("OPTIONS", "/api/auth/me"));

        assertThat(configuration).isNotNull();
        assertThat(configuration.getAllowedOrigins())
            .containsExactly(WORKER_ORIGIN, CUSTOM_DOMAIN_ORIGIN, LAN_DEVELOPMENT_ORIGIN);
        assertThat(configuration.getAllowedMethods())
            .containsExactly("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");
        assertThat(configuration.getAllowedHeaders())
            .contains("Content-Type", "X-CSRF-TOKEN", "X-XSRF-TOKEN");
        assertThat(configuration.getAllowCredentials()).isTrue();
        assertThat(configuration.checkOrigin(WORKER_ORIGIN)).isEqualTo(WORKER_ORIGIN);
        assertThat(configuration.checkOrigin(CUSTOM_DOMAIN_ORIGIN)).isEqualTo(CUSTOM_DOMAIN_ORIGIN);
        assertThat(configuration.checkOrigin(LAN_DEVELOPMENT_ORIGIN)).isEqualTo(LAN_DEVELOPMENT_ORIGIN);
        assertThat(configuration.checkOrigin("https://attacker.example")).isNull();
    }
}
