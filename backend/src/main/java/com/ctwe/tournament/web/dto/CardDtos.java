package com.ctwe.tournament.web.dto;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
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
        boolean gibsonEnabled,
        PairingRuleType initialPairingRule,
        /** Which number the public reports name a slot by: PAIR or SEAT. Null means PAIR. */
        @Pattern(regexp = "PAIR|SEAT") String slotLabel
    ) {}

    // Scores are stored as SMALLINT (V19); ±30000 leaves headroom under the ±32767 column limit.
    // Negative scores are valid for a real match (V35 dropped the database CHECK). A BYE is NOT a
    // real match — it has no opponent — and is still required to be above zero by the entry grid.
    public record FinalResultRequest(
        @NotNull @Min(-30000) @Max(30000) Integer scoreOne,
        @NotNull @Min(-30000) @Max(30000) Integer scoreTwo,
        String password,
        UUID pairingId
    ) {}
    public record FinalWinnerRequest(
        @NotBlank String winnerId,
        @NotNull @Min(0) @Max(12) Integer winnerWins,
        @NotNull @Min(0) @Max(12) Integer winnerLosses,
        @NotNull @Min(-1000000) @Max(1000000) Integer totalDiff,
        String password,
        UUID pairingId
    ) {}

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
        @NotNull @Min(-30000) @Max(30000) Integer scoreOne,
        @NotNull @Min(-30000) @Max(30000) Integer scoreTwo,
        boolean editExisting
    ) {}

    public record ForceByeRequest(
        @NotBlank String expectedPlayer,
        @NotNull @Min(1) @Max(1500) Integer score,
        @NotBlank String password
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
        boolean confirmSchoolConflict,
        @Min(1) Integer gameNumber
    ) {}

    /** Director re-auth for pairing manipulation (undo / unpair). */
    public record PasswordRequest(@NotBlank String password) {}

    // ---- Screening Pool / Multi Switching: one tool, two entry points ----

    /**
     * The occupancy of one pairing slot. {@code one} / {@code two} are player codes ("P001") or null
     * for an empty seat. Used both as the precondition ("what it held when I staged") and as the
     * desired outcome ("what it should hold after").
     */
    public record SlotState(
        @NotNull @Min(1) @Max(12) Integer game,
        @NotNull @Min(1) @Max(4000) Integer table,
        String one,
        String two
    ) {}

    /** One player to hold, with the controlled reason the pool card and reports filter on. */
    public record ScreenEntry(
        @NotBlank String player,
        @NotBlank String reason,
        @Size(max = 280) String note,
        @Min(1) Integer fromGame
    ) {
        public ScreenEntry(String player, String reason, String note) { this(player, reason, note, null); }
    }

    /**
     * A whole change set, committed atomically or not at all.
     *
     * <p>{@code expect} is the concurrency precondition: the occupancy of every touched slot as the
     * client last saw it. A card-level version would be useless here — any staff member submitting
     * any result anywhere bumps it, so on a live floor the commit would never succeed.
     *
     * <p>{@code commitKey} makes a retry safe. {@code force} is accepted but rejected until P4.
     */
    public record PairingCommitRequest(
        @NotNull UUID commitKey,
        /**
         * Not {@code @NotBlank}: the same shape serves the dry run, which is read-only and already
         * gated on MANAGE_PAIRING, so demanding a password there would make the operator type it
         * once to preview and again to commit. The commit endpoint verifies it through
         * {@code ReauthenticationService}, which rejects blank and null alike.
         */
        String password,
        boolean force,
        @NotNull @Size(max = 4000) List<@jakarta.validation.Valid SlotState> expect,
        @NotNull @Size(max = 4000) List<@jakarta.validation.Valid SlotState> slots,
        @NotNull @Size(max = 5000) List<@jakarta.validation.Valid ScreenEntry> screen,
        @NotNull @Size(max = 5000) List<@NotBlank String> release,
        @NotNull @Size(max = 500) List<@NotBlank String> confirmWarnings,
        @Size(max = 4000) List<@jakarta.validation.Valid SlotState> clearResults
    ) {
        public PairingCommitRequest {
            clearResults = clearResults == null ? List.of() : List.copyOf(clearResults);
        }

        public PairingCommitRequest(UUID commitKey, String password, boolean force, List<SlotState> expect,
            List<SlotState> slots, List<ScreenEntry> screen, List<String> release, List<String> confirmWarnings) {
            this(commitKey, password, force, expect, slots, screen, release, confirmWarnings, List.of());
        }
    }

    /** One slot's before/after, as the diff sheet's first section renders it. */
    public record PairingChange(int game, int table, String beforeOne, String beforeTwo,
                                String afterOne, String afterTwo) {}

    /**
     * Something the commit will cause that the operator did not directly drag: a slot becoming a bye
     * or a void, a player entering or leaving the pool. The operator cares about the outcome, so a
     * preview that showed only direct moves would not be a preview of what happens.
     */
    public record PairingConsequence(String kind, Integer game, Integer table, String player) {}

    /** An acknowledgeable warning. {@code code} is what the client echoes in confirmWarnings. */
    public record PairingWarning(String code, int game, int table, String message) {}

    /** A non-overridable refusal. */
    public record PairingBlock(String code, Integer game, Integer table, String message) {}

    /** A slot whose current occupancy no longer matches what the client staged against. */
    public record SlotDrift(int game, int table, String expectedOne, String expectedTwo,
                            String actualOne, String actualTwo) {}

    /**
     * One competition result a force commit would destroy, in full.
     *
     * <p>Everything a person needs to recognise it — both players, both scores, the winner, who
     * entered it and when. The confirmation screen shows exactly this, and the audit record keeps
     * exactly this, because once the commit runs the match row no longer carries any of it.
     */
    public record DestroyedResult(int game, int table, String playerOne, String playerTwo,
                                  Integer scoreOne, Integer scoreTwo, String resultType,
                                  String winner, Integer calculatedDiff,
                                  String submittedBy, String submittedAt) {}

    /**
     * The dry run's answer, and the entire content of the confirmation sheet. Commit runs the same
     * evaluation, so a preview can never promise something the commit then refuses.
     *
     * <p>{@code resultsToRemove} is populated whenever the change set collides with recorded results,
     * whether or not force was asked for — the operator has to see what standing in the way costs.
     * {@code forceAvailable} is false when any of them cannot be safely unwound, so the button is
     * never offered for a removal that would fail.
     */
    public record PairingValidationResponse(
        boolean ok,
        List<PairingChange> changes,
        List<PairingConsequence> consequences,
        List<PairingWarning> warnings,
        List<PairingBlock> blocks,
        List<SlotDrift> drift,
        List<ScreeningHold> pool,
        List<DestroyedResult> resultsToRemove,
        boolean forceAvailable
    ) {}

    /** One open hold, as the right-hand panel renders it. */
    public record ScreeningHold(String player, String screenedAt, String screenedBy, String reason,
                                String note, Integer originGame, Integer originTable,
                                Integer originSide, String originOpponent, boolean originStale, Integer fromGame) {
        public ScreeningHold(String player, String screenedAt, String screenedBy, String reason,
            String note, Integer originGame, Integer originTable, Integer originSide, String originOpponent, boolean originStale) {
            this(player, screenedAt, screenedBy, reason, note, originGame, originTable, originSide, originOpponent, originStale, null);
        }
    }

    /**
     * Reopen player registration ("ลงทะเบียนเพิ่ม"). The password is optional: it is only required
     * (and verified) when a game-1 pairing already exists and must be discarded.
     */
    public record ReopenRegistrationRequest(String password) {}

    /** Batch terminate: pull players out of the running competition (director password required). */
    public record TerminateRequest(
        @NotNull @Size(min = 1, max = 5000) List<@NotBlank String> playerIds,
        @NotBlank String password,
        @Min(1) Integer fromGame
    ) {
        public TerminateRequest(List<String> playerIds, String password) { this(playerIds, password, null); }
    }

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
                                 int wins, int draws, int losses, int winPoints, int diff, boolean terminated,
                                 @JsonInclude(JsonInclude.Include.NON_NULL) Integer withdrawnFromGame,
                                 @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_EMPTY)
                                 List<Integer> rankingExcludedGames) {
        public PlayerResponse(String id, String firstName, String lastName, String school, String division,
            int wins, int draws, int losses, int winPoints, int diff, boolean terminated) {
            this(id, firstName, lastName, school, division, wins, draws, losses, winPoints, diff, terminated, null, List.of());
        }
    }
    public record TableResponse(String id, int number, List<String> playerIds) {}
    /**
     * {@code voided} — the slot lost both players to screening. It keeps its table number so seat
     * numbering and printed materials stay valid, holds nobody, and needs no result.
     *
     * <p>{@code resultWithdrawn} — a result the audience had already seen was removed by a force
     * commit and no replacement has been entered yet. Rendered as withdrawn rather than as
     * "not yet played", and cleared the moment staff submit a new result. Both flags reach anonymous
     * viewers through {@code PublicCardProjection}, which reuses this shape rather than defining its
     * own — the property that keeps the live API and published snapshots from ever disagreeing.
     */
    public record PairingResponse(String id, int gameNumber, int tableNumber, String playerOneId, String playerTwoId,
                                  String winnerId, Integer scoreOne, Integer scoreTwo, String resultType, Integer calculatedDiff,
                                  boolean playerOneGibsonized, boolean playerTwoGibsonized,
                                  boolean pairingPublished, boolean voided, boolean resultWithdrawn,
                                  @JsonInclude(JsonInclude.Include.NON_DEFAULT) boolean manualPairing,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) String pairingPublishedAt) {
        public PairingResponse(String id, int gameNumber, int tableNumber, String playerOneId, String playerTwoId,
            String winnerId, Integer scoreOne, Integer scoreTwo, String resultType, Integer calculatedDiff,
            boolean playerOneGibsonized, boolean playerTwoGibsonized, boolean pairingPublished, boolean voided, boolean resultWithdrawn) {
            this(id, gameNumber, tableNumber, playerOneId, playerTwoId, winnerId, scoreOne, scoreTwo, resultType, calculatedDiff,
                playerOneGibsonized, playerTwoGibsonized, pairingPublished, voided, resultWithdrawn, false, null);
        }
        public PairingResponse(String id, int gameNumber, int tableNumber, String playerOneId, String playerTwoId,
            String winnerId, Integer scoreOne, Integer scoreTwo, String resultType, Integer calculatedDiff,
            boolean playerOneGibsonized, boolean playerTwoGibsonized, boolean pairingPublished, boolean voided,
            boolean resultWithdrawn, boolean manualPairing) {
            this(id, gameNumber, tableNumber, playerOneId, playerTwoId, winnerId, scoreOne, scoreTwo, resultType, calculatedDiff,
                playerOneGibsonized, playerTwoGibsonized, pairingPublished, voided, resultWithdrawn, manualPairing, null);
        }
    }
    public record SnapshotResponse(String id, List<Integer> gameNumbers, List<PairingResponse> pairings, String confirmedAt) {}
    /** Lightweight result-save response: changed source/destination rows only, plus the card version. */
    public record ResultPatch(long version, List<PairingResponse> changedPairings,
                              @JsonIgnore Long publicVersion, @JsonIgnore boolean publicPairingsChanged) {
        public ResultPatch(long version, List<PairingResponse> changedPairings) {
            this(version, changedPairings, null, false);
        }
    }
    public record AuditResponse(String id, String timestamp, String user, String action, String oldValue, String newValue) {}

    // Final / championship round
    public record FinalGameResponse(int gameIndex, Integer scoreOne, Integer scoreTwo, String winnerId, Integer diff) {}
    public record FinalSlotResponse(int slot, String playerOneId, String playerTwoId, List<FinalGameResponse> games,
                                    String winnerId, Integer winnerWins, Integer winnerLosses, Integer totalDiff,
                                    @JsonInclude(JsonInclude.Include.NON_NULL) UUID pairingId) {
        public FinalSlotResponse(int slot, String playerOneId, String playerTwoId, List<FinalGameResponse> games,
                                 String winnerId, Integer winnerWins, Integer winnerLosses, Integer totalDiff) {
            this(slot, playerOneId, playerTwoId, games, winnerId, winnerWins, winnerLosses, totalDiff, null);
        }
    }
    public record FinalRoundResponse(
        List<FinalSlotResponse> slots,
        @JsonInclude(JsonInclude.Include.NON_NULL) List<String> seedPlayerIds
    ) {
        public FinalRoundResponse(List<FinalSlotResponse> slots) { this(slots, null); }
    }

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
        PairingRuleType initialPairingRule,
        List<RuleResponse> rules,
        List<PlayerResponse> players,
        List<TableResponse> tables,
        List<SnapshotResponse> snapshots,
        List<AuditResponse> audit,
        String finalType,
        int finalGames,
        FinalRoundResponse finalRound,
        boolean gibsonEnabled,
        Instant createdAt,
        String codePrefix,
        /**
         * Which number the public reports name a slot by: {@code PAIR} or {@code SEAT}. Pair n holds
         * seats 2n-1 and 2n, so the two are the same fact from opposite ends; the card picks the one
         * its audience actually hears announced, and the viewer shows only that column.
         */
        String slotLabel,
        /**
         * Players currently held in the Screening Pool. Staff-only, and stripped by
         * {@code PublicCardProjection} exactly as {@code tables} and {@code audit} are — screening is
         * an unconfirmed operational judgement about a named minor and has no public projection at
         * all until it becomes a fact (a bye, a penalty, a termination).
         *
         * <p>Carried on the card rather than fetched separately so it rides the existing SSE stream:
         * the tool's pool panel and the pre-generation warning both stay live with no polling.
         */
        List<ScreeningHold> screeningPool
    ) {}
}
