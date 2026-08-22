package com.ctwe.tournament.infrastructure.security;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ReauthenticationService {
    private final JdbcTemplate jdbc;
    private final PasswordEncoder passwordEncoder;

    public ReauthenticationService(JdbcTemplate jdbc, PasswordEncoder passwordEncoder) {
        this.jdbc = jdbc;
        this.passwordEncoder = passwordEncoder;
    }

    public void requireCurrentPassword(Authentication authentication, String password) {
        if (authentication == null || !authentication.isAuthenticated()
            || "anonymousUser".equals(authentication.getName()))
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        String hash;
        try {
            hash = jdbc.queryForObject(
                "SELECT password_hash FROM staff_accounts WHERE username = ?",
                String.class,
                authentication.getName()
            );
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        // A wrong password is NOT a lost session: 403 + a body code, so the client can tell it apart
        // from CSRF rejection (also 403) and from the genuine no-session 401s above.
        if (hash == null || !passwordEncoder.matches(password, hash))
            throw new BadReauthenticationException();
    }
}
