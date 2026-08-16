package com.ctwe.tournament.application.publicsnapshot;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * The stored document is composed two different ways, and they must agree.
 *
 * <p>Publication wraps a freshly built artifact; rollback wraps payload bytes read back out of
 * private history, which must NOT be re-serialized from a parsed object graph — round-tripping
 * through Java types is precisely where a restored payload could quietly differ from the one that
 * was verified. So {@link SnapshotJson#envelope} takes the payload as an opaque canonical string,
 * and this test pins that its output is byte-identical to serializing
 * {@link PublicSnapshotEnvelope} directly.
 */
class SnapshotJsonEnvelopeTest {
    private static final Instant GENERATED_AT = Instant.parse("2026-08-15T09:30:00Z");

    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final com.ctwe.tournament.application.TournamentCardService cards =
        mock(com.ctwe.tournament.application.TournamentCardService.class);

    @Test
    @DisplayName("composing from canonical payload bytes equals serializing the record")
    void compositionMatchesDirectSerialization() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        PublicSnapshotArtifact artifact = new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID);
        PublicSnapshotEnvelope.Meta meta = new PublicSnapshotEnvelope.Meta(
            SnapshotJson.SCHEMA, 7L, GENERATED_AT, artifact.checksum(), artifact.payloadBytes(),
            artifact.payload().id());

        String composed = SnapshotJson.envelope(meta, artifact.payloadJson());
        String direct = SnapshotJson.canonical(new PublicSnapshotEnvelope(meta, artifact.payload()));

        assertThat(composed).isEqualTo(direct);
    }

    @Test
    @DisplayName("the payload survives a compose/extract round trip byte for byte")
    void payloadRoundTrips() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        PublicSnapshotArtifact artifact = new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID);

        String document = SnapshotJson.envelope(new PublicSnapshotEnvelope.Meta(
            SnapshotJson.SCHEMA, 2L, GENERATED_AT, artifact.checksum(), artifact.payloadBytes(),
            artifact.payload().id()), artifact.payloadJson());

        assertThat(SnapshotJson.payloadOf(document)).isEqualTo(artifact.payloadJson());
        assertThat(SnapshotJson.checksum(SnapshotJson.payloadOf(document))).isEqualTo(artifact.checksum());
    }

    @Test
    @DisplayName("envelope metadata stays outside the checksum")
    void metadataDoesNotAffectTheChecksum() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        PublicSnapshotArtifact artifact = new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID);
        UUID id = artifact.payload().id();

        String first = SnapshotJson.envelope(new PublicSnapshotEnvelope.Meta(
            SnapshotJson.SCHEMA, 1L, GENERATED_AT, artifact.checksum(), artifact.payloadBytes(), id),
            artifact.payloadJson());
        String later = SnapshotJson.envelope(new PublicSnapshotEnvelope.Meta(
            SnapshotJson.SCHEMA, 99L, GENERATED_AT.plusSeconds(86_400), artifact.checksum(),
            artifact.payloadBytes(), id), artifact.payloadJson());

        assertThat(first).isNotEqualTo(later);
        assertThat(SnapshotJson.payloadOf(first))
            .as("different generation metadata, identical checksummed bytes")
            .isEqualTo(SnapshotJson.payloadOf(later));
        assertThat(SnapshotJson.versionOf(first)).isEqualTo(1L);
        assertThat(SnapshotJson.versionOf(later)).isEqualTo(99L);
    }
}
