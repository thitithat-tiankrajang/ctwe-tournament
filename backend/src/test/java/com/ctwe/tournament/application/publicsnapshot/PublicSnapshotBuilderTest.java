package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Behaviour of Public Snapshot generation. Generation only — nothing here publishes or writes. */
class PublicSnapshotBuilderTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService cards = mock(TournamentCardService.class);
    private final PublicSnapshotBuilder builder = new PublicSnapshotBuilder(jdbc, cards);

    // ------------------------------------------------------------------ shape

    @Test
    @DisplayName("a normal multi-card tournament produces one card per row, newest first")
    void buildsEveryCardInOrder() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        PublicSnapshotPayload payload = builder.build(SnapshotFixtures.TOURNAMENT_ID).payload();

        assertThat(payload.id()).isEqualTo(SnapshotFixtures.TOURNAMENT_ID);
        assertThat(payload.name()).isEqualTo(SnapshotFixtures.TOURNAMENT_NAME);
        assertThat(payload.cards()).extracting(CardDtos.CardResponse::id)
            .containsExactly(SnapshotFixtures.CARD_FINISHED, SnapshotFixtures.CARD_RUNNING,
                SnapshotFixtures.CARD_DRAFT, SnapshotFixtures.CARD_CLOSED);
    }

    @Test
    @DisplayName("an empty tournament produces a valid, empty snapshot rather than an error")
    void buildsEmptyTournament() {
        UUID empty = UUID.randomUUID();
        SnapshotFixtures.stubEmpty(jdbc, cards, empty);

        PublicSnapshotArtifact artifact = builder.build(empty);

        assertThat(artifact.payload().cards()).isEmpty();
        assertThat(artifact.payload().cardCount()).isZero();
        assertThat(artifact.payload().publishedCardCount()).isZero();
        assertThat(artifact.checksum()).startsWith("sha256-");
        assertThat(artifact.payloadBytes()).isPositive();
    }

    @Test
    @DisplayName("counts are derived from the cards actually in the snapshot")
    void derivesCounts() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        PublicSnapshotPayload payload = builder.build(SnapshotFixtures.TOURNAMENT_ID).payload();

        // 4 cards; FINISHED and CLOSED are the two that count as published.
        assertThat(payload.cardCount()).isEqualTo(4);
        assertThat(payload.publishedCardCount()).isEqualTo(2);
    }

    // ------------------------------------------------------------------ projection semantics

    @Test
    @DisplayName("each card carries its own public_version, not the internal card version")
    void appliesPerCardPublicVersion() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        List<CardDtos.CardResponse> built = builder.build(SnapshotFixtures.TOURNAMENT_ID).payload().cards();

        assertThat(built).extracting(CardDtos.CardResponse::version)
            .containsExactly(412L, 87L, 1L, 999L);
        // every fixture's internal version is 7 — proof the public version replaced it
        assertThat(built).extracting(CardDtos.CardResponse::version).doesNotContain(7L);
    }

    @Test
    @DisplayName("existing projection branch ordering is preserved for every card")
    void preservesBranchOrdering() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        List<CardDtos.CardResponse> built = builder.build(SnapshotFixtures.TOURNAMENT_ID).payload().cards();

        // FINISHED status wins over its RESULT_COLLECTION runtime stage
        assertThat(built.get(0).runtimeStage()).isEqualTo(RuntimeStage.FINAL_PUBLISHED);
        // an unconfirmed snapshot collapses TABLE_PAIRING to RESULT_COLLECTION
        assertThat(built.get(1).runtimeStage()).isEqualTo(RuntimeStage.RESULT_COLLECTION);
        // registration is checked before the unconfirmed-snapshot rule
        assertThat(built.get(2).runtimeStage()).isEqualTo(RuntimeStage.PLAYER_REGISTRATION);
        // CLOSED status also forces FINAL_PUBLISHED
        assertThat(built.get(3).runtimeStage()).isEqualTo(RuntimeStage.FINAL_PUBLISHED);
    }

    @Test
    @DisplayName("the final round is exposed only where the projection allows it")
    void gatesFinalRound() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        List<CardDtos.CardResponse> built = builder.build(SnapshotFixtures.TOURNAMENT_ID).payload().cards();

        assertThat(built.get(0).finalRound()).isNotNull();  // FINISHED
        assertThat(built.get(1).finalRound()).isNull();     // still running
        assertThat(built.get(2).finalRound()).isNull();     // none configured
        assertThat(built.get(3).finalRound()).isNotNull();  // CLOSED
    }

    @Test
    @DisplayName("back-office data never reaches the snapshot")
    void stripsPrivateFields() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        PublicSnapshotArtifact artifact = builder.build(SnapshotFixtures.TOURNAMENT_ID);

        assertThat(artifact.payload().cards()).allSatisfy(card -> {
            assertThat(card.rules()).as("pairing configuration is back-office only").isEmpty();
            assertThat(card.tables()).as("seating is back-office only").isEmpty();
            assertThat(card.audit()).as("audit is ADMIN/DIRECTOR only").isEmpty();
        });
        // Belt and braces at the serialized level: no staff identity, no routing token.
        assertThat(artifact.payloadJson())
            .doesNotContain("submittedBy").doesNotContain("submittedAt")
            .doesNotContain("accessToken").doesNotContain("director01")
            .doesNotContain("PUBLISH_GAME_RESULTS");
    }

    // ------------------------------------------------------------------ determinism

    @Test
    @DisplayName("identical source data yields byte-identical payloads and checksums")
    void isDeterministic() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        PublicSnapshotArtifact first = builder.build(SnapshotFixtures.TOURNAMENT_ID);
        PublicSnapshotArtifact second = builder.build(SnapshotFixtures.TOURNAMENT_ID);

        assertThat(second.payloadJson()).isEqualTo(first.payloadJson());
        assertThat(second.checksum()).isEqualTo(first.checksum());
        assertThat(second.payloadBytes()).isEqualTo(first.payloadBytes());
    }

    @Test
    @DisplayName("a changed public version changes the checksum")
    void checksumTracksContent() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        String before = builder.build(SnapshotFixtures.TOURNAMENT_ID).checksum();

        List<SnapshotFixtures.Seed> bumped = SnapshotFixtures.seeds().stream()
            .map(seed -> seed.id().equals(SnapshotFixtures.CARD_RUNNING)
                ? new SnapshotFixtures.Seed(seed.id(), seed.publicVersion() + 1, seed.source())
                : seed)
            .toList();
        SnapshotFixtures.stub(jdbc, cards, SnapshotFixtures.TOURNAMENT_ID, SnapshotFixtures.TOURNAMENT_NAME, bumped);

        assertThat(builder.build(SnapshotFixtures.TOURNAMENT_ID).checksum()).isNotEqualTo(before);
    }

    // ------------------------------------------------------------------ safety

    @Test
    @DisplayName("generation reads only — no write ever reaches the database")
    void neverWrites() {
        SnapshotFixtures.stubDefault(jdbc, cards);

        builder.build(SnapshotFixtures.TOURNAMENT_ID);

        verify(jdbc, never()).update(anyString());
        verify(jdbc, never()).update(anyString(), any(Object[].class));
        verify(jdbc, never()).batchUpdate(anyString());
        verify(jdbc, never()).execute(anyString());
    }

    @Test
    @DisplayName("the build runs in one read-only REPEATABLE_READ transaction")
    void isReadOnlyRepeatableRead() throws Exception {
        Transactional transactional = PublicSnapshotBuilder.class
            .getMethod("build", UUID.class).getAnnotation(Transactional.class);

        assertThat(transactional).isNotNull();
        assertThat(transactional.readOnly())
            .as("a read-only transaction makes the connection itself reject writes")
            .isTrue();
        assertThat(transactional.isolation())
            .as("every card must see the same consistent database state")
            .isEqualTo(Isolation.REPEATABLE_READ);
    }

    @Test
    @DisplayName("an unknown tournament is a 404, not an empty snapshot")
    void rejectsUnknownTournament() {
        UUID missing = UUID.randomUUID();
        when(jdbc.queryForObject("SELECT name FROM tournaments WHERE id = ?", String.class, missing))
            .thenThrow(new EmptyResultDataAccessException(1));

        assertThatThrownBy(() -> builder.build(missing))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    @DisplayName("a card that cannot be loaded aborts the build instead of silently omitting it")
    void propagatesMissingCard() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        when(cards.get(SnapshotFixtures.CARD_RUNNING, false))
            .thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found"));

        assertThatThrownBy(() -> builder.build(SnapshotFixtures.TOURNAMENT_ID))
            .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    @DisplayName("a card whose public data is still registration-only is snapshotted as-is")
    void handlesRegistrationOnlyCard() {
        UUID tournamentId = UUID.randomUUID();
        UUID cardId = UUID.fromString("cccccccc-0000-4000-8000-000000000001");
        SnapshotFixtures.stub(jdbc, cards, tournamentId, "เพิ่งเปิดรับสมัคร", List.of(
            new SnapshotFixtures.Seed(cardId, 0L, new CardDtos.CardResponse(
                cardId, tournamentId, "การ์ดใหม่", "รุ่นเดียว", CardStatus.DRAFT,
                RuntimeStage.PLAYER_REGISTRATION, 1, 0L, List.of(),
                com.ctwe.tournament.domain.model.PairingRuleType.RANDOM,
                List.of(), List.of(), List.of(), List.of(), List.of(),
                "NONE", 0, null, false, java.time.Instant.parse("2026-08-01T03:00:00Z"), "P"))));

        PublicSnapshotPayload payload = builder.build(tournamentId).payload();

        assertThat(payload.cards()).hasSize(1);
        assertThat(payload.cards().get(0).players()).isEmpty();
        assertThat(payload.cards().get(0).runtimeStage()).isEqualTo(RuntimeStage.PLAYER_REGISTRATION);
        assertThat(payload.publishedCardCount()).isZero();
    }
}
