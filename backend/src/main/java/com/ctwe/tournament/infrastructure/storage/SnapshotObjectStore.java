package com.ctwe.tournament.infrastructure.storage;

import java.util.Optional;

/**
 * The only way Public Snapshot code touches object storage.
 *
 * <p>Two buckets, deliberately:
 * <ul>
 *   <li><b>private</b> — full version history ({@code t/{uuid}/v/{n}/…}). S3 API only, no custom
 *       domain, never publicly reachable. This is what makes a rollback a copy instead of a
 *       regeneration.</li>
 *   <li><b>public</b> — served by a custom hostname, {@code GET}/{@code HEAD} only. Exactly one
 *       current object per published tournament, so withdrawing one is a single delete.</li>
 * </ul>
 *
 * <p>Reads of the public bucket are deliberately <b>absent</b> from this interface. Verifying a
 * published object must prove DNS, CDN, CORS, content type and byte integrity on the real path a
 * viewer takes — an S3 API read would prove none of that. See {@link PublicSnapshotFetcher}.
 *
 * <p>Implementations are the only classes that read R2 credentials. Credentials live in Render's
 * environment, are never {@code NEXT_PUBLIC_*}, and the Cloudflare Worker gets no R2 binding.
 */
public interface SnapshotObjectStore {

    /** Whether storage is configured. False in local dev and CI, where publication is unavailable. */
    boolean available();

    /** Writes immutable history. Private bucket. */
    void putPrivate(String key, byte[] body);

    /** Reads back private history — used by rollback to re-promote an earlier version's exact bytes. */
    Optional<byte[]> getPrivate(String key);

    /**
     * Writes a public object.
     *
     * @param cacheControl the object's {@code Cache-Control}; the caller chooses it per key, because
     *                     a staging object and a promoted object have opposite caching needs
     * @param noIndex      sets {@code X-Robots-Tag: noindex} — always true for staging keys, which
     *                     are briefly fetchable through the public hostname during verification
     */
    void putPublic(String key, byte[] body, String cacheControl, boolean noIndex);

    /** Removes a public object. Used for staging cleanup in Phase B. */
    void deletePublic(String key);
}
