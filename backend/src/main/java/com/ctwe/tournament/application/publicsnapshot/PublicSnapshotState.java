package com.ctwe.tournament.application.publicsnapshot;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * All PostgreSQL bookkeeping for Public Snapshot publication — and nothing else.
 *
 * <p>Deliberately separate from {@link PublicSnapshotPublisher}. The pipeline makes network calls to
 * R2 and Cloudflare between its database steps; if those steps shared one transaction, a row lock
 * would be held across the network for the duration of a publish. Splitting them keeps every
 * transaction short and lets the publisher stay non-transactional, which in turn lets
 * {@link PublicSnapshotBuilder} run in its own read-only {@code REPEATABLE_READ} transaction rather
 * than silently joining a read-write one.
 *
 * <p><b>Writes only its own bookkeeping.</b> Every statement here targets {@code tournaments}'
 * snapshot columns or {@code public_snapshot_publications}. Nothing in this class — or anywhere in
 * the publication path — touches {@code tournament_cards}, {@code players}, {@code matches},
 * {@code standings}, {@code games}, {@code pairing_snapshots} or {@code final_*}. That is what keeps
 * every published snapshot regenerable from PostgreSQL.
 *
 * <p>Approval bookkeeping is next door in {@link SnapshotApprovalService}, which owns
 * {@code public_snapshot_approvals} and is the only other writer of {@code snapshot_state} — and
 * only ever between {@code NOT_PUBLISHED} and {@code APPROVED}. The pointer, the checksum and
 * {@code published_at} are written here and nowhere else. The dependency runs one way: this class
 * asks the approval service whether a publication may begin.
 */
@Service
public class PublicSnapshotState {

    /** The lifecycle values the column permits. Phase B reaches four of the six. */
    public static final String NOT_PUBLISHED = "NOT_PUBLISHED";
    public static final String PUBLISHING = "PUBLISHING";
    public static final String PUBLISHED = "PUBLISHED";
    public static final String PUBLISH_FAILED = "PUBLISH_FAILED";
    /** Phase E assigns this; Phase B neither sets nor requires it. */
    public static final String APPROVED = "APPROVED";
    /** Phase F assigns this; Phase B never sets it, but must refuse to publish over it. */
    public static final String RETRACTED = "RETRACTED";

    private final JdbcTemplate jdbc;
    private final SnapshotApprovalService approvals;

    public PublicSnapshotState(JdbcTemplate jdbc, SnapshotApprovalService approvals) {
        this.jdbc = jdbc;
        this.approvals = approvals;
    }

    /** A tournament's publication state as an operator (or the pipeline) sees it. */
    public record Status(
        UUID tournamentId,
        String name,
        String accessToken,
        String state,
        long version,
        Instant publishedAt,
        String checksum,
        String objectKey,
        int cardCount,
        int unfinishedCardCount
    ) {}

    /** One recorded publication attempt. */
    public record Publication(long version, String checksum, long payloadBytes, String objectKey,
                              String status, String failureReason, String actor, Instant createdAt) {}

    @Transactional(readOnly = true)
    public Status status(UUID tournamentId) {
        try {
            return jdbc.queryForObject("""
                SELECT t.id, t.name, t.access_token, t.snapshot_state, t.snapshot_version,
                       t.published_at, t.snapshot_checksum,
                       (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id) AS card_count,
                       (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id
                            AND c.status NOT IN ('FINISHED', 'CLOSED')) AS unfinished_card_count
                FROM tournaments t WHERE t.id = ?
                """, (rs, row) -> {
                String accessToken = rs.getString("access_token");
                var publishedAt = rs.getTimestamp("published_at");
                return new Status(
                    rs.getObject("id", UUID.class), rs.getString("name"), accessToken,
                    rs.getString("snapshot_state"), rs.getLong("snapshot_version"),
                    publishedAt == null ? null : publishedAt.toInstant(),
                    rs.getString("snapshot_checksum"), SnapshotKey.publicObject(accessToken),
                    rs.getInt("card_count"), rs.getInt("unfinished_card_count"));
            }, tournamentId);
        } catch (EmptyResultDataAccessException notFound) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบทัวร์นาเมนต์");
        }
    }

    /**
     * Claims the next version under a row lock and moves the tournament to {@code PUBLISHING}.
     *
     * <p>The lock plus the state transition together are the concurrency control: a second publish
     * blocks on the lock, then sees {@code PUBLISHING} and is refused.
     *
     * <p>Two different numbers are deliberately kept apart:
     * <ul>
     *   <li>{@code tournaments.snapshot_version} is the <b>pointer</b> — the version currently served
     *       at {@code s/&#123;h&#125;.json}. It is written only by {@link #commitPublished}, after the
     *       bytes have been verified through the public hostname, so it can never name an object
     *       nobody proved was there.</li>
     *   <li>The high-water mark across {@code public_snapshot_publications} is the <b>allocator</b>.
     *       Versions only ever increase from it, so a failed attempt burns its number permanently
     *       rather than letting a later attempt reuse it and collide with the failure it recorded.</li>
     * </ul>
     *
     * @return the claimed version number
     */
    @Transactional
    public long beginPublishing(UUID tournamentId) {
        Status locked = lock(tournamentId);

        if (PUBLISHING.equals(locked.state()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "กำลังเผยแพร่อยู่แล้ว — รอให้รอบก่อนหน้าเสร็จสิ้นก่อน");
        if (RETRACTED.equals(locked.state()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ฉบับเผยแพร่นี้ถูกถอนแล้ว — ต้องขออนุมัติใหม่ก่อนเผยแพร่อีกครั้ง");
        // A retraction whose intent is recorded but whose state has not moved yet is still a
        // retraction: someone has asked for this data to come down. Publishing into that window
        // would race the deletion and could leave the withdrawn tournament public again (§4.5).
        if (retraction(tournamentId).isPresent())
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "มีการถอนการเผยแพร่ค้างอยู่ — ตรวจสอบด้วย reconcile ก่อนเผยแพร่ใหม่");
        if (locked.cardCount() == 0)
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ทัวร์นาเมนต์นี้ยังไม่มีการ์ด — ไม่มีอะไรให้เผยแพร่");
        if (locked.unfinishedCardCount() > 0)
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ยังมีการ์ดที่ยังไม่จบ " + locked.unfinishedCardCount() + " ใบ — "
                    + "ต้องให้ทุกการ์ดอยู่ในสถานะ FINISHED หรือ CLOSED ก่อนเผยแพร่");

        // Phase E (§4.1, §4.3). Checked HERE, inside the row lock, rather than at the controller:
        // between an HTTP-layer check and this claim an approval could be revoked or a card edited,
        // and the whole point of the approval is that what gets published is what someone approved.
        // It is also the last precondition, so an unapprovable tournament is refused for the reason
        // an operator can act on — finish the cards first — before being told to seek approval.
        approvals.requireValidApproval(tournamentId);

        Long highWater = jdbc.queryForObject("""
            SELECT GREATEST(t.snapshot_version,
                            COALESCE((SELECT MAX(p.version) FROM public_snapshot_publications p
                                      WHERE p.tournament_id = t.id), 0))
            FROM tournaments t WHERE t.id = ?
            """, Long.class, tournamentId);
        long next = (highWater == null ? 0 : highWater) + 1;

        // Only the state moves here. The pointer stays on whatever is actually public until step 9.
        jdbc.update("UPDATE tournaments SET snapshot_state = ? WHERE id = ?", PUBLISHING, tournamentId);
        return next;
    }

    /** Records a candidate that was uploaded and verified through the public hostname. */
    @Transactional
    public void recordVerified(UUID tournamentId, long version, String checksum, long payloadBytes,
                               String objectKey, String actor) {
        jdbc.update("""
            INSERT INTO public_snapshot_publications
                (tournament_id, version, checksum, payload_bytes, object_key, status, actor)
            VALUES (?, ?, ?, ?, ?, 'VERIFIED', ?)
            """, tournamentId, version, checksum, payloadBytes, objectKey, actor);
    }

    /**
     * The commit that makes a version the current public one.
     *
     * <p>Reached only after the bytes have been fetched back through the public hostname and their
     * checksum re-derived, so the recorded pointer can never name an unverified object.
     */
    @Transactional
    public void commitPublished(UUID tournamentId, long version, String checksum, String actor) {
        promote(tournamentId, version, checksum);
        audit(tournamentId, actor, "PUBLISH_PUBLIC_SNAPSHOT", "version " + version + " " + checksum);
    }

    /**
     * The same commit, reached by reconciliation rather than by a publish (architecture §7.3).
     *
     * <p>Written identically — the pointer must mean one thing however it got there — but audited
     * under its own action so an operator can tell a repair from a publication when reading the log.
     */
    @Transactional
    public void commitReconciled(UUID tournamentId, long version, String checksum, String actor, String detail) {
        promote(tournamentId, version, checksum);
        audit(tournamentId, actor, "RECONCILE_PUBLIC_SNAPSHOT",
            "version " + version + " " + checksum + " — " + detail);
    }

    /** A recorded retraction: intent (always) plus completion (once the state has moved). */
    public record Retraction(String retractedBy, Instant retractedAt, boolean complete) {}

    /**
     * The retraction recorded against this tournament, if any.
     *
     * <p>{@code complete} distinguishes the two situations the reconciler must tell apart: intent
     * recorded but the public object not yet confirmed gone, versus a finished withdrawal.
     */
    @Transactional(readOnly = true)
    public Optional<Retraction> retraction(UUID tournamentId) {
        return jdbc.query("""
            SELECT retracted_by, retracted_at, snapshot_state FROM tournaments
            WHERE id = ? AND retracted_at IS NOT NULL
            """, (rs, row) -> new Retraction(rs.getString("retracted_by"),
                rs.getTimestamp("retracted_at").toInstant(),
                RETRACTED.equals(rs.getString("snapshot_state"))),
            tournamentId).stream().findFirst();
    }

    /**
     * Records the <b>intent</b> to retract, before the public object is deleted.
     *
     * <p>Deliberately does not move {@code snapshot_state}: until the object is actually gone, the
     * tournament is still published and saying otherwise would misdescribe what the world can see.
     * What this does buy is the ability to finish: a process that dies mid-retraction leaves a
     * missing object plus this marker, and {@code PublicSnapshotPublisher.reconcile} can then
     * complete the withdrawal instead of mistaking it for a lost object.
     */
    @Transactional
    public void beginRetraction(UUID tournamentId, String actor) {
        // Only the FIRST intent is recorded. Retraction is idempotent, and a repeat run must not
        // rewrite who withdrew the data — that attribution is what the audit trail is for.
        jdbc.update("""
            UPDATE tournaments SET retracted_by = ?, retracted_at = now()
            WHERE id = ? AND retracted_at IS NULL
            """, actor, tournamentId);
    }

    /**
     * Withdraws the intent again, for the one case where that is honest: the public object was never
     * deleted, so nothing about the tournament changed and a retry should start from scratch.
     *
     * <p>Never called once a delete has succeeded — after that the only correct destination is
     * {@code RETRACTED}, however the rest of the attempt goes.
     */
    @Transactional
    public void abandonRetraction(UUID tournamentId) {
        jdbc.update("UPDATE tournaments SET retracted_by = NULL, retracted_at = NULL WHERE id = ?",
            tournamentId);
    }

    /**
     * Completes a retraction: the public object is gone, so the state says so (architecture §4.5).
     *
     * <p>{@code snapshot_version}, {@code snapshot_checksum} and {@code published_at} are deliberately
     * left as they were. They are the record of what <em>was</em> published, which is exactly what an
     * audit needs after a withdrawal, and the private history they name is retained too (§7.1). The
     * pointer stops meaning "this is being served" only because {@code RETRACTED} says nothing is.
     */
    @Transactional
    public void commitRetracted(UUID tournamentId, String actor, String detail) {
        jdbc.update("""
            UPDATE tournaments SET snapshot_state = ?,
                   retracted_by = COALESCE(retracted_by, ?), retracted_at = COALESCE(retracted_at, now())
            WHERE id = ?
            """, RETRACTED, actor, tournamentId);
        audit(tournamentId, actor, "RETRACT_PUBLIC_SNAPSHOT", detail);
    }

    /**
     * Records divergence that must not be repaired automatically (architecture §6.5).
     *
     * <p>The pointer and the checksum are deliberately left alone: they still record which version was
     * verified and promoted, which is exactly what an operator needs in order to decide what to do.
     * Only the state moves, so the tournament stops looking healthy.
     */
    @Transactional
    public void markPublishFailed(UUID tournamentId, String reason, String actor) {
        jdbc.update("UPDATE tournaments SET snapshot_state = ? WHERE id = ?", PUBLISH_FAILED, tournamentId);
        audit(tournamentId, actor, "RECONCILE_PUBLIC_SNAPSHOT_FAILED", reason);
    }

    private void promote(UUID tournamentId, long version, String checksum) {
        jdbc.update("""
            UPDATE tournaments
            SET snapshot_state = ?, snapshot_version = ?, snapshot_checksum = ?, published_at = now()
            WHERE id = ?
            """, PUBLISHED, version, checksum, tournamentId);
        jdbc.update("""
            UPDATE public_snapshot_publications SET status = 'PROMOTED'
            WHERE tournament_id = ? AND version = ?
            """, tournamentId, version);
    }

    /**
     * Abandons an attempt.
     *
     * <p>{@code snapshot_version} and {@code snapshot_checksum} are deliberately <b>not</b> touched:
     * they were never moved off the last promoted version, so they already describe exactly what is
     * public. Only the state returns — to {@code PUBLISHED} when something was previously promoted
     * and is still being served, or {@code PUBLISH_FAILED} when nothing ever was.
     *
     * <p>The burned version is recorded as {@code FAILED} so the allocator can never hand it out
     * again, which is what keeps one version number bound to at most one set of bytes.
     */
    @Transactional
    public void failPublishing(UUID tournamentId, long version, String reason, String actor) {
        jdbc.update("UPDATE tournaments SET snapshot_state = ? WHERE id = ?",
            lastPromoted(tournamentId).isPresent() ? PUBLISHED : PUBLISH_FAILED, tournamentId);
        jdbc.update("""
            INSERT INTO public_snapshot_publications
                (tournament_id, version, checksum, payload_bytes, object_key, status, failure_reason, actor)
            VALUES (?, ?, '', 0, '', 'FAILED', ?, ?)
            ON CONFLICT (tournament_id, version) DO UPDATE
              SET status = 'FAILED', failure_reason = EXCLUDED.failure_reason
            """, tournamentId, version, reason, actor);
        audit(tournamentId, actor, "PUBLISH_PUBLIC_SNAPSHOT_FAILED", "version " + version + ": " + reason);
    }

    @Transactional(readOnly = true)
    public Optional<Publication> lastPromoted(UUID tournamentId) {
        return jdbc.query("""
            SELECT version, checksum, payload_bytes, object_key, status, failure_reason, actor, created_at
            FROM public_snapshot_publications
            WHERE tournament_id = ? AND status = 'PROMOTED'
            ORDER BY version DESC LIMIT 1
            """, PublicSnapshotState::mapPublication, tournamentId).stream().findFirst();
    }

    /**
     * The recorded attempt for one exact version, whatever became of it.
     *
     * <p>The reconciler needs the {@code FAILED} rows too: a publish that promoted its object and then
     * failed on the read-back records the checksum it verified at step 5 and only afterwards marks the
     * row {@code FAILED}, so that row is the evidence that the bytes now sitting at
     * {@code s/&#123;h&#125;.json} were verified through the public hostname before they were promoted.
     */
    @Transactional(readOnly = true)
    public Optional<Publication> publication(UUID tournamentId, long version) {
        return jdbc.query("""
            SELECT version, checksum, payload_bytes, object_key, status, failure_reason, actor, created_at
            FROM public_snapshot_publications WHERE tournament_id = ? AND version = ?
            """, PublicSnapshotState::mapPublication, tournamentId, version).stream().findFirst();
    }

    /** The version to roll back TO: the most recent promoted one that is not the current pointer. */
    @Transactional(readOnly = true)
    public Optional<Publication> previousPromoted(UUID tournamentId, long currentVersion) {
        return jdbc.query("""
            SELECT version, checksum, payload_bytes, object_key, status, failure_reason, actor, created_at
            FROM public_snapshot_publications
            WHERE tournament_id = ? AND status = 'PROMOTED' AND version < ?
            ORDER BY version DESC LIMIT 1
            """, PublicSnapshotState::mapPublication, tournamentId, currentVersion).stream().findFirst();
    }

    @Transactional(readOnly = true)
    public List<Publication> history(UUID tournamentId) {
        return jdbc.query("""
            SELECT version, checksum, payload_bytes, object_key, status, failure_reason, actor, created_at
            FROM public_snapshot_publications WHERE tournament_id = ? ORDER BY version DESC
            """, PublicSnapshotState::mapPublication, tournamentId);
    }

    private Status lock(UUID tournamentId) {
        // Serializes concurrent publishes for THIS tournament only; other tournaments are unaffected.
        List<UUID> locked = jdbc.queryForList(
            "SELECT id FROM tournaments WHERE id = ? FOR UPDATE", UUID.class, tournamentId);
        if (locked.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบทัวร์นาเมนต์");
        return status(tournamentId);
    }

    private void audit(UUID tournamentId, String actor, String action, String detail) {
        jdbc.update("INSERT INTO audit_logs (card_id, actor, action, old_value, new_value) VALUES (NULL, ?, ?, NULL, ?)",
            actor, action, "tournament " + tournamentId + " " + detail);
    }

    private static Publication mapPublication(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new Publication(rs.getLong("version"), rs.getString("checksum"), rs.getLong("payload_bytes"),
            rs.getString("object_key"), rs.getString("status"), rs.getString("failure_reason"),
            rs.getString("actor"), rs.getTimestamp("created_at").toInstant());
    }
}
