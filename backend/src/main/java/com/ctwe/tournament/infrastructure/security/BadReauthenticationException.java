package com.ctwe.tournament.infrastructure.security;

/**
 * A re-authentication attempt supplied the wrong password.
 *
 * <p>Deliberately its own type rather than a {@code ResponseStatusException}. {@code
 * server.error.include-message: never} strips the reason from Spring's default error body, so the
 * only way a user ever sees a readable message is a handler that writes the body itself — and a
 * blanket handler for {@code ResponseStatusException} would surface all 76 throw sites in the
 * backend at once, including one that names an internal configuration namespace. One dedicated type
 * with one throw site keeps exactly one message visible.
 *
 * <p>Answered with <b>403</b>, not 401: a wrong confirmation password is not a lost session, and 401
 * makes the frontend re-confirm the session before it can tell the difference. CSRF rejection is
 * also 403, so the two are separated by the body's {@code code}, never by status alone.
 *
 * @see com.ctwe.tournament.web.ApiExceptionHandler
 */
public class BadReauthenticationException extends RuntimeException {
    /** The single user-facing message for a wrong confirmation password. */
    public static final String MESSAGE = "รหัสผ่านไม่ถูกต้อง";
    /** Body discriminator; CSRF failures are 403 with no code at all. */
    public static final String CODE = "BAD_PASSWORD";

    public BadReauthenticationException() {
        super(MESSAGE);
    }
}
