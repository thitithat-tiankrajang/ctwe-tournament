package com.ctwe.tournament.infrastructure.storage;

/**
 * Reads a public snapshot object <b>through the public hostname</b>, exactly as a browser would.
 *
 * <p>Separate from {@link SnapshotObjectStore} on purpose. The publication pipeline must not promote
 * bytes it has only confirmed via the S3 API: that would prove the write reached R2 and nothing else.
 * Fetching over HTTPS from the custom domain additionally proves DNS resolves, the CDN serves the
 * object, the content type is right, and the bytes survived the round trip — the failure modes that
 * actually strand a published tournament.
 */
public interface PublicSnapshotFetcher {

    /** Whether the public hostname is configured. */
    boolean available();

    /**
     * @param key       object key, e.g. {@code s/abc….json}
     * @param cacheBust when true, appends a unique query string so a CDN edge cannot answer with a
     *                  previously cached copy of this key — required when verifying a promotion
     */
    Result fetch(String key, boolean cacheBust);

    /**
     * @param status        HTTP status; 0 when the request never completed
     * @param body          response bytes, empty on failure
     * @param contentLength the length the response declared, or -1 when absent
     * @param failure       transport-level failure message, null on an HTTP response of any status
     */
    record Result(int status, byte[] body, long contentLength, String failure) {

        public boolean ok() {
            return failure == null && status == 200;
        }

        public static Result of(int status, byte[] body, long contentLength) {
            return new Result(status, body, contentLength, null);
        }

        public static Result failed(String failure) {
            return new Result(0, new byte[0], -1, failure);
        }
    }
}
