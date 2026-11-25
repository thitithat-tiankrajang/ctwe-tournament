package com.ctwe.tournament.web;

import com.ctwe.tournament.application.PairingSessionService;
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

    /**
     * A pairing commit staged against slots that have since changed.
     *
     * <p>Distinct from the generic 409 above because the body carries {@code drift} — the slots whose
     * occupancy moved — which is what lets the tool mark exactly those rows conflicted instead of
     * making the director re-check a whole board.
     */
    @ExceptionHandler(PairingSessionService.SlotDriftException.class) @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, Object> slotDrift(PairingSessionService.SlotDriftException error) {
        return Map.of("timestamp", Instant.now(), "status", 409,
            "error", "คู่ที่เลือกไว้ถูกแก้ไขโดยผู้ใช้อื่นระหว่างที่กำลังจัดคู่",
            "code", "SLOT_DRIFT", "drift", error.drift());
    }

    /**
     * A pairing commit refused on its merits: a hard block, or a warning nobody acknowledged.
     *
     * <p>422 rather than 400 — the request is well-formed and was understood; it is the tournament
     * state that forbids it. The body separates the two so the sheet can render blocks as final and
     * warnings as checkboxes.
     */
    @ExceptionHandler(PairingSessionService.PairingRejectedException.class)
    @ResponseStatus(HttpStatus.UNPROCESSABLE_ENTITY)
    public Map<String, Object> pairingRejected(PairingSessionService.PairingRejectedException error) {
        return Map.of("timestamp", Instant.now(), "status", 422,
            "error", error.blocks().isEmpty()
                ? "มีคำเตือนที่ยังไม่ได้ยืนยัน"
                : error.blocks().get(0).message(),
            "code", error.blocks().isEmpty() ? "UNACKNOWLEDGED_WARNINGS" : "PAIRING_BLOCKED",
            "blocks", error.blocks(), "warnings", error.warnings());
    }
}
