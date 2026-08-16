package com.ctwe.tournament.infrastructure.storage;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

/**
 * What runs when no R2 configuration is present — local development, CI, and any deployment that has
 * not been given buckets yet.
 *
 * <p>Publication is unavailable rather than broken: the application boots normally, snapshot
 * <em>generation</em> (the dry-run endpoint) keeps working because it never touches storage, and any
 * attempt to actually publish fails immediately with a message that names the missing configuration
 * instead of a stack trace from a null client.
 *
 * <p>The two ports get separate classes rather than one object implementing both. A single class
 * would satisfy two bean types at once and make {@code PublicSnapshotFetcher} injection ambiguous
 * the moment both fall back at the same time — which is every local run.
 */
public final class UnconfiguredSnapshotStorage {

    static final String MESSAGE =
        "Public Snapshot storage is not configured (app.snapshot-storage.*). Publication is unavailable.";

    private UnconfiguredSnapshotStorage() {}

    static ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, MESSAGE);
    }

    /** Stands in for R2 when no buckets are configured. */
    public static final class Store implements SnapshotObjectStore {
        @Override
        public boolean available() {
            return false;
        }

        @Override
        public void putPrivate(String key, byte[] body) {
            throw unavailable();
        }

        @Override
        public Optional<byte[]> getPrivate(String key) {
            throw unavailable();
        }

        @Override
        public void putPublic(String key, byte[] body, String cacheControl, boolean noIndex) {
            throw unavailable();
        }

        @Override
        public void deletePublic(String key) {
            throw unavailable();
        }
    }

    /** Stands in for the public hostname when none is configured. */
    public static final class Fetcher implements PublicSnapshotFetcher {
        @Override
        public boolean available() {
            return false;
        }

        @Override
        public Result fetch(String key, boolean cacheBust) {
            return Result.failed(MESSAGE);
        }
    }
}
