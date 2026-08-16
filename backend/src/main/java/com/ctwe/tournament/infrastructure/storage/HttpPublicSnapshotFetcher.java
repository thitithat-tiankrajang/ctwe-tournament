package com.ctwe.tournament.infrastructure.storage;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

/**
 * Fetches a public object over HTTPS from the snapshot hostname — the same path a viewer's browser
 * takes, which is the point (see {@link PublicSnapshotFetcher}).
 *
 * <p>Every failure is returned as data rather than thrown. The pipeline's decision after a failed
 * verification is always the same — abandon the attempt and leave the previous public object exactly
 * where it is — and that decision should read as a branch, not an exception handler.
 */
public class HttpPublicSnapshotFetcher implements PublicSnapshotFetcher {
    private static final Duration TIMEOUT = Duration.ofSeconds(10);

    private final HttpClient http;
    private final SnapshotStorageProperties properties;

    public HttpPublicSnapshotFetcher(SnapshotStorageProperties properties) {
        this(properties, HttpClient.newBuilder().connectTimeout(TIMEOUT).build());
    }

    HttpPublicSnapshotFetcher(SnapshotStorageProperties properties, HttpClient http) {
        this.properties = properties;
        this.http = http;
    }

    @Override
    public boolean available() {
        return properties.enabled();
    }

    @Override
    public Result fetch(String key, boolean cacheBust) {
        if (!available()) return Result.failed("app.snapshot-storage.public-origin is not configured");
        // A CDN edge holding the PREVIOUS version of this key would otherwise let a promotion verify
        // against bytes it just replaced. The query string makes the post-promotion read a miss.
        String url = properties.publicUrl(key) + (cacheBust ? "?verify=" + UUID.randomUUID() : "");
        try {
            HttpResponse<byte[]> response = http.send(
                HttpRequest.newBuilder(URI.create(url)).GET().timeout(TIMEOUT).build(),
                HttpResponse.BodyHandlers.ofByteArray());
            long declared = response.headers().firstValueAsLong("content-length").orElse(-1L);
            return Result.of(response.statusCode(), response.body(), declared);
        } catch (IOException error) {
            return Result.failed(error.getClass().getSimpleName() + ": " + error.getMessage());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Result.failed("interrupted while reading " + key);
        }
    }
}
