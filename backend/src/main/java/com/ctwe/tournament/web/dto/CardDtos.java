package com.ctwe.tournament.web.dto;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class CardDtos {
    private CardDtos() {}

    public record CreateCardRequest(
        @NotNull UUID tournamentId,
        @NotBlank @Size(max = 180) String name,
        @NotBlank @Size(max = 180) String division,
        @Min(2) @Max(12) int numberOfGames,
        @NotNull @Size(min = 1, max = 11) List<PairingRuleType> rules,
        @NotNull @Size(min = 2, max = 12) List<@NotNull @Min(1) @Max(1000000) Integer> gameMaxDiffs,
        @Pattern(regexp = "NONE|CHAMPION|CHAMPION_AND_THIRD") String finalType,
        @Min(0) @Max(12) int finalGames,
        boolean gibsonEnabled
    ) {}

    // Scores are stored as SMALLINT (V19); 30000 leaves headroom under the 32767 column limit.
    public record FinalResultRequest(@NotNull @Min(0) @Max(30000) Integer scoreOne, @NotNull @Min(0) @Max(30000) Integer scoreTwo) {}
    public record FinalWinnerRequest(@NotBlank String winnerId) {}

    public record PlayerRequest(
        @Size(max = 64) @Pattern(regexp = "[A-Za-z0-9_-]+") String id,
        @NotBlank @Size(max = 120) String firstName,
        @NotBlank @Size(max = 120) String lastName,
        @NotBlank @Size(max = 200) String school
    ) {}

    public record BulkPlayerEntry(
        @NotBlank @Size(max = 120) String firstName,
        @NotBlank @Size(max = 120) String lastName,
        @NotBlank @Size(max = 200) String school
    ) {}

    public record BulkPlayersRequest(@NotNull @Size(min = 1, max = 5000) List<@jakarta.validation.Valid BulkPlayerEntry> players) {}

    public record ResultRequest(
        @NotNull @Min(0) @Max(30000) Integer scoreOne,
        @NotNull @Min(0) @Max(30000) Integer scoreTwo,
        boolean editExisting
    ) {}

    /** Director "ลงดาบ": penalty points applied as −points to both players; password re-authenticates. */
    public record PenaltyRequest(
        @NotNull @Min(0) @Max(1000000) Integer points,
        @NotBlank String password
    ) {}

    public record SwapRequest(
        @NotBlank String firstPlayerId,
        @NotBlank String secondPlayerId,
        @NotBlank String password,
        boolean confirmSchoolConflict
    ) {}

    /** Director re-auth for pairing manipulation (undo / unpair). */
    public record PasswordRequest(@NotBlank String password) {}

    /** Batch terminate: pull players out of the running competition (director password required). */
    public record TerminateRequest(
        @NotNull @Size(min = 1, max = 5000) List<@NotBlank String> playerIds,
        @NotBlank String password
    ) {}

    /**
     * Batch restore of terminated players. {@code lossPoints} is the per-missed-game loss margin;
     * {@code unpair} (case B) discards the current pairing so restored players re-enter it.
     */
    public record RestoreRequest(
        @NotNull @Size(min = 1, max = 5000) List<@NotBlank String> playerIds,
        @NotBlank String password,
        @NotNull @Min(0) @Max(1000000) Integer lossPoints,
        boolean unpair
    ) {}

    public record GameResponse(String id, int number, String name, String status, int maxDiff) {}
    public record RuleResponse(int fromGame, int toGame, PairingRuleType type) {}
    public record PlayerResponse(String id, String firstName, String lastName, String school, String division,
                                 int wins, int draws, int losses, int winPoints, int diff, boolean terminated) {}
    public record TableResponse(String id, int number, List<String> playerIds) {}
    public record PairingResponse(String id, int gameNumber, int tableNumber, String playerOneId, String playerTwoId,
                                  String winnerId, Integer scoreOne, Integer scoreTwo, String resultType, Integer calculatedDiff,
                                  boolean pairingPublished) {}
    public record SnapshotResponse(String id, List<Integer> gameNumbers, List<PairingResponse> pairings, String confirmedAt) {}
    /** Lightweight result-save response: changed source/destination rows only, plus the card version. */
    public record ResultPatch(long version, List<PairingResponse> changedPairings) {}
    public record AuditResponse(String id, String timestamp, String user, String action, String oldValue, String newValue) {}

    // Final / championship round
    public record FinalGameResponse(int gameIndex, Integer scoreOne, Integer scoreTwo, String winnerId) {}
    public record FinalSlotResponse(int slot, String playerOneId, String playerTwoId, List<FinalGameResponse> games, String winnerId) {}
    public record FinalRoundResponse(List<FinalSlotResponse> slots) {}

    public record CardResponse(
        UUID id,
        UUID tournamentId,
        String name,
        String division,
        CardStatus status,
        RuntimeStage runtimeStage,
        int currentGame,
        long version,
        List<GameResponse> games,
        List<RuleResponse> rules,
        List<PlayerResponse> players,
        List<TableResponse> tables,
        List<SnapshotResponse> snapshots,
        List<AuditResponse> audit,
        String finalType,
        int finalGames,
        FinalRoundResponse finalRound,
        boolean gibsonEnabled,
        Instant createdAt
    ) {}
}
