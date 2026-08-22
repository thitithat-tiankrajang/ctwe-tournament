package com.ctwe.tournament.web;

import com.ctwe.tournament.infrastructure.security.BadReauthenticationException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Method;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The re-authentication error contract (B2).
 *
 * <p>What matters here is the <b>message the user actually sees</b>, not merely the status.
 * {@code server.error.include-message: never} strips reasons from Spring's default error body, so
 * before this contract existed a director who mistyped their password saw the English word
 * "Unauthorized" in an all-Thai interface — and only the frontend's pre-flight
 * {@code verifyPassword} call hid that. P2 removes the pre-flight, so this contract is what replaces
 * it.
 *
 * <p>No database and no Spring context: standalone MockMvc over the real advice.
 */
class ReauthErrorContractTest {

    @RestController
    static class ThrowingController {
        @GetMapping("/boom/bad-password")
        String badPassword() { throw new BadReauthenticationException(); }

        /** Stands in for the other 75 ResponseStatusException throw sites in the backend. */
        @GetMapping("/boom/generic")
        String generic() { throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "some internal reason"); }
    }

    private final MockMvc mvc = MockMvcBuilders
        .standaloneSetup(new ThrowingController())
        .setControllerAdvice(new ApiExceptionHandler())
        .build();

    @Test
    @DisplayName("a wrong confirmation password is 403 with the Thai message and a BAD_PASSWORD code")
    void wrongPasswordIsReadableAndTagged() throws Exception {
        mvc.perform(get("/boom/bad-password"))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.status").value(403))
            .andExpect(jsonPath("$.error").value("รหัสผ่านไม่ถูกต้อง"))
            .andExpect(jsonPath("$.code").value("BAD_PASSWORD"));
    }

    @Test
    @DisplayName("403 alone is not the discriminator — CSRF rejection is 403 too, so the code is what separates them")
    void codeIsTheDiscriminatorNotTheStatus() {
        // CSRF rejection surfaces as AccessDeniedException -> Spring's default 403 body, which has no
        // "code". That stays true only while this advice declines to handle it, so assert that.
        assertThat(handlerFor(AccessDeniedException.class))
            .as("handling AccessDeniedException here would make CSRF indistinguishable from a wrong password")
            .isNull();
    }

    @Test
    @DisplayName("the other 75 ResponseStatusException sites stay unhandled — no blanket message disclosure")
    void genericResponseStatusExceptionIsNotGivenABody() throws Exception {
        assertThat(handlerFor(ResponseStatusException.class))
            .as("a blanket ResponseStatusException handler would surface all 76 backend messages at once")
            .isNull();

        mvc.perform(get("/boom/generic"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").doesNotExist());
    }

    /** The advice must not grow a handler that swallows these types; reflection keeps that honest. */
    private static Method handlerFor(Class<? extends Throwable> type) {
        return Arrays.stream(ApiExceptionHandler.class.getDeclaredMethods())
            .filter(method -> {
                var annotation = method.getAnnotation(
                    org.springframework.web.bind.annotation.ExceptionHandler.class);
                return annotation != null && Arrays.asList(annotation.value()).contains(type);
            })
            .findFirst().orElse(null);
    }
}
