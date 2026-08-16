package com.ctwe.tournament.infrastructure.cdn;

/**
 * Purges one URL from the Cloudflare edge cache after a snapshot is promoted.
 *
 * <p>Purging is a latency optimisation, never a correctness mechanism. The promoted object carries
 * {@code max-age=300}, so an edge that keeps serving the old bytes self-corrects within five minutes
 * even if every purge attempt fails. The pipeline therefore treats a failed purge as a warning and
 * continues — and the verification step that follows reads with a cache-busting query string, so a
 * stale edge cannot make a bad promotion look good.
 */
public interface CachePurgeClient {

    boolean available();

    /**
     * @return true when the edge acknowledged the purge; false when it was skipped or refused.
     *         Never throws — the caller must not fail a correct publication over a cache hint.
     */
    boolean purge(String url);
}
