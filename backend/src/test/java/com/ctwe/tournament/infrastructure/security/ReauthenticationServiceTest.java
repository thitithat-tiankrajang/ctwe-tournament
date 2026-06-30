package com.ctwe.tournament.infrastructure.security;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ReauthenticationServiceTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final PasswordEncoder encoder = mock(PasswordEncoder.class);
    private final ReauthenticationService service = new ReauthenticationService(jdbc, encoder);
    private final UsernamePasswordAuthenticationToken director = new UsernamePasswordAuthenticationToken(
        "director", "n/a", List.of(new SimpleGrantedAuthority("ROLE_DIRECTOR"))
    );

    @Test
    void acceptsCurrentDirectorsPassword() {
        when(jdbc.queryForObject(
            "SELECT password_hash FROM staff_accounts WHERE username = ?",
            String.class,
            "director"
        )).thenReturn("{bcrypt}hash");
        when(encoder.matches("correct-password", "{bcrypt}hash")).thenReturn(true);

        assertThatCode(() -> service.requireCurrentPassword(director, "correct-password"))
            .doesNotThrowAnyException();
    }

    @Test
    void rejectsWrongPassword() {
        when(jdbc.queryForObject(
            "SELECT password_hash FROM staff_accounts WHERE username = ?",
            String.class,
            "director"
        )).thenReturn("{bcrypt}hash");
        when(encoder.matches("wrong-password", "{bcrypt}hash")).thenReturn(false);

        assertThatThrownBy(() -> service.requireCurrentPassword(director, "wrong-password"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("401");
    }
}
