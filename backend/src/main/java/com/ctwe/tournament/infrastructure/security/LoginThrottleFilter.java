package com.ctwe.tournament.infrastructure.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Applies {@link LoginThrottle} to {@code POST /login}. Sits in the security chain just before the
 * form-login filter (so after CSRF). Deliberately NOT a Spring bean: Boot would otherwise also
 * register it as a plain servlet filter and run it twice.
 */
final class LoginThrottleFilter extends OncePerRequestFilter {
    /** Set by Cloudflare at its edge — every request to Render passes through it — and not client-controllable there. */
    static final String CLIENT_ADDRESS_HEADER = "CF-Connecting-IP";

    private final LoginThrottle throttle;

    LoginThrottleFilter(LoginThrottle throttle) {
        this.throttle = throttle;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // The URI minus the context path, not getServletPath(): the servlet path is "" for "/" mappings
        // in some containers (MockMvc among them), which would silently switch the throttle off.
        String path = request.getRequestURI().substring(request.getContextPath().length());
        return !("POST".equals(request.getMethod()) && "/login".equals(path));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
        String username = Objects.requireNonNullElse(request.getParameter("username"), "");
        String clientAddress = clientAddress(request);

        Optional<Duration> blocked = throttle.blockedFor(username, clientAddress);
        if (blocked.isPresent()) {
            reject(response, blocked.get());
            return;
        }
        if (!throttle.tryBeginVerification()) {
            reject(response, LoginThrottle.BUSY_RETRY);
            return;
        }
        try {
            chain.doFilter(request, response);
        } finally {
            throttle.endVerification();
        }
        int status = response.getStatus();
        if (status == HttpStatus.UNAUTHORIZED.value()) throttle.recordFailure(username, clientAddress);
        else if (status >= 200 && status < 300) throttle.recordSuccess(username, clientAddress);
    }

    static String clientAddress(HttpServletRequest request) {
        String edge = request.getHeader(CLIENT_ADDRESS_HEADER);
        if (edge != null && !edge.isBlank() && edge.length() <= 64) return edge.trim();
        return Objects.requireNonNullElse(request.getRemoteAddr(), "");
    }

    private static void reject(HttpServletResponse response, Duration retryAfter) {
        long seconds = Math.max(1, (retryAfter.toMillis() + 999) / 1000);
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader("Retry-After", Long.toString(seconds));
    }
}
