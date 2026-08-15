package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.infrastructure.cdn.CachePurgeClient;
import com.ctwe.tournament.infrastructure.storage.PublicSnapshotFetcher;
import com.ctwe.tournament.infrastructure.storage.SnapshotObjectStore;
import com.ctwe.tournament.infrastructure.storage.SnapshotStorageProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.Optional;
import java.util.UUID;

/**
 * Publishes a generated snapshot to R2 — the Phase B pipeline.
 *
 * <p>The ordering rule the whole design rests on: <b>the public pointer is never advanced to bytes
 * that have not been read back and checksum-verified through the public hostname.</b> Everything
 * before that point writes only to private history and to a transient staging key, so the previously
 * published object keeps serving unchanged no matter where an attempt fails.
 *
 * <pre>
 *  1 CLAIM      row lock; preconditions; state = PUBLISHING; version n = last + 1
 *  2 BUILD      one read-only REPEATABLE_READ transaction, straight from PostgreSQL, no cache
 *  3 STAGE      PUT private t/{uuid}/v/{n}/{payload,manifest}.json        (nothing public yet)
 *               PUT public  s/{h}.staging-{n}.json   no-store, noindex
 *  4 VERIFY     GET https://{publicOrigin}/s/{h}.staging-{n}.json
 *               assert 200, content length, and sha256 of the returned bytes
 *  5 RECORD     INSERT publication row, status VERIFIED
 *  6 PROMOTE ⚛  PUT public s/{h}.json   — one atomic PutObject of the already-verified bytes
 *               ══════ public traffic switches here and only here ══════
 *  7 PURGE      Cloudflare purge-by-URL (best effort; staleness is bounded by max-age=300)
 *  8 RE-VERIFY  GET the promoted key with a cache-busting query; assert the same checksum
 *  9 COMMIT     state = PUBLISHED, pointer = n; publication row -> PROMOTED
 * 10 CLEAN UP   DELETE the staging object (best effort; a leftover is inert and uncacheable)
 * </pre>
 *
 * <p><b>Never touches tournament data.</b> Step 2 reads; steps 1, 5 and 9 write only snapshot
 * bookkeeping. Nothing here deletes anything from PostgreSQL. This is not, and must never become,
 * the Excel Export &amp; Purge feature.
 *
 * <p>Deliberately not {@code @Transactional}: the pipeline spends most of its time on the network,
 * and a transaction spanning that would hold a row lock across R2 and Cloudflare. Each database step
 * is its own short transaction inside {@link PublicSnapshotState}, and {@code PUBLISHING} — set under
 * the lock in step 1 — is what excludes a concurrent attempt for the rest of the run.
 */
@Service
public class PublicSnapshotPublisher {
    private static final Logger log = LoggerFactory.getLogger(PublicSnapshotPublisher.class);

    private final PublicSnapshotBuilder builder;
    private final PublicSnapshotState state;
    private final SnapshotObjectStore store;
    private final PublicSnapshotFetcher fetcher;
    private final CachePurgeClient purge;
    private final SnapshotStorageProperties properties;

    public PublicSnapshotPublisher(PublicSnapshotBuilder builder, PublicSnapshotState state,
                                   SnapshotObjectStore store, PublicSnapshotFetcher fetcher,
                                   CachePurgeClient purge, SnapshotStorageProperties properties) {
        this.builder = builder;
        this.state = state;
        this.store = store;
        this.fetcher = fetcher;
        this.purge = purge;
        this.properties = properties;
    }

    /** The outcome of one publish, rollback or verify. */
    public record Outcome(boolean ok, long version, String checksum, String objectKey,
                          String publicUrl, String detail) {}

    // ------------------------------------------------------------------ publish

    public Outcome publish(UUID tournamentId, String actor) {
        requireStorage();
        PublicSnapshotState.Status status = state.status(tournamentId);
        String objectKey = SnapshotKey.publicObject(status.accessToken());

        // 1 CLAIM — after this returns, this tournament is locked out of a second attempt.
        long version = state.beginPublishing(tournamentId);
        String staging = SnapshotKey.stagingObject(status.accessToken(), version);

        try {
            // 2 BUILD — from PostgreSQL, bypassing the Caffeine read cache, in one consistent view.
            PublicSnapshotArtifact artifact = builder.build(tournamentId);
            byte[] document = document(artifact, version);

            // 3 STAGE — private history first, then a public key nothing points at yet.
            store.putPrivate(SnapshotKey.privatePayload(tournamentId, version), artifact.payloadJson().getBytes(StandardCharsets.UTF_8));
            store.putPrivate(SnapshotKey.privateManifest(tournamentId, version),
                manifest(status, version, artifact, actor).getBytes(StandardCharsets.UTF_8));
            store.putPublic(staging, document, SnapshotStorageProperties.STAGING_CACHE_CONTROL, true);

            // 4 VERIFY — through the real hostname, which is the only read that proves reachability.
            verifyThroughPublicHostname(staging, document, artifact.checksum(), false);

            // 5 RECORD — a verified candidate exists; the pointer still names the previous version.
            state.recordVerified(tournamentId, version, artifact.checksum(), artifact.payloadBytes(), objectKey, actor);

            // 6 PROMOTE — the single atomic operation that switches public traffic.
            store.putPublic(objectKey, document, SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL, false);

            // 7 PURGE — best effort by design; see CachePurgeClient.
            if (!purge.purge(properties.publicUrl(objectKey)) && purge.available())
                log.warn("Purge failed for {}; staleness is bounded by max-age", objectKey);

            // 8 RE-VERIFY — cache-busted, so an edge holding the previous bytes cannot mask a bad put.
            verifyThroughPublicHostname(objectKey, document, artifact.checksum(), true);

            // 9 COMMIT
            state.commitPublished(tournamentId, version, artifact.checksum(), actor);

            // 10 CLEAN UP — a surviving staging object is inert: no-store, noindex, unreferenced.
            try {
                store.deletePublic(staging);
            } catch (RuntimeException ignored) {
                log.warn("Could not remove staging object {} (harmless)", staging);
            }

            return new Outcome(true, version, artifact.checksum(), objectKey,
                properties.publicUrl(objectKey), "published");
        } catch (RuntimeException failure) {
            // Nothing public changed unless step 6 already ran; either way the recorded pointer is
            // restored to the last version that was actually promoted and verified.
            String reason = failure.getMessage() == null ? failure.toString() : failure.getMessage();
            state.failPublishing(tournamentId, version, reason, actor);
            safeDeleteStaging(staging);
            log.warn("Publication of tournament {} version {} aborted: {}", tournamentId, version, reason);
            throw failure;
        }
    }

    // ------------------------------------------------------------------ rollback

    /**
     * Re-promotes the previous verified version's exact bytes from private history.
     *
     * <p>A copy, not a regeneration: the bytes being restored are the ones that were verified when
     * that version was published, so a rollback cannot introduce content nobody has seen. The version
     * pointer moves backwards to the version actually being served, which keeps
     * "{@code snapshot_version} names the object at {@code s/&#123;h&#125;.json}" true at all times.
     */
    public Outcome rollback(UUID tournamentId, String actor) {
        requireStorage();
        PublicSnapshotState.Status status = state.status(tournamentId);
        String objectKey = SnapshotKey.publicObject(status.accessToken());
        requireNotRetracted(status.state(), tournamentId);

        PublicSnapshotState.Publication previous = state.previousPromoted(tournamentId, status.version())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                "ไม่มีฉบับก่อนหน้าให้ย้อนกลับ"));

        return restore(tournamentId, objectKey, previous, actor, null);
    }

    /**
     * Re-promotes one recorded version's exact payload bytes from private history and moves the
     * pointer onto it. Shared by {@link #rollback} and by the reconciler's repair branch, which differ
     * only in <em>which</em> version they target and in how the commit is audited.
     *
     * <p>Three things have to hold before anything public is written, and all three are checked here:
     * the bytes must exist in private history, they must still checksum to what was recorded for that
     * version, and the object must read back correctly through the public hostname afterwards. A
     * restore therefore cannot introduce content that was never verified, and cannot silently
     * substitute different content for a version number.
     *
     * @param reconciliation {@code null} for an operator rollback; otherwise why the reconciler is
     *                       restoring, which is recorded in the audit entry
     */
    private Outcome restore(UUID tournamentId, String objectKey, PublicSnapshotState.Publication target,
                            String actor, String reconciliation) {
        byte[] payload = store.getPrivate(SnapshotKey.privatePayload(tournamentId, target.version()))
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                "ไม่พบข้อมูลฉบับ " + target.version() + " ในคลังส่วนตัว — ย้อนกลับไม่ได้"));

        String payloadJson = new String(payload, StandardCharsets.UTF_8);
        String checksum = SnapshotJson.checksum(payloadJson);
        if (!checksum.equals(target.checksum()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ข้อมูลฉบับ " + target.version() + " ในคลังส่วนตัวไม่ตรงกับ checksum ที่บันทึกไว้");

        byte[] document = SnapshotJson.envelope(
            new PublicSnapshotEnvelope.Meta(SnapshotJson.SCHEMA, target.version(), Instant.now(),
                checksum, target.payloadBytes(), tournamentId),
            payloadJson).getBytes(StandardCharsets.UTF_8);

        store.putPublic(objectKey, document, SnapshotStorageProperties.PUBLISHED_CACHE_CONTROL, false);
        purge.purge(properties.publicUrl(objectKey));
        verifyThroughPublicHostname(objectKey, document, checksum, true);

        if (reconciliation == null) {
            state.commitPublished(tournamentId, target.version(), checksum, actor);
            return new Outcome(true, target.version(), checksum, objectKey,
                properties.publicUrl(objectKey), "rolled back to version " + target.version());
        }
        state.commitReconciled(tournamentId, target.version(), checksum, actor, reconciliation);
        return new Outcome(true, target.version(), checksum, objectKey, properties.publicUrl(objectKey),
            "restored version " + target.version() + " from private history (" + reconciliation + ")");
    }

    // ------------------------------------------------------------------ verify

    /**
     * Drift detection: compares what the public hostname currently serves against what the database
     * says should be there. Reports; never repairs. Automatic republication could resurrect content a
     * human deliberately changed or withdrew.
     */
    public Outcome verify(UUID tournamentId) {
        PublicSnapshotState.Status status = state.status(tournamentId);
        String objectKey = SnapshotKey.publicObject(status.accessToken());
        if (!PublicSnapshotState.PUBLISHED.equals(status.state()))
            return new Outcome(false, status.version(), status.checksum(), objectKey,
                properties.enabled() ? properties.publicUrl(objectKey) : null,
                "tournament is not published (state " + status.state() + ")");

        PublicSnapshotFetcher.Result response = fetcher.fetch(objectKey, true);
        if (!response.ok())
            return new Outcome(false, status.version(), status.checksum(), objectKey,
                properties.publicUrl(objectKey),
                response.failure() != null ? response.failure() : "HTTP " + response.status());

        // A document that cannot be read is itself drift, and reporting it is this method's whole job —
        // so it is described, not thrown. Throwing would turn a detected problem into a 500.
        Served served = Served.read(response.body());
        boolean matches = served.checksum() != null && served.checksum().equals(status.checksum());
        return new Outcome(matches, status.version(), status.checksum(), objectKey,
            properties.publicUrl(objectKey),
            matches ? "checksum matches" : "checksum drift: serving " + served.describe());
    }

    // ------------------------------------------------------------------ retract

    /**
     * Withdraws the public surface — architecture §4.5, the counterweight to publication.
     *
     * <p>Publication is hard on purpose; retraction is deliberately easy (invariant I9). It needs no
     * approval, no typed acknowledgment and no card preconditions, because the situation it exists
     * for is "this should not be public, now". §7.1's one-object public surface is what makes it
     * complete: a single {@code DeleteObject} removes everything about this tournament that the world
     * can reach.
     *
     * <pre>
     *  1 INTENT   record retracted_by / retracted_at, state unchanged
     *  2 DELETE   DELETE public s/{h}.json           ← the entire public surface
     *  3 PURGE    Cloudflare purge-by-URL (best effort; staleness is bounded by max-age=300)
     *  4 VERIFY   GET the key, cache-busted; expect 404
     *  5 COMMIT   snapshot_state = RETRACTED; audit 'RETRACT_PUBLIC_SNAPSHOT'
     * </pre>
     *
     * <p><b>Once step 2 succeeds the destination is fixed.</b> A failure after the delete never
     * returns the tournament to {@code PUBLISHED} — the bytes are gone, and saying otherwise would be
     * a lie the viewer could disprove. Only a delete that never happened rewinds the intent, which is
     * what makes a refused retraction perfectly retryable.
     *
     * <p><b>Step 4 reports; it does not veto.</b> If an edge is still serving a cached copy, the
     * withdrawal has still happened — §4.5's SLA says exactly this, bounded by {@code max-age=300} —
     * so the state moves and the outcome says the 404 was not confirmed yet. Making the commit
     * conditional on the cache would leave the database claiming something is published that has
     * already been deleted.
     *
     * <p>Deletes nothing from PostgreSQL. Private history is retained for audit and rollback; it was
     * never publicly reachable (§7.1). Tournament data is untouched, as everywhere in this package.
     *
     * <p>Idempotent: retracting an already-retracted tournament re-issues the delete and purge —
     * both no-ops against an absent object — and reports the surface gone.
     */
    public Outcome retract(UUID tournamentId, String actor) {
        requireStorage();
        PublicSnapshotState.Status status = state.status(tournamentId);
        String objectKey = SnapshotKey.publicObject(status.accessToken());
        String publicUrl = properties.publicUrl(objectKey);

        // A publish in flight owns the object key until it finishes. Deleting underneath it would
        // race its promotion and could leave the withdrawn tournament public again; reconcile is the
        // documented way to resolve an attempt that never finished.
        if (PublicSnapshotState.PUBLISHING.equals(status.state()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "กำลังเผยแพร่อยู่ — รอให้รอบนี้เสร็จสิ้น หรือใช้ reconcile ก่อนถอนการเผยแพร่");
        // No publication was ever even attempted, so there is no public surface to withdraw and
        // RETRACTED would permanently block a tournament that never published.
        //
        // The test is the publication HISTORY, not the state column and not the pointer, because
        // both can say "nothing is published" while an object is live: a publish that promotes and
        // then fails its read-back leaves the pointer at 0 and the state at PUBLISH_FAILED with
        // s/{h}.json being served. Refusing to retract that would be exactly backwards — it is the
        // case where withdrawal matters most, and the one G1 blocks the Excel purge over.
        if (state.history(tournamentId).isEmpty()
            && !PublicSnapshotState.RETRACTED.equals(status.state()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ทัวร์นาเมนต์นี้ยังไม่เคยเผยแพร่ — ไม่มีฉบับเผยแพร่ให้ถอน");

        state.beginRetraction(tournamentId, actor);
        try {
            store.deletePublic(objectKey);
        } catch (RuntimeException failure) {
            // Nothing was removed, so nothing changed: rewind the intent and let the caller retry.
            state.abandonRetraction(tournamentId);
            throw failure;
        }

        boolean purged = purge.purge(publicUrl);
        if (!purged && purge.available())
            log.warn("Purge failed for retracted {}; staleness is bounded by max-age", objectKey);

        PublicSnapshotFetcher.Result probe = fetcher.fetch(objectKey, true);
        boolean gone = probe.failure() == null && probe.status() == 404;

        state.commitRetracted(tournamentId, actor,
            "version " + status.version() + " withdrawn from " + objectKey
                + (gone ? "; verified 404" : "; 404 not yet observed"));

        return new Outcome(gone, status.version(), status.checksum(), objectKey, publicUrl,
            gone ? "retracted; the public object is gone (verified 404)"
                : "retracted and recorded, but the public hostname has not returned 404 yet — "
                    + "browser copies expire within max-age=300 ("
                    + (probe.failure() != null ? probe.failure() : "HTTP " + probe.status()) + ")");
    }

    /**
     * The no-resurrection rule (§4.5): once withdrawn, nothing in this class may put those bytes back.
     *
     * <p>Applied to every operation that can write the public object — publish (through
     * {@code beginPublishing}), rollback, and reconcile — because a guard on only some of them is not
     * a guard at all. Approval refuses a retracted tournament too, so the pipeline cannot be
     * re-entered from the front either.
     */
    private void requireNotRetracted(String snapshotState, UUID tournamentId) {
        if (PublicSnapshotState.RETRACTED.equals(snapshotState))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ฉบับเผยแพร่นี้ถูกถอนแล้ว — ต้องขออนุมัติใหม่ก่อนเผยแพร่อีกครั้ง "
                    + "(tournament " + tournamentId + ")");
    }

    // ------------------------------------------------------------------ reconcile

    /**
     * Converges the database onto what the public hostname is actually serving — architecture §7.3,
     * row "promoted but the DB commit fails".
     *
     * <p>The pipeline's last three steps are promote (6), re-verify (8) and commit (9). A process that
     * dies between 6 and 9 leaves the new bytes public while the database still names the previous
     * version, or none at all. Nothing detects that by itself: {@link #verify} reports it, and this is
     * the operation that resolves it.
     *
     * <pre>
     *  observe   GET the public object through the public hostname, cache-busted
     *
     *  A  served version has a recorded publication row whose checksum equals the served payload's,
     *     and is not older than the pointer
     *       → COMPLETE THE COMMIT. Those bytes were read back and checksum-verified through the
     *         public hostname at step 4 before they were promoted, and have just been verified
     *         again. Nothing is uploaded; only bookkeeping moves.
     *
     *  B  otherwise, and something IS being served
     *       → RESTORE the pointer's own version from private history (§7.3 "re-promote v/{n-1}"),
     *         checksum-guarded and read back afterwards, exactly as {@link #rollback} does.
     *
     *  C  otherwise, or nothing is being served
     *       → REPORT and mark PUBLISH_FAILED (§6.5). Never re-create an absent object: an absent
     *         object is also what a retraction looks like, and no repair job may resurrect data a
     *         human withdrew.
     * </pre>
     *
     * <p>Three things it deliberately cannot do. It never <b>builds</b> a snapshot, so it cannot
     * publish content the approver never saw — every byte it can write comes from private history and
     * must match a recorded checksum first. It never <b>deletes</b> the public object. And it never
     * touches tournament data, like everything else in this package.
     *
     * <p>Idempotent by construction: each branch ends with the database and the public object in
     * agreement, so a second run observes agreement and writes nothing.
     */
    public Outcome reconcile(UUID tournamentId, String actor) {
        requireStorage();
        PublicSnapshotState.Status status = state.status(tournamentId);
        String objectKey = SnapshotKey.publicObject(status.accessToken());
        String publicUrl = properties.publicUrl(objectKey);
        long pointer = status.version();

        requireNotRetracted(status.state(), tournamentId);

        PublicSnapshotFetcher.Result response = fetcher.fetch(objectKey, true);
        boolean absent = response.failure() == null && response.status() == 404;
        if (!response.ok() && !absent)
            // A transport error or a 5xx proves nothing about the object. Guessing here would let a
            // network blip mark a perfectly healthy tournament as failed.
            return new Outcome(false, pointer, status.checksum(), objectKey, publicUrl,
                "inconclusive: could not read " + objectKey + " ("
                    + (response.failure() != null ? response.failure() : "HTTP " + response.status()) + ")");

        // A retraction that recorded its intent and then stopped. The object is gone, which is what
        // was asked for, so this finishes the transition rather than reporting a mystery — the
        // failure case the plan names for Phase F. Without the intent marker these two branches are
        // indistinguishable, which is precisely why it exists.
        Optional<PublicSnapshotState.Retraction> retraction = state.retraction(tournamentId);
        if (retraction.isPresent() && !retraction.get().complete()) {
            if (absent) {
                state.commitRetracted(tournamentId, actor,
                    "completed an interrupted retraction begun by " + retraction.get().retractedBy());
                return new Outcome(true, pointer, status.checksum(), objectKey, publicUrl,
                    "completed an interrupted retraction: the public object is gone, state -> RETRACTED");
            }
            // Intent recorded but the object is still there: the delete never took. Repeating it is
            // retract's job, not the reconciler's — withdrawing data is an attributable act, and a
            // repair job must not be able to delete a public object on its own initiative.
            return new Outcome(false, pointer, status.checksum(), objectKey, publicUrl,
                "a retraction begun by " + retraction.get().retractedBy()
                    + " never removed " + objectKey + " — run retract again");
        }

        if (absent) {
            if (pointer == 0) {
                if (PublicSnapshotState.NOT_PUBLISHED.equals(status.state())
                    || PublicSnapshotState.PUBLISH_FAILED.equals(status.state()))
                    return new Outcome(true, 0, status.checksum(), objectKey, publicUrl,
                        "consistent: nothing is published and nothing is served");
                // An attempt that died before it promoted anything. PUBLISH_FAILED is what the
                // pipeline's own failure path would have recorded had the process survived to run it,
                // so this resolves a stuck PUBLISHING without inventing a timeout.
                state.markPublishFailed(tournamentId,
                    "an attempt left state " + status.state() + " with nothing promoted", actor);
                return new Outcome(true, 0, status.checksum(), objectKey, publicUrl,
                    "resolved an abandoned attempt: " + status.state()
                        + " -> PUBLISH_FAILED; nothing was ever public");
            }
            state.markPublishFailed(tournamentId,
                "nothing is served at " + objectKey + " but the pointer names version " + pointer, actor);
            return new Outcome(false, pointer, status.checksum(), objectKey, publicUrl,
                "divergence: nothing is served at " + objectKey + " while the database names version "
                    + pointer + "; marked PUBLISH_FAILED — republish or roll back deliberately");
        }

        Served served = Served.read(response.body());
        Optional<PublicSnapshotState.Publication> recorded = served.version() == null
            ? Optional.empty()
            : state.publication(tournamentId, served.version());
        boolean verifiedBytes = recorded.isPresent()
            && recorded.get().checksum() != null && !recorded.get().checksum().isBlank()
            && recorded.get().checksum().equals(served.checksum());

        // A — the served object is a recorded, verified version at or ahead of the pointer.
        if (verifiedBytes && served.version() >= pointer) {
            if (PublicSnapshotState.PUBLISHED.equals(status.state())
                && served.version() == pointer && served.checksum().equals(status.checksum()))
                return new Outcome(true, pointer, status.checksum(), objectKey, publicUrl,
                    "consistent: version " + pointer + " is served and recorded");

            state.commitReconciled(tournamentId, served.version(), served.checksum(), actor,
                "object was already promoted and verified; state was " + status.state()
                    + ", pointer was " + pointer);
            return new Outcome(true, served.version(), served.checksum(), objectKey, publicUrl,
                "completed the commit for version " + served.version() + " (was " + status.state()
                    + " at version " + pointer + ")");
        }

        // B — something else is being served. Put the pointer's own verified bytes back.
        Optional<PublicSnapshotState.Publication> pointerRow =
            pointer > 0 ? state.publication(tournamentId, pointer) : Optional.empty();
        if (pointerRow.isPresent())
            return restore(tournamentId, objectKey, pointerRow.get(), actor,
                "served " + served.describe() + " did not match the pointer");

        // C — nothing recorded to restore. Report; do not delete, and do not build a replacement.
        state.markPublishFailed(tournamentId,
            "served " + served.describe() + " at " + objectKey + " matches no recorded publication, "
                + "and there is no earlier version to restore", actor);
        return new Outcome(false, pointer, status.checksum(), objectKey, publicUrl,
            "divergence: " + objectKey + " serves " + served.describe()
                + ", which matches no recorded publication, and no earlier version exists to restore; "
                + "marked PUBLISH_FAILED — resolve by hand");
    }

    /** What the public hostname is currently serving, as far as it can be read. */
    private record Served(Long version, String checksum) {

        static Served read(byte[] body) {
            try {
                String document = new String(body, StandardCharsets.UTF_8);
                return new Served(SnapshotJson.versionOf(document),
                    SnapshotJson.checksum(SnapshotJson.payloadOf(document)));
            } catch (RuntimeException unreadable) {
                // Not a snapshot document at all: it matches nothing, which is the right answer.
                return new Served(null, null);
            }
        }

        String describe() {
            return version == null ? "an unreadable object" : "version " + version + " " + checksum;
        }
    }

    // ------------------------------------------------------------------ internals

    /** The complete document as it is stored: envelope metadata wrapped around the payload. */
    private byte[] document(PublicSnapshotArtifact artifact, long version) {
        return SnapshotJson.envelope(
            new PublicSnapshotEnvelope.Meta(SnapshotJson.SCHEMA, version, Instant.now(),
                artifact.checksum(), artifact.payloadBytes(), artifact.payload().id()),
            artifact.payloadJson()).getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Private-only provenance for one version: which tournament, which token, which bytes, who.
     * Never public — it deliberately records the access token and the tournament name, which the
     * published payload does not carry.
     */
    private static String manifest(PublicSnapshotState.Status status, long version,
                                   PublicSnapshotArtifact artifact, String actor) {
        return SnapshotJson.canonical(new Manifest(status.tournamentId(), status.name(),
            status.accessToken(), version, artifact.checksum(), artifact.payloadBytes(),
            SnapshotKey.publicObject(status.accessToken()), actor, Instant.now(), SnapshotJson.SCHEMA));
    }

    private record Manifest(UUID tournamentId, String tournamentName, String accessToken, long version,
                            String checksum, long payloadBytes, String publicObjectKey, String actor,
                            Instant generatedAt, int schema) {}

    /**
     * Reads an object back over HTTPS and proves it is byte-for-byte what was uploaded.
     *
     * <p>Three independent checks, because they fail for different reasons: the status catches DNS,
     * routing and bucket-policy problems; the length catches truncation; the checksum catches
     * corruption and — with {@code cacheBust} — a stale edge answering for an object that was just
     * replaced.
     */
    private void verifyThroughPublicHostname(String key, byte[] expected, String expectedChecksum, boolean cacheBust) {
        PublicSnapshotFetcher.Result response = fetcher.fetch(key, cacheBust);
        if (!response.ok())
            throw new IllegalStateException("Read-back of " + key + " failed: "
                + (response.failure() != null ? response.failure() : "HTTP " + response.status()));
        if (response.contentLength() >= 0 && response.contentLength() != expected.length)
            throw new IllegalStateException("Read-back of " + key + " declared " + response.contentLength()
                + " bytes, expected " + expected.length);
        if (response.body().length != expected.length)
            throw new IllegalStateException("Read-back of " + key + " returned " + response.body().length
                + " bytes, expected " + expected.length);

        String servedChecksum = SnapshotJson.checksum(SnapshotJson.payloadOf(new String(response.body(), StandardCharsets.UTF_8)));
        if (!servedChecksum.equals(expectedChecksum))
            throw new IllegalStateException("Read-back of " + key + " has checksum " + servedChecksum
                + ", expected " + expectedChecksum);
        if (!Arrays.equals(response.body(), expected))
            throw new IllegalStateException("Read-back of " + key + " differs from the uploaded bytes");
    }

    private void safeDeleteStaging(String staging) {
        try {
            if (store.available()) store.deletePublic(staging);
        } catch (RuntimeException ignored) {
            // A staging object is no-store and noindex; leaving one behind costs nothing.
        }
    }

    private void requireStorage() {
        if (!store.available() || !fetcher.available())
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Public Snapshot storage is not configured (app.snapshot-storage.*)");
    }

    /** Exposed for the status endpoint so an operator can see whether publication is possible at all. */
    public boolean storageAvailable() {
        return store.available() && fetcher.available();
    }

    public Optional<String> publicUrlFor(String accessToken) {
        return properties.enabled()
            ? Optional.of(properties.publicUrl(SnapshotKey.publicObject(accessToken)))
            : Optional.empty();
    }
}
