package com.ctwe.tournament.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final JdbcTemplate jdbc;
    private final PasswordEncoder passwordEncoder;

    public AuthController(JdbcTemplate jdbc, PasswordEncoder passwordEncoder) {
        this.jdbc = jdbc;
        this.passwordEncoder = passwordEncoder;
    }

    @GetMapping("/me")
    public AuthResponse me(Authentication authentication, CsrfToken csrfToken) {
        boolean authenticated = authentication != null && authentication.isAuthenticated()
            && !"anonymousUser".equals(authentication.getName());
        List<String> roles = authenticated
            ? authentication.getAuthorities().stream().map(item -> item.getAuthority()).toList()
            : List.of();
        return new AuthResponse(authenticated, authenticated ? authentication.getName() : null, roles, csrfToken.getToken());
    }

    /** Re-authenticate the current user (e.g. a director confirming a sensitive backdated edit). */
    @PostMapping("/verify-password")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void verifyPassword(@Valid @RequestBody VerifyPasswordRequest request, Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated() || "anonymousUser".equals(authentication.getName()))
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        String hash;
        try {
            hash = jdbc.queryForObject("SELECT password_hash FROM staff_accounts WHERE username = ?", String.class, authentication.getName());
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        if (hash == null || !passwordEncoder.matches(request.password(), hash))
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "รหัสผ่านไม่ถูกต้อง");
    }

    public record AuthResponse(boolean authenticated, String username, List<String> roles, String csrfToken) {}
    public record VerifyPasswordRequest(@NotBlank String password) {}
}
