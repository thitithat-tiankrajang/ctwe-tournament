package com.ctwe.tournament.web;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

class AccountControllerResponseContractTest {
    @Test
    void accountMutationsReturnNoContent() {
        assertNoContent(AdminController.class, "setDirectorEnabled");
        assertNoContent(AdminController.class, "resetDirectorPassword");
        assertNoContent(DirectorController.class, "setStaffEnabled");
        assertNoContent(DirectorController.class, "resetStaffPassword");
    }

    private static void assertNoContent(Class<?> controller, String methodName) {
        Method method = java.util.Arrays.stream(controller.getDeclaredMethods())
            .filter(candidate -> candidate.getName().equals(methodName))
            .findFirst()
            .orElseThrow();
        ResponseStatus status = method.getAnnotation(ResponseStatus.class);
        assertThat(status).as(controller.getSimpleName() + "." + methodName).isNotNull();
        assertThat(status.value()).isEqualTo(HttpStatus.NO_CONTENT);
    }
}
