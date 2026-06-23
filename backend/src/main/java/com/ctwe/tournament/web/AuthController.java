package com.ctwe.tournament.web;

import org.springframework.security.core.Authentication;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    @GetMapping("/me")
    public AuthResponse me(Authentication authentication, CsrfToken csrfToken) {
        boolean authenticated = authentication != null && authentication.isAuthenticated()
            && !"anonymousUser".equals(authentication.getName());
        List<String> roles = authenticated
            ? authentication.getAuthorities().stream().map(item -> item.getAuthority()).toList()
            : List.of();
        return new AuthResponse(authenticated, authenticated ? authentication.getName() : null, roles, csrfToken.getToken());
    }

    public record AuthResponse(boolean authenticated, String username, List<String> roles, String csrfToken) {}
}
