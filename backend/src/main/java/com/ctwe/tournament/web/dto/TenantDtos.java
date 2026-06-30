package com.ctwe.tournament.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** DTOs for the multi-tenant account/tournament management API (admin + director). */
public final class TenantDtos {
    private TenantDtos() {}

    public static final String USERNAME_PATTERN = "^[A-Za-z0-9_.@-]{3,64}$";

    public record CreateTournamentRequest(@NotBlank @Size(max = 180) String name) {}

    public record TournamentResponse(
        UUID id, String name, String status, String createdBy, Instant createdAt, long version,
        List<String> directors, int cardCount, String accessToken
    ) {}

    /** Admin OPEN/CLOSE toggle: password re-authenticates the admin before the status change. */
    public record TournamentStatusRequest(@NotNull Boolean open, @NotBlank String password) {}

    /** Public, anonymous view of an OPEN tournament shown on the root landing + token resolver. */
    public record PublicTournamentResponse(
        UUID id, String name, String accessToken, int cardCount, int publishedCardCount
    ) {}

    public record GrantTournamentRequest(@NotNull UUID tournamentId) {}

    /** Admin creates a director; tournamentIds (optional) assigns them on creation. */
    public record CreateDirectorRequest(
        @NotBlank @Pattern(regexp = USERNAME_PATTERN) String username,
        @NotBlank @Size(min = 8, max = 72) String password,
        List<UUID> tournamentIds
    ) {}

    /** Director creates a result-entry staff account under themselves. */
    public record CreateStaffRequest(
        @NotBlank @Pattern(regexp = USERNAME_PATTERN) String username,
        @NotBlank @Size(min = 8, max = 72) String password
    ) {}

    public record UserResponse(
        String username, String role, boolean enabled, String createdBy, Instant createdAt,
        List<UUID> tournamentIds
    ) {}

    public record AssignDirectorRequest(@NotBlank @Pattern(regexp = USERNAME_PATTERN) String username) {}

    public record PasswordRequest(@NotBlank @Size(min = 8, max = 72) String password) {}

    public record EnabledRequest(@NotNull Boolean enabled) {}

    /** Metadata for an archived (exported-to-Excel) tournament; the file blob is downloaded separately. */
    public record ArchiveSummary(
        UUID id, String tournamentName, String fileName, long byteSize,
        int cardCount, int playerCount, String archivedBy, Instant archivedAt
    ) {}
}
