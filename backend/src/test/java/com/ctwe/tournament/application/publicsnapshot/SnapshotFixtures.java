package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Shared fixtures for the Public Snapshot tests.
 *
 * <p>Fixed UUIDs and timestamps throughout: the artifact is compared byte-for-byte, so nothing here
 * may vary between runs.
 */
final class SnapshotFixtures {
    static final UUID TOURNAMENT_ID = UUID.fromString("aaaaaaaa-0000-4000-8000-000000000001");
    static final String TOURNAMENT_NAME = "CTWE 2026 ชิงแชมป์ประเทศไทย";

    /** FINISHED — counts as published, exposes the final round. */
    static final UUID CARD_FINISHED = UUID.fromString("bbbbbbbb-0000-4000-8000-000000000001");
    /** RUNNING with an unconfirmed snapshot — public stage collapses to RESULT_COLLECTION. */
    static final UUID CARD_RUNNING = UUID.fromString("bbbbbbbb-0000-4000-8000-000000000002");
    /** DRAFT — registration stage, no final round. */
    static final UUID CARD_DRAFT = UUID.fromString("bbbbbbbb-0000-4000-8000-000000000003");
    /** CLOSED — the other status that counts as published. */
    static final UUID CARD_CLOSED = UUID.fromString("bbbbbbbb-0000-4000-8000-000000000004");

    private SnapshotFixtures() {}

    /** One card as the database holds it: identity, the version viewers cache against, and its data. */
    record Seed(UUID id, long publicVersion, CardDtos.CardResponse source) {}

    /** The default tournament: four cards, deliberately spanning every projection branch. */
    static List<Seed> seeds() {
        return List.of(
            new Seed(CARD_FINISHED, 412L,
                card(CARD_FINISHED, CardStatus.FINISHED, RuntimeStage.RESULT_COLLECTION, confirmedSnapshots(), finalRound())),
            new Seed(CARD_RUNNING, 87L,
                card(CARD_RUNNING, CardStatus.RUNNING, RuntimeStage.TABLE_PAIRING, unconfirmedSnapshots(), finalRound())),
            new Seed(CARD_DRAFT, 1L,
                card(CARD_DRAFT, CardStatus.DRAFT, RuntimeStage.PLAYER_REGISTRATION, List.of(), null)),
            new Seed(CARD_CLOSED, 999L,
                card(CARD_CLOSED, CardStatus.CLOSED, RuntimeStage.FINAL_PUBLISHED, confirmedSnapshots(), finalRound())));
    }

    /**
     * Wires mocks so {@link PublicSnapshotBuilder} sees exactly {@code seeds} for {@code tournamentId},
     * in the given order, and resolves the tournament's name.
     */
    static void stub(JdbcTemplate jdbc, TournamentCardService cards, UUID tournamentId,
                     String tournamentName, List<Seed> seeds) {
        when(jdbc.queryForObject("SELECT name FROM tournaments WHERE id = ?", String.class, tournamentId))
            .thenReturn(tournamentName);

        // Drive the builder's own RowMapper with a stand-in ResultSet, so the id/public_version
        // mapping is exercised rather than bypassed.
        doAnswer(invocation -> {
            RowMapper<?> mapper = invocation.getArgument(1);
            List<Object> rows = new ArrayList<>();
            int index = 0;
            for (Seed seed : seeds) {
                ResultSet rs = mock(ResultSet.class);
                when(rs.getObject("id", UUID.class)).thenReturn(seed.id());
                when(rs.getLong("public_version")).thenReturn(seed.publicVersion());
                rows.add(mapper.mapRow(rs, index++));
            }
            return rows;
        }).when(jdbc).query(anyString(), any(RowMapper.class), eq(tournamentId));

        for (Seed seed : seeds) when(cards.get(seed.id(), false)).thenReturn(seed.source());
    }

    static void stubDefault(JdbcTemplate jdbc, TournamentCardService cards) {
        stub(jdbc, cards, TOURNAMENT_ID, TOURNAMENT_NAME, seeds());
    }

    /** A tournament that exists but has no cards yet. */
    static void stubEmpty(JdbcTemplate jdbc, TournamentCardService cards, UUID tournamentId) {
        stub(jdbc, cards, tournamentId, "รายการว่าง", List.of());
    }

    // ------------------------------------------------------------------ card data

    /**
     * A deliberately rich card: a win, a draw, a penalty, a bye, an unpublished destination row, a
     * Gibsonized player, a terminated player, plus the back-office collections the projection strips.
     */
    static CardDtos.CardResponse card(UUID id, CardStatus status, RuntimeStage stage,
                                      List<CardDtos.SnapshotResponse> snapshots,
                                      CardDtos.FinalRoundResponse finalRound) {
        return card(id, TOURNAMENT_ID, status, stage, snapshots, finalRound);
    }

    /**
     * The same card under an explicit tournament. Phase C's equivalence fixtures need more than one
     * tournament in the database at once, to prove both read paths scope their selection identically.
     */
    static CardDtos.CardResponse card(UUID id, UUID tournamentId, CardStatus status, RuntimeStage stage,
                                      List<CardDtos.SnapshotResponse> snapshots,
                                      CardDtos.FinalRoundResponse finalRound) {
        return new CardDtos.CardResponse(
            id, tournamentId, "CTWE 2026", "ม.ต้น ชาย", status, stage, 3, 7L,
            List.of(
                new CardDtos.GameResponse("1", 1, "เกม 1", "COMPLETED", 500),
                new CardDtos.GameResponse("2", 2, "เกม 2", "COMPLETED", 500),
                new CardDtos.GameResponse("3", 3, "เกม 3", "OPEN", 1000)),
            PairingRuleType.RANDOM,
            List.of(new CardDtos.RuleResponse(1, 2, PairingRuleType.SWISS),
                new CardDtos.RuleResponse(2, 3, PairingRuleType.PAIR_RESULT)),
            List.of(
                new CardDtos.PlayerResponse("P001", "สมชาย", "ใจดี", "โรงเรียนสวนกุหลาบ", "ม.ต้น ชาย", 2, 0, 1, 4, 120, false),
                new CardDtos.PlayerResponse("P002", "สมหญิง", "รักเรียน", "โรงเรียนเตรียมอุดม", "ม.ต้น ชาย", 1, 1, 1, 3, -15, false),
                new CardDtos.PlayerResponse("P003", "อนันต์", "มั่นคง", "โรงเรียนสาธิต", "ม.ต้น ชาย", 0, 0, 3, 0, -200, true)),
            List.of(new CardDtos.TableResponse("t1", 1, List.of("P001", "P002"))),
            snapshots,
            List.of(new CardDtos.AuditResponse("a1", "2026-08-01T10:00:00Z", "director01",
                "PUBLISH_GAME_RESULTS", null, "game [1]")),
            finalRound == null ? "NONE" : "CHAMPION_AND_THIRD", finalRound == null ? 0 : 3,
            finalRound, true, Instant.parse("2026-08-01T03:00:00Z"), "P");
    }

    static List<CardDtos.SnapshotResponse> confirmedSnapshots() {
        return List.of(new CardDtos.SnapshotResponse("s1", List.of(1, 2), pairings(), "2026-08-01T11:00:00Z"));
    }

    static List<CardDtos.SnapshotResponse> unconfirmedSnapshots() {
        return List.of(
            new CardDtos.SnapshotResponse("s1", List.of(1, 2), pairings(), "2026-08-01T11:00:00Z"),
            new CardDtos.SnapshotResponse("s2", List.of(3), pairings(), null));
    }

    static List<CardDtos.PairingResponse> pairings() {
        return List.of(
            new CardDtos.PairingResponse("m-1-1", 1, 1, "P001", "P002", "P001", 420, 300, "WIN", 120, true, false, true),
            new CardDtos.PairingResponse("m-1-2", 1, 2, "P002", "P003", null, 350, 350, "DRAW", 0, false, false, true),
            new CardDtos.PairingResponse("m-2-1", 2, 1, "P001", "P003", null, null, null, "PENALTY", 0, false, false, true),
            new CardDtos.PairingResponse("m-2-2", 2, 2, "P002", null, null, null, null, null, null, false, false, true),
            new CardDtos.PairingResponse("m-3-1", 3, 1, null, null, null, null, null, null, null, false, false, false));
    }

    static CardDtos.FinalRoundResponse finalRound() {
        return new CardDtos.FinalRoundResponse(List.of(
            new CardDtos.FinalSlotResponse(0, "P001", "P002",
                List.of(new CardDtos.FinalGameResponse(1, 500, 400, "P001", 100),
                    new CardDtos.FinalGameResponse(2, null, null, null, null)),
                "P001", 1, 0, 100),
            new CardDtos.FinalSlotResponse(1, "P003", "P002", List.of(), null, null, null, null)));
    }
}
