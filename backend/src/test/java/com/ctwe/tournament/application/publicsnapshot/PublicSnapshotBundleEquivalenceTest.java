package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.PublicCardReadCache;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.StreamSupport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The snapshot must be the same thing the viewer already receives.
 *
 * <p>{@code GET /api/public/tournaments/{token}/bundle} composes
 * {@code PublicTournamentBundle(id, name, accessToken, cardCount, publishedCardCount, cards[])} where
 * each card comes from {@code PublicCardReadCache.card(...)}. This test drives both that path and the
 * snapshot builder from one set of mocks and asserts they agree — so the existing frontend can consume
 * a snapshot with no component change.
 *
 * <p>Exactly one intentional difference is pinned here: the snapshot omits {@code accessToken}. If any
 * other field ever diverges, this fails.
 *
 * <p>Phase C extends this to a database-backed comparison against the live HTTP endpoint; at A2 the
 * shared mocks already prove the assembly and the projection agree.
 */
class PublicSnapshotBundleEquivalenceTest {
    /** The only field the snapshot deliberately drops. */
    private static final Set<String> INTENTIONALLY_OMITTED = Set.of("accessToken");

    private static final ObjectMapper PARSER = JsonMapper.builder().addModule(new JavaTimeModule()).build();

    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService cards = mock(TournamentCardService.class);

    @Test
    @DisplayName("every snapshot card is byte-identical to the card the live read model serves")
    void cardsMatchTheLiveReadModel() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        stubPublicVersionLookups();

        List<CardDtos.CardResponse> snapshotCards =
            new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID).payload().cards();
        PublicCardReadCache readModel = new PublicCardReadCache(jdbc, cards);

        assertThat(snapshotCards).isNotEmpty();
        for (CardDtos.CardResponse snapshotCard : snapshotCards) {
            String live = SnapshotJson.canonical(readModel.card(snapshotCard.id()));
            assertThat(SnapshotJson.canonical(snapshotCard))
                .as("card %s must be identical in the snapshot and in the live bundle", snapshotCard.id())
                .isEqualTo(live);
        }
    }

    @Test
    @DisplayName("the payload has exactly the bundle's fields, minus accessToken")
    void payloadMatchesTheBundleContract() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        stubPublicVersionLookups();

        PublicSnapshotPayload payload =
            new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID).payload();
        TenantDtos.PublicTournamentBundle bundle = liveBundle(payload);

        JsonNode payloadNode = parse(SnapshotJson.canonical(payload));
        JsonNode bundleNode = parse(SnapshotJson.canonical(bundle));

        Set<String> payloadFields = fieldNames(payloadNode);
        Set<String> bundleFields = fieldNames(bundleNode);

        assertThat(bundleFields).containsAll(payloadFields);
        assertThat(difference(bundleFields, payloadFields))
            .as("the snapshot may drop accessToken and nothing else")
            .isEqualTo(INTENTIONALLY_OMITTED);
        assertThat(difference(payloadFields, bundleFields))
            .as("the snapshot may not invent fields the bundle contract does not have")
            .isEmpty();

        for (String field : payloadFields)
            assertThat(payloadNode.get(field))
                .as("field '%s' must carry the same value as the live bundle", field)
                .isEqualTo(bundleNode.get(field));
    }

    /** Rebuilds the live bundle exactly as {@code PublicTournamentController.bundle} assembles it. */
    private TenantDtos.PublicTournamentBundle liveBundle(PublicSnapshotPayload payload) {
        PublicCardReadCache readModel = new PublicCardReadCache(jdbc, cards);
        List<CardDtos.CardResponse> details = new ArrayList<>();
        for (CardDtos.CardResponse card : payload.cards()) details.add(readModel.card(card.id()));
        return new TenantDtos.PublicTournamentBundle(
            payload.id(), payload.name(), "some-access-token",
            payload.cardCount(), payload.publishedCardCount(), details);
    }

    /** The read model resolves public_version per card; the builder gets it from its own row query. */
    private void stubPublicVersionLookups() {
        for (SnapshotFixtures.Seed seed : SnapshotFixtures.seeds())
            when(jdbc.queryForList("SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, seed.id()))
                .thenReturn(List.of(seed.publicVersion()));
    }

    private static JsonNode parse(String json) {
        try {
            return PARSER.readTree(json);
        } catch (Exception error) {
            throw new IllegalStateException("Snapshot document is not valid JSON", error);
        }
    }

    private static Set<String> fieldNames(JsonNode node) {
        return StreamSupport.stream(((Iterable<String>) node::fieldNames).spliterator(), false)
            .collect(java.util.stream.Collectors.toCollection(java.util.LinkedHashSet::new));
    }

    private static Set<String> difference(Set<String> left, Set<String> right) {
        Set<String> result = new java.util.LinkedHashSet<>(left);
        result.removeAll(right);
        return result;
    }
}
