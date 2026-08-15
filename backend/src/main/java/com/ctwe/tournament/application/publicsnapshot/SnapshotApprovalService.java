package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.infrastructure.security.ReauthenticationService;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Publication approval — architecture §4.1–§4.4, the first half of the deliberately two-step
 * lifecycle.
 *
 * <p>Publishing a snapshot puts competitors' real names and school affiliations on a public CDN
 * permanently, and some of those competitors are minors. That is not a decision a storage operation
 * should be able to make on its own, so it is split in two: a human approves, naming the tournament
 * and re-entering their password against a typed acknowledgment, and only then may a separate
 * publish operation run. Nothing here uploads anything.
 *
 * <p><b>The approval record is the authority, not the state column.</b> {@code snapshot_state} shows
 * {@code APPROVED} for an operator's benefit, but {@link #requireValidApproval} answers from this
 * table every time, under the publishing row lock. A state column that drifted could authorize a
 * publication; a row that is checked at the moment of use cannot.
 *
 * <p>An approval stops authorizing for four distinct reasons, and each one is reported separately
 * because they need different fixes: none was ever given, it was revoked, it expired, or the content
 * changed underneath it. The last is the subtle one — see {@link #fingerprint}.
 *
 * <p><b>Writes only approval bookkeeping.</b> This class inserts into
 * {@code public_snapshot_approvals} and moves {@code tournaments.snapshot_state} between
 * {@code NOT_PUBLISHED} and {@code APPROVED}. It never writes the pointer, the checksum or
 * {@code published_at} — those belong to {@link PublicSnapshotState} — and, like everything in this
 * package, it never touches tournament data. Approving is a read of the cards, never a write.
 */
@Service
public class SnapshotApprovalService {

    /**
     * Which revision of the §4.4 acknowledgment text is current. A client must echo this back when
     * approving; a mismatch means it rendered older wording, and the consent it collected is not the
     * consent this system would record. Bump it whenever that text changes materially.
     */
    public static final short ACKNOWLEDGMENT_REV = 1;

    /** Architecture §4.3. An approval is a snapshot of a human's judgment, and judgment goes stale. */
    public static final Duration VALIDITY = Duration.ofDays(7);

    private final JdbcTemplate jdbc;
    private final AuthorizationService authorization;
    private final ReauthenticationService reauthentication;

    public SnapshotApprovalService(JdbcTemplate jdbc, AuthorizationService authorization,
                                   ReauthenticationService reauthentication) {
        this.jdbc = jdbc;
        this.authorization = authorization;
        this.reauthentication = reauthentication;
    }

    /** What an operator typed to approve: password re-auth, the tournament's name, the ack revision. */
    public record ApprovalRequest(String password, String tournamentName, Short acknowledgmentRev) {}

    /** One approval record, however it ended up. */
    public record Approval(UUID id, UUID tournamentId, String approvedBy, Instant approvedAt,
                           short acknowledgmentRev, String contentFingerprint, Instant expiresAt,
                           Instant revokedAt, String revokedBy) {

        public boolean revoked() {
            return revokedAt != null;
        }

        public boolean expired(Instant now) {
            return !expiresAt.isAfter(now);
        }
    }

    /** Why publication is or is not currently authorized — the status endpoint's approval half. */
    public record ApprovalStatus(boolean valid, String reason, String approvedBy, Instant approvedAt,
                                 Instant expiresAt, short acknowledgmentRev, String contentFingerprint,
                                 String currentFingerprint, short currentAcknowledgmentRev) {}

    // ------------------------------------------------------------------ approve

    /**
     * Records an approval after checking every gate the architecture puts in front of it.
     *
     * <p>Order matters: authorization, then the state machine, then the typed name, then the
     * acknowledgment revision, and the password last. Re-authentication is the expensive check and
     * the one that must not become an oracle — an operator who is not allowed near this tournament
     * should be refused before their password is ever compared.
     */
    @Transactional
    public Approval approve(UUID tournamentId, Authentication auth, ApprovalRequest request) {
        String name = requireApprovableTournament(tournamentId, auth);

        String typed = request == null || request.tournamentName() == null
            ? "" : request.tournamentName().trim();
        if (!typed.equals(name.trim()))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "ชื่อทัวร์นาเมนต์ที่ยืนยันไม่ตรงกับรายการที่เลือก");

        if (request.acknowledgmentRev() == null || request.acknowledgmentRev() != ACKNOWLEDGMENT_REV)
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ข้อความยินยอมมีการปรับปรุง — โปรดโหลดหน้าใหม่แล้วอ่านฉบับล่าสุดก่อนอนุมัติ");

        reauthentication.requireCurrentPassword(auth, request.password());

        String actor = auth.getName();
        String fingerprint = fingerprint(tournamentId);
        Instant approvedAt = Instant.now();
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO public_snapshot_approvals
                (id, tournament_id, approved_by, approved_at, acknowledgment_rev,
                 content_fingerprint, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """, id, tournamentId, actor, java.sql.Timestamp.from(approvedAt), ACKNOWLEDGMENT_REV,
            fingerprint, java.sql.Timestamp.from(approvedAt.plus(VALIDITY)));

        // The state column follows the approval only where the lifecycle diagram (§4.1) has an arrow
        // for it. A PUBLISHED tournament being re-approved keeps saying PUBLISHED, because something
        // IS public and the pointer still describes it; the approval row is what authorizes the
        // republication. PUBLISHING is refused above, so it can never be overwritten here.
        jdbc.update("""
            UPDATE tournaments SET snapshot_state = ?
            WHERE id = ? AND snapshot_state IN (?, ?)
            """, PublicSnapshotState.APPROVED, tournamentId,
            PublicSnapshotState.NOT_PUBLISHED, PublicSnapshotState.PUBLISH_FAILED);

        audit(tournamentId, actor, "APPROVE_PUBLIC_SNAPSHOT",
            "acknowledgment rev " + ACKNOWLEDGMENT_REV + ", fingerprint " + fingerprint
                + ", expires " + approvedAt.plus(VALIDITY));
        return latest(tournamentId).orElseThrow();
    }

    /**
     * Withdraws the current approval. Publication becomes impossible again until someone approves
     * afresh; anything already published is untouched, because withdrawing permission to publish is
     * not the same act as withdrawing what was published (that is retraction, §4.5).
     */
    @Transactional
    public void revoke(UUID tournamentId, Authentication auth) {
        requireTournament(tournamentId, auth);
        Approval current = latest(tournamentId)
            .filter(approval -> !approval.revoked())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                "ไม่มีคำอนุมัติที่ใช้งานอยู่"));

        String actor = auth.getName();
        jdbc.update("""
            UPDATE public_snapshot_approvals SET revoked_at = now(), revoked_by = ?
            WHERE id = ? AND revoked_at IS NULL
            """, actor, current.id());
        jdbc.update("UPDATE tournaments SET snapshot_state = ? WHERE id = ? AND snapshot_state = ?",
            PublicSnapshotState.NOT_PUBLISHED, tournamentId, PublicSnapshotState.APPROVED);
        audit(tournamentId, actor, "REVOKE_PUBLIC_SNAPSHOT",
            "approval " + current.id() + " by " + current.approvedBy());
    }

    // ------------------------------------------------------------------ the publication gate

    /**
     * The gate {@link PublicSnapshotState#beginPublishing} calls, inside the row lock it already
     * holds. Being inside that lock is what makes the answer trustworthy: an approval cannot be
     * revoked, nor the content changed, between this check and the claim it authorizes.
     *
     * @throws ResponseStatusException 409, naming which of the four reasons applies
     */
    public void requireValidApproval(UUID tournamentId) {
        Approval approval = latest(tournamentId).orElseThrow(() -> new ResponseStatusException(
            HttpStatus.CONFLICT, "ต้องได้รับการอนุมัติก่อนเผยแพร่ — ยังไม่มีการอนุมัติสำหรับทัวร์นาเมนต์นี้"));

        if (approval.revoked())
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "คำอนุมัติถูกเพิกถอนแล้ว — ต้องขออนุมัติใหม่ก่อนเผยแพร่");
        if (approval.expired(Instant.now()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "คำอนุมัติหมดอายุแล้ว (มีอายุ " + VALIDITY.toDays() + " วัน) — ต้องขออนุมัติใหม่ก่อนเผยแพร่");

        String current = fingerprint(tournamentId);
        if (!current.equals(approval.contentFingerprint()))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ข้อมูลการ์ดเปลี่ยนแปลงหลังได้รับอนุมัติ — ต้องขออนุมัติใหม่ "
                    + "เพื่อไม่ให้เผยแพร่ข้อมูลที่ผู้อนุมัติไม่เคยเห็น");
    }

    /** The same four checks, reported instead of thrown, for the status endpoint. */
    @Transactional(readOnly = true)
    public ApprovalStatus status(UUID tournamentId) {
        String current = fingerprint(tournamentId);
        Optional<Approval> latest = latest(tournamentId);
        if (latest.isEmpty())
            return new ApprovalStatus(false, "ยังไม่มีการอนุมัติ", null, null, null, (short) 0, null,
                current, ACKNOWLEDGMENT_REV);

        Approval approval = latest.get();
        String reason = approval.revoked() ? "ถูกเพิกถอนแล้ว"
            : approval.expired(Instant.now()) ? "หมดอายุแล้ว"
            : !current.equals(approval.contentFingerprint()) ? "ข้อมูลเปลี่ยนหลังได้รับอนุมัติ"
            : "อนุมัติแล้ว";
        boolean valid = "อนุมัติแล้ว".equals(reason);
        return new ApprovalStatus(valid, reason, approval.approvedBy(), approval.approvedAt(),
            approval.expiresAt(), approval.acknowledgmentRev(), approval.contentFingerprint(),
            current, ACKNOWLEDGMENT_REV);
    }

    // ------------------------------------------------------------------ fingerprint

    /**
     * SHA-256 over every card's {@code (id, public_version)} — what the approver is really consenting
     * to, reduced to 64 characters.
     *
     * <p>{@code public_version} (V14) is incremented exactly when a card's publicly visible data
     * changes, so this digest changes exactly then too, and the card-id list makes adding or removing
     * a card change it as well. Comparing it at publish time is what stops an operator approving a
     * tournament, correcting a result, and publishing content the approver never saw.
     *
     * <p>Sorted by the id's string form in Java rather than by SQL {@code ORDER BY}, so the digest
     * cannot quietly depend on the database's collation.
     *
     * <p>This is a pure read. It is also the only place in this class that touches tournament data.
     */
    @Transactional(readOnly = true)
    public String fingerprint(UUID tournamentId) {
        List<String> pairs = jdbc.query(
            "SELECT id, public_version FROM tournament_cards WHERE tournament_id = ?",
            (rs, row) -> rs.getObject("id", UUID.class) + ":" + rs.getLong("public_version"),
            tournamentId);
        StringBuilder canonical = new StringBuilder();
        pairs.stream().sorted(Comparator.naturalOrder()).forEach(pair -> canonical.append(pair).append('\n'));
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(canonical.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is required to fingerprint approval content", error);
        }
    }

    // ------------------------------------------------------------------ internals

    @Transactional(readOnly = true)
    public Optional<Approval> latest(UUID tournamentId) {
        return jdbc.query("""
            SELECT id, tournament_id, approved_by, approved_at, acknowledgment_rev,
                   content_fingerprint, expires_at, revoked_at, revoked_by
            FROM public_snapshot_approvals WHERE tournament_id = ?
            ORDER BY approved_at DESC, id DESC LIMIT 1
            """, (rs, row) -> new Approval(
                rs.getObject("id", UUID.class), rs.getObject("tournament_id", UUID.class),
                rs.getString("approved_by"), rs.getTimestamp("approved_at").toInstant(),
                rs.getShort("acknowledgment_rev"), rs.getString("content_fingerprint"),
                rs.getTimestamp("expires_at").toInstant(),
                rs.getTimestamp("revoked_at") == null ? null : rs.getTimestamp("revoked_at").toInstant(),
                rs.getString("revoked_by")),
            tournamentId).stream().findFirst();
    }

    /**
     * Authorization for every approval action: architecture §4.2 — an ADMIN, or a DIRECTOR assigned
     * to <em>this</em> tournament.
     *
     * <p>Two independent conditions, because either one alone is wrong. <b>Scope</b> comes from the
     * shared RBAC service, so approval cannot drift from the tenancy rule the rest of the
     * application enforces. <b>Role</b> is checked here as well, because being scoped to a
     * tournament is not the same as being entitled to publish it: result-entry staff are legitimately
     * scoped in through {@code staff_tournament_access}, and §4.2 gives them no approval rights at
     * all. Scope alone would have let them consent to permanent publication of athletes' names.
     *
     * <p>Deliberately {@code requireTournamentAccess} and not {@code requireTournamentCapability}:
     * the latter additionally demands the tournament be OPEN, and a tournament worth publishing is
     * usually finished and closed. Publication readiness is card state (§7.5), not link state.
     *
     * @return the tournament's name, needed for the typed confirmation
     */
    private String requireTournament(UUID tournamentId, Authentication auth) {
        authorization.requireTournamentOperator(auth, tournamentId);
        try {
            return jdbc.queryForObject("SELECT name FROM tournaments WHERE id = ?", String.class, tournamentId);
        } catch (EmptyResultDataAccessException notFound) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบทัวร์นาเมนต์");
        }
    }

    /** Authorization plus the states from which approving means anything at all. */
    private String requireApprovableTournament(UUID tournamentId, Authentication auth) {
        String name = requireTournament(tournamentId, auth);
        String state = jdbc.queryForObject(
            "SELECT snapshot_state FROM tournaments WHERE id = ?", String.class, tournamentId);

        if (PublicSnapshotState.PUBLISHING.equals(state))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "กำลังเผยแพร่อยู่ — รอให้รอบนี้เสร็จสิ้นก่อนจึงจะอนุมัติได้");
        // Phase B refuses to publish over a RETRACTED tournament outright, so an approval granted
        // here could never be used. Returning from RETRACTED is retraction's own business (§4.5),
        // and belongs to Phase F together with the state transition that undoes it.
        if (PublicSnapshotState.RETRACTED.equals(state))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ฉบับเผยแพร่นี้ถูกถอนแล้ว — ยังไม่รองรับการอนุมัติใหม่หลังการถอน");
        return name;
    }

    private void audit(UUID tournamentId, String actor, String action, String detail) {
        jdbc.update("INSERT INTO audit_logs (card_id, actor, action, old_value, new_value) VALUES (NULL, ?, ?, NULL, ?)",
            actor, action, "tournament " + tournamentId + " " + detail);
    }
}
