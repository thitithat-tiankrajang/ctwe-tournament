package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.infrastructure.cdn.CachePurgeClient;
import com.ctwe.tournament.infrastructure.storage.PublicSnapshotFetcher;
import com.ctwe.tournament.infrastructure.storage.SnapshotObjectStore;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * An in-memory stand-in for R2 plus the public hostname in front of it.
 *
 * <p>R2 itself cannot be exercised in CI, so the pipeline's failure modes are injected here instead:
 * a refused upload, an unreachable read-back, a truncated response, corrupted bytes. Each one is a
 * real branch of {@code PublicSnapshotPublisher}, and the property being tested is always the same —
 * <b>whatever was public before must still be public after</b>.
 *
 * <p>The public map models R2's per-object atomicity: a {@code putPublic} either replaces an entry
 * wholly or (when made to fail) does not touch it at all. There is no state in which a key holds
 * half of one document and half of another, which is what makes "one self-contained object" a
 * sufficient answer to torn reads.
 *
 * <p>{@link #fetch} reads the public map, so a read-back sees exactly what was written — unless a
 * fault is installed to make it lie, which is how a stale edge or a corrupting proxy is simulated.
 */
final class FakeSnapshotStorage implements SnapshotObjectStore, PublicSnapshotFetcher, CachePurgeClient {

    /** What a fault should do to one operation. */
    enum Fault { NONE, THROW_ON_PUT_PUBLIC, THROW_ON_PUT_PRIVATE, THROW_ON_DELETE_PUBLIC,
                 FETCH_FAILS, FETCH_404, FETCH_TRUNCATED, FETCH_CORRUPTED, FETCH_STALE }

    private final Map<String, byte[]> publicObjects = new LinkedHashMap<>();
    /** What each public key held BEFORE its latest write — the bytes a lagging edge would still serve. */
    private final Map<String, byte[]> supersededObjects = new LinkedHashMap<>();
    private final Map<String, byte[]> privateObjects = new LinkedHashMap<>();
    private final Map<String, String> cacheControl = new LinkedHashMap<>();
    private final List<String> operations = new ArrayList<>();
    private final List<String> purged = new ArrayList<>();

    private Fault fault = Fault.NONE;
    /** Which key the fault applies to; null means "any". */
    private String faultKeySuffix;
    private boolean available = true;

    // ------------------------------------------------------------------ fault injection

    void fail(Fault fault) {
        fail(fault, null);
    }

    void fail(Fault fault, String keySuffix) {
        this.fault = fault;
        this.faultKeySuffix = keySuffix;
    }

    void clearFaults() {
        fault = Fault.NONE;
        faultKeySuffix = null;
    }

    void setAvailable(boolean available) {
        this.available = available;
    }

    private boolean faultApplies(Fault candidate, String key) {
        return fault == candidate && (faultKeySuffix == null || key.endsWith(faultKeySuffix));
    }

    // ------------------------------------------------------------------ inspection

    Optional<byte[]> publicObject(String key) {
        return Optional.ofNullable(publicObjects.get(key));
    }

    Map<String, byte[]> publicObjects() {
        return publicObjects;
    }

    Optional<String> publicCacheControl(String key) {
        return Optional.ofNullable(cacheControl.get(key));
    }

    List<String> operations() {
        return operations;
    }

    List<String> purged() {
        return purged;
    }

    // ------------------------------------------------------------------ SnapshotObjectStore

    @Override
    public boolean available() {
        return available;
    }

    @Override
    public void putPrivate(String key, byte[] body) {
        operations.add("putPrivate " + key);
        if (faultApplies(Fault.THROW_ON_PUT_PRIVATE, key)) throw new IllegalStateException("private upload refused");
        privateObjects.put(key, body.clone());
    }

    @Override
    public Optional<byte[]> getPrivate(String key) {
        operations.add("getPrivate " + key);
        return Optional.ofNullable(privateObjects.get(key)).map(byte[]::clone);
    }

    @Override
    public void putPublic(String key, byte[] body, String control, boolean noIndex) {
        operations.add("putPublic " + key);
        // Fails BEFORE mutating, exactly as a refused PutObject would: the previous object survives.
        if (faultApplies(Fault.THROW_ON_PUT_PUBLIC, key)) throw new IllegalStateException("public upload refused");
        byte[] replaced = publicObjects.put(key, body.clone());
        if (replaced != null) supersededObjects.put(key, replaced);
        cacheControl.put(key, control);
    }

    @Override
    public void deletePublic(String key) {
        operations.add("deletePublic " + key);
        // Fails BEFORE mutating, exactly as a refused DeleteObject would: the object survives, so a
        // retraction that cannot remove it must leave the tournament exactly as it found it.
        if (faultApplies(Fault.THROW_ON_DELETE_PUBLIC, key)) throw new IllegalStateException("delete refused");
        byte[] removed = publicObjects.remove(key);
        // A CDN edge does not forget an object because the origin deleted it — it keeps serving its
        // cached copy until the purge lands or max-age expires. Recording the removed bytes here is
        // what lets FETCH_STALE model a retraction whose 404 is not visible yet.
        if (removed != null) supersededObjects.put(key, removed);
        cacheControl.remove(key);
    }

    // ------------------------------------------------------------------ PublicSnapshotFetcher

    @Override
    public Result fetch(String key, boolean cacheBust) {
        operations.add("fetch " + key + (cacheBust ? " (cache-bust)" : ""));
        if (faultApplies(Fault.FETCH_FAILS, key)) return Result.failed("connection reset");
        if (faultApplies(Fault.FETCH_404, key)) return Result.of(404, new byte[0], 0);

        // Checked before the object is looked up, because a stale edge answers whether or not the
        // origin still holds the key — that is exactly what makes it stale.
        if (faultApplies(Fault.FETCH_STALE, key)) {
            byte[] stale = supersededObjects.getOrDefault(key, publicObjects.get(key));
            if (stale != null) return Result.of(200, stale.clone(), stale.length);
        }

        byte[] body = publicObjects.get(key);
        if (body == null) return Result.of(404, new byte[0], 0);

        if (faultApplies(Fault.FETCH_TRUNCATED, key)) {
            byte[] shortened = new byte[body.length - 10];
            System.arraycopy(body, 0, shortened, 0, shortened.length);
            // Declares the FULL length while returning less — the shape of a real truncation.
            return Result.of(200, shortened, body.length);
        }
        if (faultApplies(Fault.FETCH_CORRUPTED, key)) {
            byte[] corrupted = body.clone();
            corrupted[corrupted.length / 2] ^= 0x20;
            return Result.of(200, corrupted, corrupted.length);
        }
        return Result.of(200, body.clone(), body.length);
    }

    // ------------------------------------------------------------------ CachePurgeClient

    @Override
    public boolean purge(String url) {
        purged.add(url);
        return true;
    }
}
