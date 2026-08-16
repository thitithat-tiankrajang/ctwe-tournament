package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.PublicCardReadCache;
import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.PublicTournamentController;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * PHASE C — the equivalence gate. A published snapshot is permanent, so before any publication
 * machinery exists we prove the artifact is the same thing viewers already receive.
 *
 * <pre>
 *   GET /api/public/tournaments/{token}/bundle          PublicSnapshotBuilder.build(id)
 *                       │                                            │
 *                       ├── canonical JSON ── remove accessToken ──┐ ├── canonical JSON
 *                       │                                          ▼ ▼
 *                       └──────────────── EXACT BYTE EQUALITY ───────┘
 * </pre>
 *
 * <p><b>How the live side is obtained.</b> By calling the real
 * {@link PublicTournamentController#bundle} on a real controller, wired to the real
 * {@link TenantService}, {@link PublicCardQueryService} and {@link PublicCardReadCache}. Nothing here
 * re-assembles a bundle, re-selects source rows, or re-projects a card: the only test-owned code
 * below the controller is {@link FakePublicDatabase}, which stands in for PostgreSQL and serves the
 * <em>same</em> rows to the snapshot builder.
 *
 * <p><b>The one intentional difference</b> is {@code accessToken}, removed from the live document
 * before the comparison and from nowhere else. Every other divergence — a new field, a reordered
 * collection, a different count, a stage computed differently — fails this test.
 *
 * <p><b>Relationship to the other snapshot tests.</b> {@code PublicSnapshotGoldenTest} pins the
 * artifact against a committed file (the deterministic-artifact contract);
 * {@code PublicSnapshotBundleEquivalenceTest} pins the payload's field set against the bundle record.
 * This test pins the payload against the live endpoint's actual output. All three are kept.
 *
 * <p><b>Known limitation.</b> The SQL text is not executed here, so the {@code ORDER BY} and
 * {@code COUNT} clauses are mirrored inside {@link FakePublicDatabase} rather than run.
 * {@code SnapshotLiveEquivalenceDatabaseTest} runs this same comparison against a real PostgreSQL to
 * close that gap.
 */
class SnapshotLiveEquivalenceTest {
    /** The only field the snapshot deliberately drops (architecture §3.6 / D5). */
    private static final String INTENTIONALLY_OMITTED = "accessToken";

    private static final ObjectMapper PARSER = JsonMapper.builder().addModule(new JavaTimeModule()).build();

    private static final UUID TOURNAMENT = UUID.fromString("aaaaaaaa-0000-4000-8000-00000000000c");
    private static final UUID OTHER_TOURNAMENT = UUID.fromString("aaaaaaaa-0000-4000-8000-00000000000d");
    private static final String TOKEN = "ctwe-2026-phase-c";
    private static final String NAME = "CTWE 2026 ชิงแชมป์ประเทศไทย";

    // ================================================================== the required scenarios

    @Test
    @DisplayName("empty tournament: the snapshot equals the bundle for a tournament with no cards")
    void emptyTournament() {
        assertEquivalent(database(List.of()));
    }

    @Test
    @DisplayName("one card")
    void singleCard() {
        assertEquivalent(database(List.of(finished(1))));
    }

    @Test
    @DisplayName("multiple cards, mixed stages, mixed public versions, final round gated both ways")
    void mixedTournament() {
        Equivalence result = assertEquivalent(database(List.of(
            finished(1), running(2), registration(3), closed(4))));

        // Newest first, so the order is closed(4), registration(3), running(2), finished(1).
        List<CardDtos.CardResponse> snapshot = result.snapshot();
        // CLOSED and FINISHED both force FINAL_PUBLISHED and expose the final round.
        assertThat(snapshot.get(0).runtimeStage()).isEqualTo(RuntimeStage.FINAL_PUBLISHED);
        assertThat(snapshot.get(0).finalRound()).isNotNull();
        assertThat(snapshot.get(3).runtimeStage()).isEqualTo(RuntimeStage.FINAL_PUBLISHED);
        assertThat(snapshot.get(3).finalRound()).isNotNull();
        // Registration has no final round configured; the running card's is still hidden.
        assertThat(snapshot.get(1).runtimeStage()).isEqualTo(RuntimeStage.PLAYER_REGISTRATION);
        assertThat(snapshot.get(1).finalRound()).isNull();
        assertThat(snapshot.get(2).runtimeStage()).isEqualTo(RuntimeStage.RESULT_COLLECTION);
        assertThat(snapshot.get(2).finalRound()).isNull();
        // Distinct public versions survive per card.
        assertThat(snapshot).extracting(CardDtos.CardResponse::version)
            .containsExactly(999L, 1L, 87L, 412L);
    }

    @Test
    @DisplayName("PLAYER_REGISTRATION takes precedence over the unconfirmed-snapshot rule, identically on both sides")
    void playerRegistrationPrecedence() {
        // A card that is BOTH in registration AND carries an unconfirmed snapshot. The projection
        // checks registration first, so the public stage must stay PLAYER_REGISTRATION rather than
        // collapsing to RESULT_COLLECTION. If the two paths disagreed about that ordering, the
        // byte comparison below would fail.
        FakePublicDatabase database = database(List.of(new FakePublicDatabase.Card(
            card(9), TOURNAMENT, 5L, at(9),
            SnapshotFixtures.card(card(9), TOURNAMENT, CardStatus.DRAFT, RuntimeStage.PLAYER_REGISTRATION,
                SnapshotFixtures.unconfirmedSnapshots(), null))));

        Equivalence result = assertEquivalent(database);

        assertThat(result.snapshot().get(0).runtimeStage()).isEqualTo(RuntimeStage.PLAYER_REGISTRATION);
    }

    @Test
    @DisplayName("an unconfirmed snapshot collapses TABLE_PAIRING to RESULT_COLLECTION on both sides")
    void unconfirmedSnapshots() {
        Equivalence result = assertEquivalent(database(List.of(running(2))));

        assertThat(result.snapshot().get(0).runtimeStage()).isEqualTo(RuntimeStage.RESULT_COLLECTION);
    }

    @Test
    @DisplayName("null and empty fields survive the comparison instead of vanishing from one side")
    void nullAndEmptyFields() {
        UUID id = card(7);
        FakePublicDatabase database = database(List.of(new FakePublicDatabase.Card(
            id, TOURNAMENT, 0L, at(7),
            new CardDtos.CardResponse(id, TOURNAMENT, "การ์ดใหม่", "รุ่นเดียว", CardStatus.DRAFT,
                RuntimeStage.PLAYER_REGISTRATION, 1, 0L, List.of(), PairingRuleType.RANDOM,
                List.of(), List.of(), List.of(), List.of(), List.of(),
                "NONE", 0, null, false, Instant.parse("2026-08-01T03:00:00Z"), "P"))));

        Equivalence result = assertEquivalent(database);

        // The canonical serializer writes nulls, so an absent finalRound is a visible `null` on both
        // sides rather than a key that silently disappears from one of them.
        assertThat(result.snapshotJson()).contains("\"finalRound\" : null");
        assertThat(result.snapshot().get(0).players()).isEmpty();
    }

    @Test
    @DisplayName("card ordering is the same list in the same order — newest first")
    void deterministicOrdering() {
        Equivalence result = assertEquivalent(database(List.of(
            finished(1), running(2), registration(3), closed(4))));

        // at(n) increases with n, so newest-first is 4, 3, 2, 1.
        assertThat(result.snapshot()).extracting(CardDtos.CardResponse::id)
            .containsExactly(card(4), card(3), card(2), card(1))
            .isEqualTo(result.live().cards().stream().map(CardDtos.CardResponse::id).toList());
    }

    @Test
    @DisplayName("cards belonging to another tournament appear in neither representation")
    void scopesToOneTournament() {
        FakePublicDatabase database = FakePublicDatabase.of(
            List.of(FakePublicDatabase.Tournament.open(TOURNAMENT, NAME, TOKEN),
                FakePublicDatabase.Tournament.open(OTHER_TOURNAMENT, "อีกรายการ", "other-tournament")),
            List.of(finished(1), running(2),
                // Interleaved by created_at so a leak would land in the middle of the list, not at
                // the end where a length check alone might catch it.
                new FakePublicDatabase.Card(card(50), OTHER_TOURNAMENT, 3L, at(1).plusSeconds(30),
                    SnapshotFixtures.card(card(50), OTHER_TOURNAMENT, CardStatus.FINISHED,
                        RuntimeStage.FINAL_PUBLISHED, SnapshotFixtures.confirmedSnapshots(),
                        SnapshotFixtures.finalRound()))));

        Equivalence result = assertEquivalent(database);

        assertThat(result.snapshot()).extracting(CardDtos.CardResponse::id)
            .containsExactly(card(2), card(1));
        assertThat(result.live().cardCount()).isEqualTo(2);
    }

    @Test
    @DisplayName("cards sharing a created_at still produce a stable snapshot, ordered by id")
    void tieBreaking() {
        // The live catalog orders by created_at DESC only; the snapshot appends `, id`. PostgreSQL
        // leaves the live order undefined for an exact tie, so byte equality is asserted for the
        // distinct-timestamp cases above (every real one) and determinism is asserted here.
        Instant shared = at(1);
        FakePublicDatabase database = FakePublicDatabase.of(
            List.of(FakePublicDatabase.Tournament.open(TOURNAMENT, NAME, TOKEN)),
            List.of(
                new FakePublicDatabase.Card(card(2), TOURNAMENT, 5L, shared,
                    SnapshotFixtures.card(card(2), TOURNAMENT, CardStatus.FINISHED,
                        RuntimeStage.FINAL_PUBLISHED, SnapshotFixtures.confirmedSnapshots(), null)),
                new FakePublicDatabase.Card(card(1), TOURNAMENT, 6L, shared,
                    SnapshotFixtures.card(card(1), TOURNAMENT, CardStatus.FINISHED,
                        RuntimeStage.FINAL_PUBLISHED, SnapshotFixtures.confirmedSnapshots(), null))));

        PublicSnapshotBuilder builder = new PublicSnapshotBuilder(database.jdbc(), database.cardService());
        PublicSnapshotArtifact first = builder.build(TOURNAMENT);
        PublicSnapshotArtifact second = builder.build(TOURNAMENT);

        assertThat(first.payloadJson()).isEqualTo(second.payloadJson());
        assertThat(first.payload().cards()).extracting(CardDtos.CardResponse::id)
            .as("the id tie-break makes a tied pair regenerate in the same order forever")
            .containsExactly(card(1), card(2));
        // The same cards are in the bundle, tie order aside.
        assertThat(bundle(database).cards()).extracting(CardDtos.CardResponse::id)
            .containsExactlyInAnyOrder(card(1), card(2));
    }

    // ================================================================== required cross-checks

    @Test
    @DisplayName("the checksum is SHA-256 over exactly the canonical payload bytes that were compared")
    void checksumCoversTheComparedBytes() {
        Equivalence result = assertEquivalent(database(List.of(finished(1), running(2), closed(4))));

        PublicSnapshotArtifact artifact = result.artifact();
        assertThat(artifact.checksum()).isEqualTo(SnapshotJson.checksum(artifact.payloadJson()));
        assertThat(artifact.payloadBytes()).isEqualTo(SnapshotJson.byteLength(artifact.payloadJson()));
        // The envelope is deliberately outside the checksum: wrapping must not change it.
        assertThat(PublicSnapshotEnvelope.of(artifact, Instant.parse("2026-08-14T00:00:00Z")).snapshot().checksum())
            .isEqualTo(artifact.checksum());
    }

    @Test
    @DisplayName("private data is absent from the payload that just matched the public bundle")
    void privateFieldsAbsent() {
        Equivalence result = assertEquivalent(database(List.of(finished(1), running(2), closed(4))));

        assertThat(result.snapshot()).allSatisfy(card -> {
            assertThat(card.rules()).isEmpty();
            assertThat(card.tables()).isEmpty();
            assertThat(card.audit()).isEmpty();
        });
        assertThat(result.snapshotJson())
            .doesNotContain("submittedBy").doesNotContain("submittedAt")
            .doesNotContain("accessToken").doesNotContain(TOKEN)
            .doesNotContain("director01").doesNotContain("PUBLISH_GAME_RESULTS");
    }

    @Test
    @DisplayName("generating a snapshot writes nothing to the database")
    void generationNeverWrites() {
        FakePublicDatabase database = database(List.of(finished(1), running(2), registration(3), closed(4)));

        new PublicSnapshotBuilder(database.jdbc(), database.cardService()).build(TOURNAMENT);

        database.assertNoWrites();
    }

    @Test
    @DisplayName("the comparison is sensitive: a single altered value breaks byte equality")
    void theGuardActuallyGuards() {
        Equivalence result = assertEquivalent(database(List.of(finished(1), running(2))));

        // Prove the assertion above is not vacuous. Bump one card's public version — the smallest
        // change a real drift could produce — and the canonical bytes must stop matching.
        ObjectNode drifted = (ObjectNode) parse(result.snapshotJson());
        ((ObjectNode) drifted.get("cards").get(0)).put("version", 413L);

        assertThat(SnapshotJson.canonical(drifted)).isNotEqualTo(result.snapshotJson());
        assertThat(SnapshotJson.checksum(SnapshotJson.canonical(drifted)))
            .isNotEqualTo(result.artifact().checksum());
    }

    // ================================================================== the comparison itself

    /** What one equivalence run produced, for scenario-specific follow-up assertions. */
    private record Equivalence(TenantDtos.PublicTournamentBundle live, PublicSnapshotArtifact artifact,
                               String snapshotJson) {
        List<CardDtos.CardResponse> snapshot() {
            return artifact.payload().cards();
        }
    }

    /**
     * The Phase C assertion, in the order the brief specifies:
     * <ol>
     *   <li>obtain the existing {@code /bundle} representation from the real controller;</li>
     *   <li>generate the snapshot through the real {@link PublicSnapshotBuilder};</li>
     *   <li>take the snapshot's payload;</li>
     *   <li>remove {@code accessToken} — and only that — from the bundle;</li>
     *   <li>canonically serialize both;</li>
     *   <li>assert exact byte equality.</li>
     * </ol>
     */
    private Equivalence assertEquivalent(FakePublicDatabase database) {
        TenantDtos.PublicTournamentBundle live = bundle(database);
        PublicSnapshotArtifact artifact =
            new PublicSnapshotBuilder(database.jdbc(), database.cardService()).build(TOURNAMENT);

        ObjectNode liveDocument = (ObjectNode) parse(SnapshotJson.canonical(live));
        assertThat(liveDocument.remove(INTENTIONALLY_OMITTED))
            .as("the live bundle must actually carry the field the snapshot drops")
            .isNotNull();

        // Both sides go through the identical parse-and-rewrite, so the comparison cannot be
        // satisfied — or broken — by a pretty-printer difference between a record and a tree.
        String expected = SnapshotJson.canonical(liveDocument);
        String actual = SnapshotJson.canonical(parse(artifact.payloadJson()));

        assertThat(actual)
            .as("the snapshot payload must be the live bundle minus accessToken, byte for byte")
            .isEqualTo(expected);
        assertThat(artifact.payloadJson())
            .as("and the bytes just compared must be the bytes the checksum is taken over")
            .isEqualTo(actual);

        // The named invariants, asserted explicitly so a failure says which one broke.
        assertThat(artifact.payload().id()).isEqualTo(live.id());
        assertThat(artifact.payload().name()).isEqualTo(live.name());
        assertThat(artifact.payload().cardCount()).isEqualTo(live.cardCount());
        assertThat(artifact.payload().publishedCardCount()).isEqualTo(live.publishedCardCount());
        assertThat(artifact.payload().cards()).extracting(CardDtos.CardResponse::id)
            .isEqualTo(live.cards().stream().map(CardDtos.CardResponse::id).toList());
        assertThat(artifact.payload().cards()).extracting(CardDtos.CardResponse::version)
            .isEqualTo(live.cards().stream().map(CardDtos.CardResponse::version).toList());
        database.assertNoWrites();

        return new Equivalence(live, artifact, artifact.payloadJson());
    }

    /** The live representation, from the real controller and the real services beneath it. */
    private TenantDtos.PublicTournamentBundle bundle(FakePublicDatabase database) {
        PublicCardReadCache readCache = new PublicCardReadCache(database.jdbc(), database.cardService());
        PublicTournamentController controller = new PublicTournamentController(
            new TenantService(database.jdbc(), mock(PasswordEncoder.class), new ObjectMapper()),
            new PublicCardQueryService(readCache),
            mock(CardEventPublisher.class));

        var response = controller.bundle(TOKEN, new MockHttpServletRequest());
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        return response.getBody();
    }

    // ================================================================== fixtures

    private FakePublicDatabase database(List<FakePublicDatabase.Card> cards) {
        return FakePublicDatabase.of(
            List.of(FakePublicDatabase.Tournament.open(TOURNAMENT, NAME, TOKEN)), cards);
    }

    private static UUID card(int n) {
        return UUID.fromString("bbbbbbbb-0000-4000-8000-%012d".formatted(n));
    }

    /** Distinct, increasing timestamps: card n is newer than card n-1. */
    private static Instant at(int n) {
        return Instant.parse("2026-08-01T03:00:00Z").plusSeconds(n * 3600L);
    }

    private static FakePublicDatabase.Card finished(int n) {
        return new FakePublicDatabase.Card(card(n), TOURNAMENT, 412L, at(n),
            SnapshotFixtures.card(card(n), TOURNAMENT, CardStatus.FINISHED, RuntimeStage.RESULT_COLLECTION,
                SnapshotFixtures.confirmedSnapshots(), SnapshotFixtures.finalRound()));
    }

    private static FakePublicDatabase.Card running(int n) {
        return new FakePublicDatabase.Card(card(n), TOURNAMENT, 87L, at(n),
            SnapshotFixtures.card(card(n), TOURNAMENT, CardStatus.RUNNING, RuntimeStage.TABLE_PAIRING,
                SnapshotFixtures.unconfirmedSnapshots(), SnapshotFixtures.finalRound()));
    }

    private static FakePublicDatabase.Card registration(int n) {
        return new FakePublicDatabase.Card(card(n), TOURNAMENT, 1L, at(n),
            SnapshotFixtures.card(card(n), TOURNAMENT, CardStatus.DRAFT, RuntimeStage.PLAYER_REGISTRATION,
                List.of(), null));
    }

    private static FakePublicDatabase.Card closed(int n) {
        return new FakePublicDatabase.Card(card(n), TOURNAMENT, 999L, at(n),
            SnapshotFixtures.card(card(n), TOURNAMENT, CardStatus.CLOSED, RuntimeStage.FINAL_PUBLISHED,
                SnapshotFixtures.confirmedSnapshots(), SnapshotFixtures.finalRound()));
    }

    private static JsonNode parse(String json) {
        try {
            return PARSER.readTree(json);
        } catch (Exception error) {
            throw new IllegalStateException("Document is not valid JSON", error);
        }
    }
}
