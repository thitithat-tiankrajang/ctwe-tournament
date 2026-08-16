package com.ctwe.tournament.application.systemlifecycle;

import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotState;
import com.ctwe.tournament.application.publicsnapshot.SnapshotKey;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;

/**
 * Whether the backend may be suspended — architecture §19, the read half of zero-compute mode.
 *
 * <p>This service <b>answers a question; it never acts on the answer.</b> It cannot suspend Render,
 * cannot write {@code system/state.json}, and cannot stop itself. That separation is the design
 * (§17.1): the thing being switched off must not be the thing deciding to switch off, and §19.3 goes
 * further — the workflow that reads this must independently fetch every published snapshot over the
 * public internet before it trusts any of it.
 *
 * <blockquote><b>Hard rule (§19.3):</b> the backend is never suspended before every published
 * snapshot has been fetched and checksum-verified over the public internet by the workflow itself. A
 * backend with a broken R2 client or stale credentials cannot authorize its own shutdown, because
 * the authority for "this snapshot is really public" is the public URL, not the backend's opinion of
 * it. Everything returned here is therefore evidence to be checked, not a verdict.</blockquote>
 *
 * <p><b>Reads everything, writes almost nothing.</b> The readiness query is pure. The only write is
 * {@link #shelve}, which sets publication intent on {@code tournaments} and touches no card, player,
 * match or game row.
 */
@Service
public class ShutdownReadinessService {

    private final JdbcTemplate jdbc;

    public ShutdownReadinessService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** A tournament that is standing between the operator and a shutdown. */
    public record TournamentRef(UUID tournamentId, String name, String snapshotState, int cardCount,
                                int unfinishedCardCount) {}

    /**
     * One published snapshot, in the form the stop workflow needs to verify it from outside:
     * {@code h} is the object's derived key, so the workflow can build
     * {@code https://{public-origin}/s/{h}.json} without knowing the access token.
     */
    public record PublishedSnapshot(UUID tournamentId, String name, String h, long version, String sha) {}

    /**
     * @param activeTournamentCount  §19.1's count. Any non-zero value aborts the stop workflow.
     * @param unpublishedFinished    finished but neither published nor shelved — each one aborts too
     * @param publishedSnapshots     every snapshot the workflow must fetch and checksum-verify (§19.3)
     * @param shelved                recorded "will never be published" decisions, for the run summary
     */
    public record Readiness(int activeTournamentCount, List<TournamentRef> unpublishedFinished,
                            List<PublishedSnapshot> publishedSnapshots, List<TournamentRef> shelved) {

        /** Advisory only. The workflow still performs §19.3's external verification before stopping. */
        public boolean readyToStop() {
            return activeTournamentCount == 0 && unpublishedFinished.isEmpty();
        }
    }

    /**
     * A tournament is <b>settled</b> when its snapshot is {@code PUBLISHED}, or an admin shelved it.
     *
     * <p>Note which states are deliberately <em>not</em> settled. {@code RETRACTED} is not: withdrawn
     * results are not public, so the tournament still holds live rows that nobody can read from the
     * CDN, and an operator must decide explicitly — by shelving it — that this is acceptable before
     * the backend goes away. {@code PUBLISH_FAILED} is not, for the same reason.
     */
    private static final String SETTLED = "(t.snapshot_state = 'PUBLISHED' OR t.shelved_at IS NOT NULL)";

    /** Any card not yet FINISHED or CLOSED means the tournament is still being played. */
    private static final String HAS_CARDS_IN_PLAY = """
        EXISTS (SELECT 1 FROM tournament_cards c
                WHERE c.tournament_id = t.id AND c.status NOT IN ('FINISHED', 'CLOSED'))
        """;

    @Transactional(readOnly = true)
    public Readiness readiness() {
        // §19.1, verbatim: the second clause is intentional redundancy, so that even a tournament
        // wrongly marked settled still counts as active while any of its cards is in play.
        Integer active = jdbc.queryForObject(
            "SELECT count(*) FROM tournaments t WHERE NOT " + SETTLED + " OR " + HAS_CARDS_IN_PLAY,
            Integer.class);

        List<TournamentRef> unpublishedFinished = jdbc.query(
            "SELECT " + REF_COLUMNS + " FROM tournaments t "
                + "WHERE NOT " + SETTLED + " AND NOT " + HAS_CARDS_IN_PLAY + " ORDER BY t.name",
            ShutdownReadinessService::mapRef);

        List<PublishedSnapshot> published = jdbc.query("""
            SELECT t.id, t.name, t.access_token, t.snapshot_version, t.snapshot_checksum
            FROM tournaments t WHERE t.snapshot_state = ? ORDER BY t.name
            """, (rs, row) -> new PublishedSnapshot(
                rs.getObject("id", UUID.class), rs.getString("name"),
                SnapshotKey.of(rs.getString("access_token")),
                rs.getLong("snapshot_version"), rs.getString("snapshot_checksum")),
            PublicSnapshotState.PUBLISHED);

        List<TournamentRef> shelved = jdbc.query(
            "SELECT " + REF_COLUMNS + " FROM tournaments t WHERE t.shelved_at IS NOT NULL ORDER BY t.name",
            ShutdownReadinessService::mapRef);

        return new Readiness(active == null ? 0 : active, unpublishedFinished, published, shelved);
    }

    /**
     * Records that a tournament will never be published, so it stops blocking a shutdown (§19.1).
     *
     * <p>Refused for a {@code PUBLISHED} tournament: that one is already settled by publication, and
     * accepting the flag as well would blur what shelving means. A {@code RETRACTED} tournament may
     * be shelved — withdrawing results is precisely a decision not to publish them.
     *
     * <p>Shelving a tournament whose cards are still in play is <em>allowed but ineffective</em>: the
     * redundant second clause of §19.1 keeps counting it as active. That is the documented design,
     * not an oversight — the flag records intent, and cards in play are a fact about the present.
     */
    @Transactional
    public void shelve(UUID tournamentId, String actor) {
        String snapshotState = requireTournamentState(tournamentId);
        if (PublicSnapshotState.PUBLISHED.equals(snapshotState))
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "ทัวร์นาเมนต์นี้เผยแพร่แล้ว — ไม่ต้องพักรายการ (นับว่าเรียบร้อยอยู่แล้ว)");

        // Idempotent: re-shelving keeps the first decision and its attribution.
        int updated = jdbc.update("""
            UPDATE tournaments SET shelved_at = now(), shelved_by = ?
            WHERE id = ? AND shelved_at IS NULL
            """, actor, tournamentId);
        if (updated > 0)
            audit(tournamentId, actor, "SHELVE_TOURNAMENT",
                "will not be published; excluded from the shutdown gate");
    }

    /** Undoes {@link #shelve}. The tournament blocks a shutdown again until it is published. */
    @Transactional
    public void unshelve(UUID tournamentId, String actor) {
        requireTournamentState(tournamentId);
        int updated = jdbc.update(
            "UPDATE tournaments SET shelved_at = NULL, shelved_by = NULL WHERE id = ? AND shelved_at IS NOT NULL",
            tournamentId);
        if (updated > 0)
            audit(tournamentId, actor, "UNSHELVE_TOURNAMENT", "blocks the shutdown gate again");
    }

    private static final String REF_COLUMNS = """
        t.id, t.name, t.snapshot_state,
        (SELECT count(*) FROM tournament_cards c WHERE c.tournament_id = t.id) AS card_count,
        (SELECT count(*) FROM tournament_cards c WHERE c.tournament_id = t.id
             AND c.status NOT IN ('FINISHED', 'CLOSED')) AS unfinished_card_count
        """;

    private static TournamentRef mapRef(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new TournamentRef(rs.getObject("id", UUID.class), rs.getString("name"),
            rs.getString("snapshot_state"), rs.getInt("card_count"), rs.getInt("unfinished_card_count"));
    }

    private String requireTournamentState(UUID tournamentId) {
        try {
            return jdbc.queryForObject(
                "SELECT snapshot_state FROM tournaments WHERE id = ?", String.class, tournamentId);
        } catch (EmptyResultDataAccessException notFound) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบทัวร์นาเมนต์");
        }
    }

    private void audit(UUID tournamentId, String actor, String action, String detail) {
        jdbc.update("INSERT INTO audit_logs (card_id, actor, action, old_value, new_value) VALUES (NULL, ?, ?, NULL, ?)",
            actor, action, "tournament " + tournamentId + " " + detail);
    }
}
