package com.ctwe.tournament.application;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Persistence for the Screening Pool — a temporary, internal hold on a player suspected absent.
 *
 * <p>Every method here is a primitive. All policy (who may screen, when the slot is vacated, what
 * empties the pool before a gate) lives in the callers; this class only reads and writes rows.
 *
 * <p><b>Transactions.</b> Nothing here opens one. Callers are already {@code @Transactional}, and
 * Spring's default propagation means these statements join that transaction — which is what makes a
 * pairing commit atomic across pairing rows, pool rows, results and audit.
 *
 * <p><b>What screening is not.</b> A hold never generates an absence penalty, never touches
 * {@code players.rejoin_game}, and never survives the game it was taken in. Those belong to the
 * terminate/restore lifecycle, which this feature does not participate in.
 */
@Service
public class ScreeningPoolStore {

    /** Why a player is being held. Mirrors the CHECK on {@code screening_pool.reason}. */
    public enum Reason { NO_SHOW, LATE, MEDICAL, OTHER }

    /** How a hold ended. Exactly two exits exist. */
    public enum Resolution { RETURNED, TERMINATED }

    /**
     * The pairing position a player was pulled out of, captured at screening time.
     *
     * <p>It has to be captured rather than derived: screening empties the slot in the same
     * transaction, so afterwards there is nowhere left to read it from. {@code stale} is set once
     * that pairing changes again, so the operator sees the context as historical instead of acting
     * on an opponent who has since been moved.
     */
    public record Origin(Integer game, Integer table, Integer side, Integer opponent, boolean stale) {
        public static final Origin UNKNOWN = new Origin(null, null, null, null, false);
    }

    /** One open hold, as the pool panel renders it. */
    public record Hold(
        int playerCode,
        Instant screenedAt,
        String screenedBy,
        Reason reason,
        String note,
        Origin origin,
        Integer fromGame
    ) {}

    private final JdbcTemplate jdbc;

    public ScreeningPoolStore(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * Open a hold. Convergent by design: a player already held is left exactly as they are and
     * {@code false} is returned, because two directors screening the same no-show have agreed, not
     * conflicted, and failing the second one's whole batch over it would help nobody.
     *
     * @return true if this call created the hold, false if one was already open
     */
    public boolean open(UUID cardId, int playerCode, Reason reason, String note, Origin origin, String actor) {
        return open(cardId, playerCode, reason, note, origin, actor, null);
    }

    public boolean open(UUID cardId, int playerCode, Reason reason, String note, Origin origin, String actor, Integer fromGame) {
        return jdbc.update("""
            INSERT INTO screening_pool (card_id, player_code, screened_by, reason, note,
                                        origin_game, origin_table, origin_side, origin_opponent, excluded_from_game)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM screening_pool
                WHERE card_id = ? AND player_code = ? AND resolved_at IS NULL
            )
            """,
            cardId, playerCode, actor, reason.name(), blankToNull(note),
            origin.game(), origin.table(), origin.side(), origin.opponent(), fromGame,
            cardId, playerCode) > 0;
    }

    /**
     * Close the open hold on a player.
     *
     * @return true if a hold was closed, false if the player was not held
     */
    public boolean close(UUID cardId, int playerCode, Resolution resolution, String actor) {
        return close(cardId, playerCode, resolution, actor, null);
    }

    public boolean close(UUID cardId, int playerCode, Resolution resolution, String actor, Integer fromGame) {
        return jdbc.update("""
            UPDATE screening_pool
               SET resolved_at = now(), resolved_by = ?, resolution = ?, returned_from_game = ?
             WHERE card_id = ? AND player_code = ? AND resolved_at IS NULL
            """, actor, resolution.name(), fromGame, cardId, playerCode) > 0;
    }

    /** Close every open hold on a card. Used when a card's runtime data is reset. */
    public int closeAll(UUID cardId, Resolution resolution, String actor) {
        return jdbc.update("""
            UPDATE screening_pool
               SET resolved_at = now(), resolved_by = ?, resolution = ?
             WHERE card_id = ? AND resolved_at IS NULL
            """, actor, resolution.name(), cardId);
    }

    /** Every open hold on a card, oldest first — the order the pool panel lists them in. */
    public List<Hold> listOpen(UUID cardId) {
        return List.copyOf(jdbc.query("""
            SELECT player_code, screened_at, screened_by, reason, note,
                   origin_game, origin_table, origin_side, origin_opponent, origin_stale, excluded_from_game
              FROM screening_pool
             WHERE card_id = ? AND resolved_at IS NULL
             ORDER BY screened_at, player_code
            """, ScreeningPoolStore::mapHold, cardId));
    }

    /** Player codes currently held. The pairing generators and the gate both want just this. */
    public Set<Integer> openCodes(UUID cardId) {
        return Set.copyOf(jdbc.queryForList(
            "SELECT player_code FROM screening_pool WHERE card_id = ? AND resolved_at IS NULL",
            Integer.class, cardId));
    }

    /** True when no player on this card is held — the condition every review/publish gate requires. */
    public boolean isEmpty(UUID cardId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT NOT EXISTS (
                SELECT 1 FROM screening_pool WHERE card_id = ? AND resolved_at IS NULL
            )
            """, Boolean.class, cardId));
    }

    public boolean isScreened(UUID cardId, int playerCode) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1 FROM screening_pool
                WHERE card_id = ? AND player_code = ? AND resolved_at IS NULL
            )
            """, Boolean.class, cardId, playerCode));
    }

    /**
     * Mark captured origin context historical for every open hold that pointed at one of the slots
     * just changed. Called after a commit rewrites pairing rows: the captured opponent may now be
     * sitting somewhere else entirely, and a pool card that states it confidently is worse than one
     * that admits the context has moved on.
     *
     * @param touched the (game, table) pairs the commit wrote to
     */
    public int markOriginStale(UUID cardId, List<int[]> touched) {
        int marked = 0;
        for (int[] slot : touched)
            marked += jdbc.update("""
                UPDATE screening_pool
                   SET origin_stale = true
                 WHERE card_id = ? AND resolved_at IS NULL AND NOT origin_stale
                   AND origin_game = ? AND origin_table = ?
                """, cardId, slot[0], slot[1]);
        return marked;
    }

    private static Hold mapHold(ResultSet rs, int row) throws SQLException {
        return new Hold(
            rs.getInt("player_code"),
            rs.getTimestamp("screened_at").toInstant(),
            rs.getString("screened_by"),
            Reason.valueOf(rs.getString("reason")),
            rs.getString("note"),
            new Origin(
                nullableInt(rs, "origin_game"),
                nullableInt(rs, "origin_table"),
                nullableInt(rs, "origin_side"),
                nullableInt(rs, "origin_opponent"),
                rs.getBoolean("origin_stale")
            ), nullableInt(rs, "excluded_from_game"));
    }

    private static Integer nullableInt(ResultSet rs, String column) throws SQLException {
        int value = rs.getInt(column);
        return rs.wasNull() ? null : value;
    }

    private static String blankToNull(String note) {
        return note == null || note.isBlank() ? null : note.trim();
    }

    /** Parses a client-supplied reason, defaulting to OTHER rather than rejecting an unknown value. */
    public static Reason reasonOf(String raw) {
        if (raw == null || raw.isBlank()) return Reason.OTHER;
        try { return Reason.valueOf(raw.trim().toUpperCase(Locale.ROOT)); }
        catch (IllegalArgumentException unknown) { return Reason.OTHER; }
    }
}
