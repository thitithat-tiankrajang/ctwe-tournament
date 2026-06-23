package com.ctwe.tournament.infrastructure.security;

import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.event.AbstractAuthenticationFailureEvent;
import org.springframework.security.authentication.event.AuthenticationSuccessEvent;
import org.springframework.stereotype.Component;

@Component
public class StaffAuthenticationEvents {
    private final JdbcTemplate jdbc;

    public StaffAuthenticationEvents(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @EventListener
    public void failed(AbstractAuthenticationFailureEvent event) {
        String username = event.getAuthentication().getName();
        jdbc.update("""
            UPDATE staff_accounts
            SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
            WHERE username = ?
            """, username);
    }

    @EventListener
    public void succeeded(AuthenticationSuccessEvent event) {
        jdbc.update("""
            UPDATE staff_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
            WHERE username = ?
            """, event.getAuthentication().getName());
    }
}
