package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * A0 — characterization ("golden") test for the anonymous public card projection.
 *
 * <p>This pins the EXACT shape the public read model produces for every branch of the projection, so
 * that later refactoring (A1: extracting {@code PublicCardProjection}) and any future change to
 * {@code CardDtos.CardResponse} must be a deliberate, visible decision rather than an accident.
 *
 * <p>Scope note: this characterizes the projected <em>object</em>, not the HTTP body. It serializes
 * with its own mapper that keeps nulls (Spring's global {@code non_null} inclusion would hide a field
 * flipping to null) and sorts keys (so re-ordering record components is not a spurious failure, while
 * added / removed / changed values still are).
 *
 * <p>The cache annotations on {@link PublicCardReadCache#card} are inert here because the instance is
 * constructed directly rather than through a Spring proxy — deliberately, so this measures the
 * projection and nothing else.
 *
 * <p>On mismatch the actual document is written to {@code target/public-card-projection-actual.json}
 * for diffing against {@code src/test/resources/golden/public-card-projection.json}.
 */
class PublicCardProjectionGoldenTest {
    private static final Path GOLDEN = Path.of("src/test/resources/golden/public-card-projection.json");
    private static final Path ACTUAL = Path.of("target/public-card-projection-actual.json");

    private static final UUID CARD_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID TOURNAMENT_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final long PUBLIC_VERSION = 412L;

    private static final ObjectMapper JSON = JsonMapper.builder()
        .addModule(new JavaTimeModule())
        .enable(SerializationFeature.INDENT_OUTPUT)
        .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build();

    @Test
    @DisplayName("the public projection matches the committed golden document for every branch")
    void matchesGolden() {
        String actual = render(scenarios());
        writeActual(actual);

        assertThat(Files.exists(GOLDEN))
            .as("Golden file missing. Review %s and copy it to %s once it is correct.", ACTUAL, GOLDEN)
            .isTrue();

        assertThat(actual)
            .as("The public card projection changed. If this is intentional, review the diff against %s "
                + "line by line — this output is what every anonymous viewer receives.", ACTUAL)
            .isEqualTo(read(GOLDEN));
    }

    @Test
    @DisplayName("calling the extracted projection directly equals going through the read model")
    void directProjectionEqualsReadModelPath() {
        for (Map.Entry<String, CardDtos.CardResponse> scenario : sources().entrySet()) {
            CardDtos.CardResponse viaReadModel = project(scenario.getValue());
            CardDtos.CardResponse viaProjection = PublicCardProjection.of(scenario.getValue(), PUBLIC_VERSION);
            assertThat(render(Map.of("x", viaProjection)))
                .as("PublicCardReadCache.card() must be a pure delegation to PublicCardProjection.of() "
                    + "— scenario '%s' diverged", scenario.getKey())
                .isEqualTo(render(Map.of("x", viaReadModel)));
        }
    }

    /** Every branch of the projection, each rendered through the real read-model entry point. */
    private Map<String, CardDtos.CardResponse> scenarios() {
        Map<String, CardDtos.CardResponse> rendered = new LinkedHashMap<>();
        sources().forEach((name, source) -> rendered.put(name, project(source)));
        return rendered;
    }

    /** The raw staff-side fixtures, one per branch of the projection. */
    private Map<String, CardDtos.CardResponse> sources() {
        Map<String, CardDtos.CardResponse> raw = new LinkedHashMap<>();
        raw.put("01-running-table-pairing-all-snapshots-confirmed",
            source(CardStatus.RUNNING, RuntimeStage.TABLE_PAIRING, confirmedSnapshots(), finalRound()));
        raw.put("02-running-unconfirmed-snapshot-becomes-result-collection",
            source(CardStatus.RUNNING, RuntimeStage.TABLE_PAIRING, snapshotsWithNullConfirmedAt(), finalRound()));
        raw.put("03-running-blank-confirmed-at-also-becomes-result-collection",
            source(CardStatus.RUNNING, RuntimeStage.TABLE_PAIRING, snapshotsWithBlankConfirmedAt(), finalRound()));
        raw.put("04-draft-player-registration",
            source(CardStatus.DRAFT, RuntimeStage.PLAYER_REGISTRATION, confirmedSnapshots(), finalRound()));
        raw.put("05-registration-wins-over-unconfirmed-snapshots",
            source(CardStatus.DRAFT, RuntimeStage.PLAYER_REGISTRATION, snapshotsWithNullConfirmedAt(), finalRound()));
        raw.put("06-final-collection-exposes-final-round",
            source(CardStatus.RUNNING, RuntimeStage.FINAL_COLLECTION, confirmedSnapshots(), finalRound()));
        raw.put("07-final-published-stage",
            source(CardStatus.RUNNING, RuntimeStage.FINAL_PUBLISHED, confirmedSnapshots(), finalRound()));
        raw.put("08-finished-status-forces-final-published",
            source(CardStatus.FINISHED, RuntimeStage.RESULT_COLLECTION, confirmedSnapshots(), finalRound()));
        raw.put("09-closed-status-forces-final-published",
            source(CardStatus.CLOSED, RuntimeStage.RESULT_REVIEW, confirmedSnapshots(), finalRound()));
        raw.put("10-no-final-round-configured",
            source(CardStatus.RUNNING, RuntimeStage.TABLE_PAIRING, confirmedSnapshots(), null));
        raw.put("11-pairing-preview-stage",
            source(CardStatus.RUNNING, RuntimeStage.PAIRING_PREVIEW, confirmedSnapshots(), finalRound()));
        raw.put("12-final-seeding-stage",
            source(CardStatus.RUNNING, RuntimeStage.FINAL_SEEDING, confirmedSnapshots(), finalRound()));
        return raw;
    }

    /** Runs one fixture through the production read model with the database stubbed out. */
    private CardDtos.CardResponse project(CardDtos.CardResponse source) {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TournamentCardService cards = mock(TournamentCardService.class);
        when(jdbc.queryForList("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, CARD_ID))
            .thenReturn(List.of(PUBLIC_VERSION));
        when(cards.get(CARD_ID, false)).thenReturn(source);
        return new PublicCardReadCache(jdbc, cards).card(CARD_ID);
    }

    // ------------------------------------------------------------------ fixtures

    /**
     * A deliberately rich card: byes, a draw, a penalty, a Gibsonized player, a terminated player,
     * an unpublished pairing row, and back-office-only collections that must be stripped.
     */
    private CardDtos.CardResponse source(CardStatus status, RuntimeStage stage,
                                         List<CardDtos.SnapshotResponse> snapshots,
                                         CardDtos.FinalRoundResponse finalRound) {
        return new CardDtos.CardResponse(
            CARD_ID, TOURNAMENT_ID, "CTWE 2026", "ม.ต้น ชาย", status, stage, 3, 7L,
            List.of(
                new CardDtos.GameResponse("g1", 1, "เกม 1", "COMPLETED", 500),
                new CardDtos.GameResponse("g2", 2, "เกม 2", "COMPLETED", 500),
                new CardDtos.GameResponse("g3", 3, "เกม 3", "OPEN", 1000)),
            PairingRuleType.RANDOM,
            // Back-office only — the projection must blank these out.
            List.of(new CardDtos.RuleResponse(1, 2, PairingRuleType.SWISS),
                new CardDtos.RuleResponse(2, 3, PairingRuleType.PAIR_RESULT)),
            List.of(
                new CardDtos.PlayerResponse("P001", "สมชาย", "ใจดี", "โรงเรียนสวนกุหลาบ", "ม.ต้น ชาย", 2, 0, 1, 4, 120, false),
                new CardDtos.PlayerResponse("P002", "สมหญิง", "รักเรียน", "โรงเรียนเตรียมอุดม", "ม.ต้น ชาย", 1, 1, 1, 3, -15, false),
                new CardDtos.PlayerResponse("P003", "อนันต์", "มั่นคง", "โรงเรียนสาธิต", "ม.ต้น ชาย", 0, 0, 3, 0, -200, true)),
            // Back-office only — seating must not leak.
            List.of(new CardDtos.TableResponse("t1", 1, List.of("P001", "P002"))),
            snapshots,
            // Back-office only — audit must not leak.
            List.of(new CardDtos.AuditResponse("a1", "2026-08-01T10:00:00Z", "director01", "PUBLISH_GAME_RESULTS", null, "game [1]")),
            finalRound == null ? "NONE" : "CHAMPION_AND_THIRD", finalRound == null ? 0 : 3,
            finalRound, true, Instant.parse("2026-08-01T03:00:00Z"), "A");
    }

    private List<CardDtos.SnapshotResponse> confirmedSnapshots() {
        return List.of(new CardDtos.SnapshotResponse("s1", List.of(1, 2), pairings(), "2026-08-01T11:00:00Z"));
    }

    private List<CardDtos.SnapshotResponse> snapshotsWithNullConfirmedAt() {
        return List.of(
            new CardDtos.SnapshotResponse("s1", List.of(1, 2), pairings(), "2026-08-01T11:00:00Z"),
            new CardDtos.SnapshotResponse("s2", List.of(3), pairings(), null));
    }

    private List<CardDtos.SnapshotResponse> snapshotsWithBlankConfirmedAt() {
        return List.of(new CardDtos.SnapshotResponse("s2", List.of(3), pairings(), "   "));
    }

    private List<CardDtos.PairingResponse> pairings() {
        return List.of(
            // decided win, with a Gibsonized player on seat one
            new CardDtos.PairingResponse("m-1-1", 1, 1, "P001", "P002", "P001", 420, 300, "WIN", 120, true, false, true),
            // draw
            new CardDtos.PairingResponse("m-1-2", 1, 2, "P002", "P003", null, 350, 350, "DRAW", 0, false, false, true),
            // penalty ("ลงดาบ") — both sides lose
            new CardDtos.PairingResponse("m-2-1", 2, 1, "P001", "P003", null, null, null, "PENALTY", 0, false, false, true),
            // bye — no opponent
            new CardDtos.PairingResponse("m-2-2", 2, 2, "P002", null, null, null, null, null, null, false, false, true),
            // pair-result destination slot still waiting for a winner, not yet published
            new CardDtos.PairingResponse("m-3-1", 3, 1, null, null, null, null, null, null, null, false, false, false));
    }

    private CardDtos.FinalRoundResponse finalRound() {
        return new CardDtos.FinalRoundResponse(List.of(
            new CardDtos.FinalSlotResponse(0, "P001", "P002",
                List.of(new CardDtos.FinalGameResponse(1, 500, 400, "P001", 100),
                    new CardDtos.FinalGameResponse(2, null, null, null, null)),
                "P001", 1, 0, 100),
            new CardDtos.FinalSlotResponse(1, "P003", "P002", List.of(), null, null, null, null)));
    }

    // ------------------------------------------------------------------ io

    private String render(Map<String, CardDtos.CardResponse> scenarios) {
        try {
            return JSON.writeValueAsString(scenarios) + "\n";
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    private static void writeActual(String content) {
        try {
            Files.createDirectories(ACTUAL.getParent());
            Files.writeString(ACTUAL, content, StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    private static String read(Path path) {
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}
