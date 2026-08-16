package com.ctwe.tournament.application.publicsnapshot;

/**
 * One generated Public Snapshot: the payload plus the canonical bytes that represent it and their
 * fingerprint.
 *
 * <p>{@code payloadJson} is the standalone canonical serialization of {@link #payload()}, and
 * {@code checksum} is taken over exactly those bytes. Phase B verifies a published object by parsing
 * it, re-serializing its payload canonically, and comparing the result to this checksum — so the
 * definition must stay "the payload serialized on its own", not "the payload as nested inside an
 * envelope".
 *
 * <p>Every field here is a pure function of the source data. Nothing in this record changes between
 * two generations from an unchanged database.
 */
public record PublicSnapshotArtifact(
    PublicSnapshotPayload payload,
    String payloadJson,
    String checksum,
    long payloadBytes
) {
    public static PublicSnapshotArtifact of(PublicSnapshotPayload payload) {
        String json = SnapshotJson.canonical(payload);
        return new PublicSnapshotArtifact(payload, json, SnapshotJson.checksum(json), SnapshotJson.byteLength(json));
    }
}
