package com.ctwe.tournament.application.publicsnapshot;

import java.time.Instant;
import java.util.UUID;

/**
 * The complete snapshot document: generation metadata alongside the payload.
 *
 * <p>The split exists for determinism. {@link #payload()} depends only on the source data and is what
 * the checksum covers; everything that varies per generation — the timestamp, and later the published
 * version number — lives in {@link Meta} where it cannot disturb those bytes.
 *
 * <p>{@code version} is {@code null} here by design: version numbers are assigned when a snapshot is
 * actually published, which is Phase B. Generation alone claims no version.
 */
public record PublicSnapshotEnvelope(Meta snapshot, PublicSnapshotPayload payload) {

    public record Meta(
        int schema,
        Long version,
        Instant generatedAt,
        String checksum,
        long payloadBytes,
        UUID sourceTournamentId
    ) {}

    /** Wraps a generated artifact for transport. {@code generatedAt} is supplied by the caller. */
    public static PublicSnapshotEnvelope of(PublicSnapshotArtifact artifact, Instant generatedAt) {
        return new PublicSnapshotEnvelope(
            new Meta(SnapshotJson.SCHEMA, null, generatedAt, artifact.checksum(), artifact.payloadBytes(),
                artifact.payload().id()),
            artifact.payload());
    }
}
