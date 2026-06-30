package com.ctwe.tournament.web;

import com.ctwe.tournament.infrastructure.security.ReauthenticationService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final ReauthenticationService reauthentication;

    public AuthController(ReauthenticationService reauthentication) {
        this.reauthentication = reauthentication;
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
        reauthentication.requireCurrentPassword(authentication, request.password());
    }

    public record AuthResponse(boolean authenticated, String username, List<String> roles, String csrfToken) {}
    public record VerifyPasswordRequest(@NotBlank String password) {}
}
