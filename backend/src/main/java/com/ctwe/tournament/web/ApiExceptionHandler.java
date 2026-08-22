package com.ctwe.tournament.web;

import com.ctwe.tournament.infrastructure.security.BadReauthenticationException;
import org.springframework.http.HttpStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import java.time.Instant;
import java.util.Map;

@RestControllerAdvice
public class ApiExceptionHandler {
    @ExceptionHandler(IllegalArgumentException.class) @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, Object> invalidInput(IllegalArgumentException error) { return Map.of("timestamp", Instant.now(), "status", 400, "error", error.getMessage()); }

    @ExceptionHandler(MethodArgumentNotValidException.class) @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, Object> invalidRequest(MethodArgumentNotValidException error) {
        String message = error.getBindingResult().getFieldErrors().stream().findFirst()
            .map(item -> item.getField() + ": " + item.getDefaultMessage()).orElse("Invalid request");
        return Map.of("timestamp", Instant.now(), "status", 400, "error", message);
    }

    @ExceptionHandler(DataIntegrityViolationException.class) @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, Object> conflict(DataIntegrityViolationException error) {
        return Map.of("timestamp", Instant.now(), "status", 409, "error", "The request conflicts with existing data");
    }

    /**
     * The one re-authentication message that reaches the user.
     *
     * <p>{@code server.error.include-message: never} strips the reason from Spring's default error
     * body, so without this the client renders the English word "Unauthorized" in an all-Thai
     * interface. There is deliberately <b>no</b> handler for {@code ResponseStatusException} itself:
     * that would surface all 76 throw sites at once, one of which names an internal configuration
     * namespace. Widening this is a separate, reviewable change.
     *
     * <p>{@code code} is the discriminator, not the status — CSRF rejection is also 403 and keeps
     * Spring's default body, which carries no {@code code}.
     */
    @ExceptionHandler(BadReauthenticationException.class) @ResponseStatus(HttpStatus.FORBIDDEN)
    public Map<String, Object> badReauthentication(BadReauthenticationException error) {
        return Map.of("timestamp", Instant.now(), "status", 403,
            "error", error.getMessage(), "code", BadReauthenticationException.CODE);
    }
}
