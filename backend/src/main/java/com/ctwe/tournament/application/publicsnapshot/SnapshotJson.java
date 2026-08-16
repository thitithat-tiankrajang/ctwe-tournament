package com.ctwe.tournament.application.publicsnapshot;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * Canonical serialization for Public Snapshot artifacts.
 *
 * <p>A published snapshot is permanent and is verified by comparing checksums, so its bytes must
 * depend on the source data and nothing else. This mapper is deliberately private to the snapshot
 * feature and is <b>not</b> Spring's mapper:
 *
 * <ul>
 *   <li><b>Own instance.</b> {@code application.yml} sets
 *       {@code spring.jackson.default-property-inclusion: non_null} globally. If snapshots used the
 *       shared mapper, changing that property later would silently alter the shape of every future
 *       snapshot — and disagree with snapshots already published.</li>
 *   <li><b>Nulls are written.</b> An absent value stays visible as {@code null} instead of changing
 *       the document's shape, so "field became null" is a checksum change rather than a silent one.</li>
 *   <li><b>Keys sorted alphabetically.</b> Byte stability no longer depends on the declaration order
 *       of Java record components, so reordering a record cannot invalidate a checksum.</li>
 *   <li><b>ISO-8601 timestamps, never epoch numbers.</b> Readable and locale-independent.</li>
 *   <li><b>Indented.</b> These bytes are a permanent public artifact that humans review and diff;
 *       Cloudflare compresses the whitespace away in transit. Switching to compact output would be a
 *       one-line change here, but it would also change every future checksum.</li>
 * </ul>
 *
 * <p>Nothing generation-specific (timestamps, version numbers) may be serialized through here as part
 * of a payload — see {@link PublicSnapshotEnvelope}, which keeps those outside the checksummed bytes.
 */
public final class SnapshotJson {
    /** Bumped only when the artifact's shape changes in a way consumers must notice. */
    public static final int SCHEMA = 1;

    private static final ObjectMapper MAPPER = JsonMapper.builder()
        .addModule(new JavaTimeModule())
        .enable(SerializationFeature.INDENT_OUTPUT)
        .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build();

    private SnapshotJson() {}

    /** Serializes to the canonical form. Identical input always yields identical bytes. */
    public static String canonical(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Cannot serialize public snapshot document", error);
        }
    }

    /**
     * Content fingerprint of a canonical document: {@code sha256-<hex>} over its UTF-8 bytes.
     * Phase B re-derives this the same way when verifying a published object.
     */
    public static String checksum(String canonicalJson) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(canonicalJson.getBytes(StandardCharsets.UTF_8));
            return "sha256-" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is required to fingerprint a public snapshot", error);
        }
    }

    /** Byte length of a canonical document as it will be stored/served. */
    public static long byteLength(String canonicalJson) {
        return canonicalJson.getBytes(StandardCharsets.UTF_8).length;
    }

    /**
     * Composes the stored document from metadata plus an <em>already canonical</em> payload.
     *
     * <p>Publication and rollback both go through here. Rollback re-promotes bytes read back from
     * private history and must not re-serialize them from a parsed object graph — round-tripping
     * through Java types is exactly where a payload could quietly change. Taking the payload as an
     * opaque canonical string means the bytes that were verified when a version was first published
     * are the bytes that go back out.
     *
     * <p>{@code payload} is inserted before {@code snapshot} so the result matches what serializing
     * {@link PublicSnapshotEnvelope} directly produces under alphabetical key sorting — pinned by
     * {@code SnapshotJsonEnvelopeTest}.
     */
    public static String envelope(PublicSnapshotEnvelope.Meta meta, String canonicalPayloadJson) {
        ObjectNode root = MAPPER.createObjectNode();
        root.set("payload", parse(canonicalPayloadJson));
        root.set("snapshot", MAPPER.valueToTree(meta));
        return canonical(root);
    }

    /**
     * The payload half of a stored document, re-serialized canonically so its checksum can be
     * re-derived and compared with what was recorded at publication.
     */
    public static String payloadOf(String document) {
        JsonNode payload = parse(document).get("payload");
        if (payload == null || !payload.isObject())
            throw new IllegalStateException("Snapshot document has no payload object");
        return canonical(payload);
    }

    /** The envelope's declared version, or empty when absent (a generation-only document). */
    public static Long versionOf(String document) {
        JsonNode version = parse(document).path("snapshot").path("version");
        return version.isNumber() ? version.longValue() : null;
    }

    public static JsonNode parse(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Not a valid public snapshot document", error);
        }
    }
}
