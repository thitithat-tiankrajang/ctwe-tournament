package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.PublicTournamentController;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.cache.transaction.TransactionAwareCacheDecorator;
import org.springframework.cache.transaction.TransactionAwareCacheManagerProxy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PHASE C against a real PostgreSQL — the same equivalence assertion as
 * {@link SnapshotLiveEquivalenceTest}, with the SQL actually executed.
 *
 * <p>{@code SnapshotLiveEquivalenceTest} stands PostgreSQL in with a double, so it cannot see a
 * change to the {@code ORDER BY} or {@code COUNT} clauses that the two read paths depend on. This
 * test closes that gap: it seeds a realistic tournament through the real {@link TournamentCardService}
 * — registration, pairing, published results, a finished card, an in-flight card — then compares the
 * real {@code GET /api/public/tournaments/{token}/bundle} against the real {@link PublicSnapshotBuilder}
 * with the real queries running against real rows.
 *
 * <p>Same harness as {@code RestoreAndPairResultIntegrationTest}: localhost:5432, every test inside a
 * transaction that is rolled back, and only enabled when the database password is in the environment.
 * CI runs without one, so this test <b>skips</b> there; {@link SnapshotLiveEquivalenceTest} is the
 * always-on gate and this one is the pre-publication check a developer (and Phase I §I1, against a
 * production clone) runs before anything is ever published.
 *
 * <p>The read path is Caffeine-backed, so the caches are cleared around every test: entries populated
 * from this test's uncommitted rows must not outlive the rollback.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class SnapshotLiveEquivalenceDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final ObjectMapper PARSER = JsonMapper.builder().addModule(new JavaTimeModule()).build();
    private static final String INTENTIONALLY_OMITTED = "accessToken";
    /** Cards are stamped one minute apart from here, so "newest first" is well defined. */
    private static final Instant CREATED_BASE = Instant.parse("2026-08-01T03:00:00Z");

    @Autowired TournamentCardService service;
    @Autowired PublicSnapshotBuilder builder;
    @Autowired PublicTournamentController publicTournaments;
    @Autowired JdbcTemplate jdbc;
    @Autowired CacheManager caches;

    private UUID tournamentId;
    private String accessToken;
    /** Bumped per card so each gets a distinct created_at — see {@link #card}. */
    private int created;

    @BeforeEach
    void createTournament() {
        clearPublicCaches();
        created = 0;
        tournamentId = UUID.randomUUID();
        accessToken = "phase-c-" + tournamentId.toString().substring(0, 8);
        // Inserted directly rather than through TenantService: created_by is a foreign key into
        // staff_accounts, and this fixture must not depend on which accounts a developer's database
        // happens to hold. The row is rolled back with everything else.
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, "CTWE Phase C ทดสอบ", accessToken);
    }

    @AfterEach
    void clearCachesAfterRollback() {
        clearPublicCaches();
    }

    // ================================================================== scenarios

    @Test
    @DisplayName("empty tournament")
    void emptyTournament() {
        assertEquivalent().satisfies(result -> assertThat(result.snapshot()).isEmpty());
    }

    @Test
    @DisplayName("one finished card")
    void oneFinishedCard() {
        UUID card = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(card, 6);
        service.simulate(card, "ittest");

        Result result = assertEquivalent();

        assertThat(result.snapshot()).hasSize(1);
        assertThat(result.snapshot().get(0).status().name()).isEqualTo("FINISHED");
        assertThat(result.snapshot().get(0).runtimeStage()).isEqualTo(RuntimeStage.FINAL_PUBLISHED);
        assertThat(result.live().publishedCardCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("multiple cards spanning registration, an unconfirmed pairing, and a finished card")
    void mixedStages() {
        // Newest last: created in this order, the public catalog returns them reversed.
        UUID finished = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(finished, 6);
        service.simulate(finished, "ittest");

        UUID inFlight = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(inFlight, 6);
        service.finishRegistration(inFlight, "ittest");
        service.generatePairingPreview(inFlight, "ittest");
        service.confirmPairingPreview(inFlight, "ittest");   // published pairing, results not yet in

        UUID registering = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(registering, 4);                          // still PLAYER_REGISTRATION

        UUID untouched = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));

        Result result = assertEquivalent();

        assertThat(result.snapshot()).extracting(CardDtos.CardResponse::id)
            .as("newest first, exactly as the live catalog orders them")
            .containsExactly(untouched, registering, inFlight, finished);
        // PLAYER_REGISTRATION precedence: a card with players but no finished registration stays in
        // registration even though the projection's later branches would say otherwise.
        assertThat(byId(result, registering).runtimeStage()).isEqualTo(RuntimeStage.PLAYER_REGISTRATION);
        // The roster of a card still in registration is withheld from anonymous readers by the
        // source-data selection itself (TournamentCardService.get with staffView = false). Four
        // players exist in the database; neither representation may show them.
        assertThat(byId(result, registering).players())
            .as("an unfinished registration roster is not public on either side")
            .isEmpty();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM players WHERE card_id = ?", Integer.class, registering))
            .isEqualTo(4);
        // An unconfirmed snapshot collapses the public stage to RESULT_COLLECTION.
        assertThat(byId(result, inFlight).runtimeStage()).isEqualTo(RuntimeStage.RESULT_COLLECTION);
        // A card with nothing on it yet: empty collections and a null final round, on both sides.
        assertThat(byId(result, untouched).players()).isEmpty();
        assertThat(byId(result, untouched).finalRound()).isNull();
        // Counts and versions come from different queries on the two sides; they must still agree.
        assertThat(result.artifact().payload().cardCount()).isEqualTo(4);
        assertThat(result.artifact().payload().publishedCardCount()).isEqualTo(1);
        // The two sides read public_version through different queries; assertEquivalent already
        // compared them element by element, so it is enough here that the busiest card has moved
        // past the untouched one.
        assertThat(byId(result, finished).version())
            .isGreaterThan(byId(result, untouched).version());
    }

    @Test
    @DisplayName("a configured-but-not-yet-visible final round is hidden from both representations")
    void finalRoundHiddenUntilVisible() {
        UUID stillRegistering = finalRoundCard();
        addPlayers(stillRegistering, 6);

        Result result = assertEquivalent();

        assertThat(byId(result, stillRegistering).finalType()).isEqualTo("CHAMPION_AND_THIRD");
        assertThat(byId(result, stillRegistering).runtimeStage()).isEqualTo(RuntimeStage.PLAYER_REGISTRATION);
        assertThat(byId(result, stillRegistering).finalRound())
            .as("the final pairing exists in configuration but must not be public yet")
            .isNull();
    }

    @Test
    @DisplayName("a final round in collection is exposed, with the same seeds and scores on both sides")
    void finalRoundExposedDuringCollection() {
        UUID card = finalRoundCard();
        addPlayers(card, 6);
        playAllGames(card);
        service.startFinalRound(card, "ittest");                  // FINAL_SEEDING -> FINAL_COLLECTION
        service.submitFinalResult(card, 0, 1, 500, 400, "ittest");

        Result result = assertEquivalent();

        CardDtos.CardResponse snapshot = byId(result, card);
        assertThat(snapshot.runtimeStage()).isEqualTo(RuntimeStage.FINAL_COLLECTION);
        assertThat(snapshot.finalRound()).isNotNull();
        assertThat(snapshot.finalRound().slots()).hasSize(2);     // CHAMPION_AND_THIRD
        assertThat(snapshot.finalRound().slots().get(0).games().get(0).scoreOne()).isEqualTo(500);
        // Still in collection, so no winner yet — a null that must be present, not omitted.
        assertThat(snapshot.finalRound().slots().get(0).winnerId()).isNull();
        assertThat(result.artifact().payloadJson()).contains("\"winnerId\" : null");
    }

    @Test
    @DisplayName("a published final round survives to the snapshot exactly as the bundle serves it")
    void finalRoundPublished() {
        UUID card = finalRoundCard();
        addPlayers(card, 6);
        playAllGames(card);
        service.startFinalRound(card, "ittest");
        for (CardDtos.FinalSlotResponse slot : service.get(card, true).finalRound().slots()) {
            service.submitFinalResult(card, slot.slot(), 1, 500, 400, "ittest");
            service.setFinalWinner(card, slot.slot(), slot.playerOneId(), 1, 0, 100, "ittest");
        }
        service.publishFinalRound(card, "ittest");

        Result result = assertEquivalent();

        CardDtos.CardResponse snapshot = byId(result, card);
        assertThat(snapshot.status().name()).isEqualTo("FINISHED");
        assertThat(snapshot.runtimeStage()).isEqualTo(RuntimeStage.FINAL_PUBLISHED);
        assertThat(snapshot.finalRound().slots()).allSatisfy(slot ->
            assertThat(slot.winnerId()).isNotNull());
        assertThat(result.live().publishedCardCount()).isEqualTo(1);
    }

    // ================================================================== safety

    @Test
    @DisplayName("generating a snapshot leaves every table byte-identical")
    void generationWritesNothing() {
        UUID card = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(card, 6);
        service.simulate(card, "ittest");

        Map<String, String> before = databaseDigest();
        builder.build(tournamentId);
        builder.build(tournamentId);
        Map<String, String> after = databaseDigest();

        assertThat(after)
            .as("PostgreSQL is the source of truth; snapshot generation is a read")
            .isEqualTo(before);
    }

    @Test
    @DisplayName("regenerating from unchanged rows reproduces the same bytes and checksum")
    void regenerationIsDeterministic() {
        UUID card = card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS));
        addPlayers(card, 6);
        service.simulate(card, "ittest");

        PublicSnapshotArtifact first = builder.build(tournamentId);
        PublicSnapshotArtifact second = builder.build(tournamentId);

        assertThat(second.payloadJson()).isEqualTo(first.payloadJson());
        assertThat(second.checksum()).isEqualTo(first.checksum());
    }

    // ================================================================== the comparison

    private record Result(TenantDtos.PublicTournamentBundle live, PublicSnapshotArtifact artifact) {
        List<CardDtos.CardResponse> snapshot() {
            return artifact.payload().cards();
        }

        Result satisfies(java.util.function.Consumer<Result> check) {
            check.accept(this);
            return this;
        }
    }

    /** Identical to {@link SnapshotLiveEquivalenceTest}'s assertion, over real rows. */
    private Result assertEquivalent() {
        clearPublicCaches();   // the seeding above changed rows the read model may already hold

        TenantDtos.PublicTournamentBundle live =
            publicTournaments.bundle(accessToken, new MockHttpServletRequest()).getBody();
        PublicSnapshotArtifact artifact = builder.build(tournamentId);

        ObjectNode liveDocument = (ObjectNode) parse(SnapshotJson.canonical(live));
        assertThat(liveDocument.remove(INTENTIONALLY_OMITTED)).isNotNull();

        String expected = SnapshotJson.canonical(liveDocument);
        String actual = SnapshotJson.canonical(parse(artifact.payloadJson()));

        assertThat(actual)
            .as("the snapshot payload must be the live bundle minus accessToken, byte for byte")
            .isEqualTo(expected);
        assertThat(artifact.payloadJson()).isEqualTo(actual);

        assertThat(artifact.payload().id()).isEqualTo(live.id());
        assertThat(artifact.payload().name()).isEqualTo(live.name());
        assertThat(artifact.payload().cardCount()).isEqualTo(live.cardCount());
        assertThat(artifact.payload().publishedCardCount()).isEqualTo(live.publishedCardCount());
        assertThat(artifact.payload().cards()).extracting(CardDtos.CardResponse::id)
            .isEqualTo(live.cards().stream().map(CardDtos.CardResponse::id).toList());
        assertThat(artifact.checksum()).isEqualTo(SnapshotJson.checksum(artifact.payloadJson()));
        assertThat(artifact.payload().cards()).allSatisfy(card -> {
            assertThat(card.rules()).isEmpty();
            assertThat(card.tables()).isEmpty();
            assertThat(card.audit()).isEmpty();
        });
        assertThat(artifact.payloadJson())
            .doesNotContain("accessToken").doesNotContain(accessToken)
            .doesNotContain("submittedBy").doesNotContain("submittedAt");

        return new Result(live, artifact);
    }

    /**
     * A content fingerprint of every table in the schema — row-level {@code md5} digests aggregated
     * in a deterministic order — so an insert, update or delete anywhere shows up as a difference.
     */
    private Map<String, String> databaseDigest() {
        List<String> tables = jdbc.queryForList("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
              AND table_name <> 'flyway_schema_history'
            ORDER BY table_name
            """, String.class);
        Map<String, String> digest = new LinkedHashMap<>();
        for (String table : tables)
            digest.put(table, jdbc.queryForObject(
                "SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') FROM "
                    + "(SELECT md5(t::text) AS h FROM \"" + table + "\" t) row_digests",
                String.class));
        return digest;
    }

    // ================================================================== fixtures

    private UUID card(int games, PairingRuleType initial, List<PairingRuleType> edgeRules) {
        return card(games, initial, edgeRules, "NONE", 0);
    }

    private UUID card(int games, PairingRuleType initial, List<PairingRuleType> edgeRules,
                      String finalType, int finalGames) {
        List<Integer> maxDiffs = new ArrayList<>();
        for (int i = 0; i < games; i++) maxDiffs.add(500);
        UUID id = service.create(new CardDtos.CreateCardRequest(tournamentId, "PhaseC-" + UUID.randomUUID(),
            "DIV", games, edgeRules, maxDiffs, finalType, finalGames, false, initial), "ittest").id();

        // tournament_cards.created_at defaults to now(), which in PostgreSQL is the TRANSACTION's
        // start time — every card this test creates would otherwise share one timestamp. The live
        // catalog orders by created_at DESC with no tie-break, so tied rows come back in whatever
        // order PostgreSQL chooses and no ordering assertion would mean anything. Real cards are
        // created in separate transactions minutes apart; stamping distinct, decreasing timestamps
        // reproduces that rather than testing an order the live query never promises.
        jdbc.update("UPDATE tournament_cards SET created_at = ? WHERE id = ?",
            Timestamp.from(CREATED_BASE.plus(Duration.ofMinutes(created++))), id);
        return id;
    }

    /** A card that ends in a two-slot final round. Two final games so one can stay unscored. */
    private UUID finalRoundCard() {
        return card(3, PairingRuleType.RANDOM, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS),
            "CHAMPION_AND_THIRD", 2);
    }

    /**
     * Plays every ordinary game to publication. {@code simulate} cannot be used for a final-round
     * card: it loops until the status is FINISHED, but such a card stops at FINAL_SEEDING with the
     * status still RUNNING, and its next pairing attempt throws.
     */
    private void playAllGames(UUID cardId) {
        service.finishRegistration(cardId, "ittest");
        while (service.get(cardId, true).runtimeStage() != RuntimeStage.FINAL_SEEDING) {
            service.generatePairingPreview(cardId, "ittest");
            service.confirmPairingPreview(cardId, "ittest");
            service.autoResults(cardId, "ittest");
            service.reviewResults(cardId, "ittest");
            service.publishResults(cardId, "ittest");
        }
    }

    private void addPlayers(UUID cardId, int count) {
        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < count; i++)
            players.add(new CardDtos.BulkPlayerEntry("First" + i, "Last" + i, "School" + (i % 3)));
        service.addPlayersBulk(cardId, players, "ittest");
    }

    private static CardDtos.CardResponse byId(Result result, UUID cardId) {
        return result.snapshot().stream().filter(card -> card.id().equals(cardId)).findFirst()
            .orElseThrow(() -> new AssertionError("card " + cardId + " missing from the snapshot"));
    }

    /**
     * Clears the Caffeine caches <b>immediately</b>, bypassing the transaction-aware decorator.
     *
     * <p>{@code CacheConfiguration} wraps the cache manager in a {@link TransactionAwareCacheManagerProxy},
     * which defers {@code clear()} and every {@code @EvictPublicCard} eviction until the surrounding
     * transaction <em>commits</em>. This test's transaction is always rolled back, so a plain
     * {@code clear()} would be discarded and never run — the read model would answer from whatever a
     * previous test left in the catalog, which is exactly how this test first failed. Unwrapping to
     * {@link TransactionAwareCacheDecorator#getTargetCache()} clears the real cache now.
     *
     * <p>The same unwrapping runs after each test: reads performed here populate the real cache from
     * rows that are about to be rolled back, and those entries must not outlive the test.
     */
    private void clearPublicCaches() {
        for (String name : List.of(TournamentCaches.PUBLIC_CARD_DETAILS, TournamentCaches.PUBLIC_CARD_CATALOG,
            TournamentCaches.PUBLIC_CARD_VERSIONS)) {
            Cache cache = caches.getCache(name);
            if (cache instanceof TransactionAwareCacheDecorator decorator) cache = decorator.getTargetCache();
            if (cache != null) cache.clear();
        }
    }

    private static JsonNode parse(String json) {
        try {
            return PARSER.readTree(json);
        } catch (Exception error) {
            throw new IllegalStateException("Document is not valid JSON", error);
        }
    }
}
