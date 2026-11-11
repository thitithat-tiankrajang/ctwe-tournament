package com.ctwe.tournament.infrastructure.security;

import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.event.AuthenticationFailureBadCredentialsEvent;
import org.springframework.security.authentication.event.AuthenticationSuccessEvent;
import org.springframework.stereotype.Component;

/**
 * Account-wide lockout, the backstop behind {@link LoginThrottle}'s per-address limit.
 *
 * <p>Only a WRONG PASSWORD counts. An attempt against an already-locked account is rejected as
 * "disabled" before the password is checked, and used to count too — re-stamping {@code locked_until}
 * each time, so one request every 14 minutes kept an account locked forever. A lock that has expired
 * also starts a fresh count instead of re-locking on the very next mistake.
 *
 * <p>The threshold is above the per-address limit, so reaching it takes failures from more than one
 * address.
 */
@Component
public class StaffAuthenticationEvents {
    static final int ACCOUNT_LOCK_THRESHOLD = 10;

    private final JdbcTemplate jdbc;

    public StaffAuthenticationEvents(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @EventListener
    public void failed(AuthenticationFailureBadCredentialsEvent event) {
        // Every right-hand side sees the row's OLD values, so `restarted` below is evaluated once
        // against the pre-update state for both columns.
        jdbc.update("""
            UPDATE staff_accounts
            SET failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                                       THEN 1 ELSE failed_attempts + 1 END,
                locked_until = CASE
                    WHEN locked_until IS NOT NULL AND locked_until > now() THEN locked_until
                    WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                               THEN 1 ELSE failed_attempts + 1 END) >= ?
                        THEN now() + interval '15 minutes'
                    ELSE NULL END
            WHERE username = ?
            """, ACCOUNT_LOCK_THRESHOLD, event.getAuthentication().getName());
    }

    @EventListener
    public void succeeded(AuthenticationSuccessEvent event) {
        jdbc.update("""
            UPDATE staff_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
            WHERE username = ?
            """, event.getAuthentication().getName());
    }
}
