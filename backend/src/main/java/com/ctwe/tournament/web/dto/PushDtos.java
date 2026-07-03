package com.ctwe.tournament.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.UUID;

public final class PushDtos {
    private PushDtos() {}

    public enum ScopeType { CARD, TOURNAMENT }

    public record ConfigResponse(boolean enabled, String publicKey) {}

    public record Keys(
        @NotBlank @Size(max = 255) @Pattern(regexp = "^[A-Za-z0-9_-]+={0,2}$") String p256dh,
        @NotBlank @Size(max = 255) @Pattern(regexp = "^[A-Za-z0-9_-]+={0,2}$") String auth
    ) {}

    public record Subscription(
        @NotBlank @Size(min = 20, max = 2048) String endpoint,
        Long expirationTime,
        @NotNull @Valid Keys keys
    ) {}

    public record SubscribeRequest(
        @NotNull @Valid Subscription subscription,
        @NotNull ScopeType scopeType,
        @NotNull UUID scopeId
    ) {}

    public record UnsubscribeRequest(
        @NotBlank @Size(min = 20, max = 2048) String endpoint,
        @NotNull ScopeType scopeType,
        @NotNull UUID scopeId
    ) {}

    public record RefreshRequest(
        @NotBlank @Size(min = 20, max = 2048) String oldEndpoint,
        @NotNull @Valid Subscription subscription
    ) {}
}
