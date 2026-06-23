package com.ctwe.tournament.web;

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
}
