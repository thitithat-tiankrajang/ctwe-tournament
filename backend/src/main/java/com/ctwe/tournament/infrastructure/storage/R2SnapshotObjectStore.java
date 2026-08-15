package com.ctwe.tournament.infrastructure.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.net.URI;
import java.util.Map;
import java.util.Optional;

/**
 * Cloudflare R2 through the S3 API. The only class in the application that reads R2 credentials.
 *
 * <p>R2's {@code PutObject} is atomic per object: a concurrent reader gets the whole previous object
 * or the whole new one, never a torn mixture. That single guarantee is what lets the pipeline switch
 * public traffic in one operation, with no window in which a viewer could see a half-updated
 * tournament (architecture §7.3).
 *
 * <p>{@code auto} is the only region R2 accepts. Path-style addressing avoids per-bucket DNS.
 */
public class R2SnapshotObjectStore implements SnapshotObjectStore {
    private static final Logger log = LoggerFactory.getLogger(R2SnapshotObjectStore.class);

    private final S3Client s3;
    private final String privateBucket;
    private final String publicBucket;

    public R2SnapshotObjectStore(S3Client s3, String privateBucket, String publicBucket) {
        this.s3 = s3;
        this.privateBucket = privateBucket;
        this.publicBucket = publicBucket;
    }

    /** Builds a client from properties already validated as complete. */
    public static R2SnapshotObjectStore from(SnapshotStorageProperties properties) {
        S3Client client = S3Client.builder()
            .endpointOverride(URI.create(properties.endpoint()))
            .region(Region.of("auto"))
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(properties.accessKeyId(), properties.secretAccessKey())))
            .forcePathStyle(true)
            .build();
        log.info("Public Snapshot storage enabled (private bucket '{}', public bucket '{}')",
            properties.privateBucket(), properties.publicBucket());
        return new R2SnapshotObjectStore(client, properties.privateBucket(), properties.publicBucket());
    }

    @Override
    public boolean available() {
        return true;
    }

    @Override
    public void putPrivate(String key, byte[] body) {
        s3.putObject(PutObjectRequest.builder()
            .bucket(privateBucket).key(key)
            .contentType("application/json")
            .contentLength((long) body.length)
            .build(), RequestBody.fromBytes(body));
    }

    @Override
    public Optional<byte[]> getPrivate(String key) {
        try {
            return Optional.of(s3.getObjectAsBytes(
                GetObjectRequest.builder().bucket(privateBucket).key(key).build()).asByteArray());
        } catch (NoSuchKeyException missing) {
            return Optional.empty();
        }
    }

    @Override
    public void putPublic(String key, byte[] body, String cacheControl, boolean noIndex) {
        PutObjectRequest.Builder request = PutObjectRequest.builder()
            .bucket(publicBucket).key(key)
            .contentType("application/json")
            .cacheControl(cacheControl)
            .contentLength((long) body.length);
        // Staging objects are briefly reachable on the public hostname while being verified. This is
        // stored as user metadata (x-amz-meta-robots) and is NOT served as an X-Robots-Tag header:
        // S3/R2 PutObject cannot set an arbitrary response header. Emitting the real header is a
        // Cloudflare Transform Rule on /s/*.staging-*.json (architecture §7.4). The metadata marks the
        // intent on the object itself; the object's actual protection is `no-store`, being referenced
        // from nowhere, and being deleted once the promotion completes.
        if (noIndex) request.metadata(Map.of("robots", "noindex"));
        s3.putObject(request.build(), RequestBody.fromBytes(body));
    }

    @Override
    public void deletePublic(String key) {
        s3.deleteObject(DeleteObjectRequest.builder().bucket(publicBucket).key(key).build());
    }
}
