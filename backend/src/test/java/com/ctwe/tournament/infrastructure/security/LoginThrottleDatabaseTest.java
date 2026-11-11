package com.ctwe.tournament.infrastructure.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Transactional;

/**
 * {@code POST /login} through the real security chain and real PostgreSQL: the per-address
 * throttle answers 429 before any password check, an attacker's address cannot lock the owner out,
 * and the account-wide lock neither self-extends nor re-locks on the first mistake after expiry.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class LoginThrottleDatabaseTest {
    private static final String PASSWORD = "matrix-password-1";
    private static final String PASSWORD_HASH = "{bcrypt}$2y$12$Uk9bpX1P1GaASlpp1vCAlOOQ5wp3knfOCjoTQFpqQGWA6PIsbVD1W";

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    /** The throttle is a context singleton, so every test gets a username no other test touches. */
    private String user;

    @BeforeEach
    void seed() {
        user = "throttle_" + UUID.randomUUID().toString().substring(0, 8);
        jdbc.update("INSERT INTO staff_accounts (username, password_hash, enabled) VALUES (?, ?, true)", user, PASSWORD_HASH);
        jdbc.update("INSERT INTO staff_authorities (username, authority) VALUES (?, 'ROLE_DIRECTOR')", user);
    }

    private MvcResult login(String password, String address) throws Exception {
        return mvc.perform(post("/login").with(csrf())
                .header(LoginThrottleFilter.CLIENT_ADDRESS_HEADER, address)
                .param("username", user)
                .param("password", password))
            .andReturn();
    }

    private int failedAttempts() {
        return jdbc.queryForObject("SELECT failed_attempts FROM staff_accounts WHERE username = ?", Integer.class, user);
    }

    private boolean locked() {
        return Boolean.TRUE.equals(jdbc.queryForObject(
            "SELECT locked_until IS NOT NULL AND locked_until > now() FROM staff_accounts WHERE username = ?", Boolean.class, user));
    }

    @Test
    void theSixthWrongPasswordFromOneAddressIsRefusedBeforeAnyPasswordCheck() throws Exception {
        for (int i = 0; i < LoginThrottle.MAX_FAILURES; i++)
            assertThat(login("wrong-" + i, "203.0.113.7").getResponse().getStatus()).isEqualTo(401);

        MvcResult refused = login("wrong-again", "203.0.113.7");
        assertThat(refused.getResponse().getStatus()).isEqualTo(429);
        assertThat(Long.parseLong(refused.getResponse().getHeader("Retry-After"))).isBetween(1L, 900L);
        // Refused at the filter: the account never saw this attempt.
        assertThat(failedAttempts()).isEqualTo(LoginThrottle.MAX_FAILURES);
        // Even the right password is refused from that address until the window passes.
        assertThat(login(PASSWORD, "203.0.113.7").getResponse().getStatus()).isEqualTo(429);
    }

    @Test
    void anAttackerAtAnotherAddressCannotLockTheOwnerOut() throws Exception {
        for (int i = 0; i < LoginThrottle.MAX_FAILURES + 3; i++) login("wrong-" + i, "198.51.100.66");

        assertThat(locked()).isFalse();
        assertThat(login(PASSWORD, "192.0.2.10").getResponse().getStatus()).isEqualTo(204);
        assertThat(failedAttempts()).isZero();
    }

    @Test
    void failuresSpreadAcrossAddressesStillLockTheAccount() throws Exception {
        String[] addresses = {"198.51.100.1", "198.51.100.2"};
        for (String address : addresses)
            for (int i = 0; i < LoginThrottle.MAX_FAILURES; i++) login("wrong-" + i, address);

        assertThat(failedAttempts()).isEqualTo(StaffAuthenticationEvents.ACCOUNT_LOCK_THRESHOLD);
        assertThat(locked()).isTrue();
        assertThat(login(PASSWORD, "192.0.2.10").getResponse().getStatus()).isEqualTo(401);
    }

    @Test
    void attemptsAgainstALockedAccountDoNotExtendTheLock() throws Exception {
        jdbc.update("UPDATE staff_accounts SET failed_attempts = ?, locked_until = now() + interval '1 minute' WHERE username = ?",
            StaffAuthenticationEvents.ACCOUNT_LOCK_THRESHOLD, user);
        var before = jdbc.queryForObject("SELECT locked_until FROM staff_accounts WHERE username = ?", java.sql.Timestamp.class, user);

        assertThat(login("wrong", "198.51.100.9").getResponse().getStatus()).isEqualTo(401);

        var after = jdbc.queryForObject("SELECT locked_until FROM staff_accounts WHERE username = ?", java.sql.Timestamp.class, user);
        assertThat(after).isEqualTo(before);
        assertThat(failedAttempts()).isEqualTo(StaffAuthenticationEvents.ACCOUNT_LOCK_THRESHOLD);
    }

    @Test
    void aMistakeAfterAnExpiredLockStartsAFreshCount() throws Exception {
        jdbc.update("UPDATE staff_accounts SET failed_attempts = ?, locked_until = now() - interval '1 minute' WHERE username = ?",
            StaffAuthenticationEvents.ACCOUNT_LOCK_THRESHOLD, user);

        assertThat(login("wrong", "198.51.100.9").getResponse().getStatus()).isEqualTo(401);

        assertThat(failedAttempts()).isEqualTo(1);
        assertThat(locked()).isFalse();
        assertThat(login(PASSWORD, "198.51.100.9").getResponse().getStatus()).isEqualTo(204);
    }
}
