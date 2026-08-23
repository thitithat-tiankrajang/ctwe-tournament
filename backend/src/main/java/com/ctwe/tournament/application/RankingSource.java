package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.ranking.H2HProvider;
import com.ctwe.tournament.domain.ranking.RankingEngine;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Reads what the ranking rule needs, and answers head-to-head on demand.
 *
 * <p>ScoreFor and the game count follow the rule exactly: a BYE is a normal recorded result and
 * counts on both sides of the average, while a PENALTY is not a game and counts on neither. The
 * stored {@code 0,0} scores on a penalty row exist only to satisfy a database constraint — counting
 * them would inject a fabricated zero into the average and punish the player a second time, on top
 * of the Diff they already lost.
 *
 * <p>The provider is demand-driven, which is the point. Today's code builds a full pairwise
 * head-to-head matrix on EVERY pairing generation whether or not anything is tied. Here nothing is
 * read until the engine actually reaches a tie group it could move: the "who has played whom" set
 * loads on the first {@code hasMet}, and meeting detail only on the first {@code verdict}. A card
 * with no movable tie group therefore issues zero queries.
 */
@Component
public class RankingSource {

    private final JdbcTemplate jdbc;

    public RankingSource(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * One row per active player: standings figures plus the ScoreFor and game count the average is
     * built from. Mirrors {@code rankingAfterGame} in {@code src/domain/tournament/history.ts}; the
     * two are held together by {@code docs/ranking-vectors.json} and a parity test.
     */
    public List<RankingEngine.RankRow> rankRows(UUID cardId) {
        return jdbc.query("""
            SELECT p.code,
                   COALESCE(s.win_points, 0) win_points,
                   COALESCE(s.diff, 0) diff,
                   COALESCE(SUM(CASE
                     WHEN m.player_one = p.code THEN COALESCE(m.score_one, 0)
                     WHEN m.player_two = p.code THEN COALESCE(m.score_two, 0)
                     ELSE 0
                   END), 0) score_for,
                   COUNT(m.game_number) games
            FROM players p
            LEFT JOIN standings s ON s.card_id = p.card_id AND s.player_code = p.code
            LEFT JOIN matches m ON m.card_id = p.card_id
              AND m.result_type IS NOT NULL
              AND m.result_type <> 'P'
              AND (m.player_one = p.code OR m.player_two = p.code)
            WHERE p.card_id = ? AND p.terminated_at IS NULL
              AND p.rejoin_game <= (SELECT current_game FROM tournament_cards WHERE id = p.card_id)
            GROUP BY p.code, s.win_points, s.diff
            ORDER BY p.code
            """, (rs, row) -> new RankingEngine.RankRow(String.valueOf(rs.getInt("code")),
                rs.getInt("win_points"), rs.getInt("diff"), rs.getLong("score_for"), rs.getInt("games")), cardId);
    }

    /** The ranked order for a card: player code → position in the internal total order. */
    public Map<String, Integer> order(UUID cardId) {
        Map<String, Integer> order = new LinkedHashMap<>();
        for (RankingEngine.Ranked entry : ranked(cardId)) order.put(entry.playerId(), entry.order());
        return order;
    }

    /** Full ranking for a card, including the displayed (shared) rank. */
    public List<RankingEngine.Ranked> ranked(UUID cardId) {
        return RankingEngine.rank(rankRows(cardId), headToHead(cardId));
    }

    /** A head-to-head provider that reads nothing until it is actually asked something. */
    public H2HProvider headToHead(UUID cardId) {
        return new LazyH2H(cardId);
    }

    private record Meeting(String one, String two, String winner, int diff, int scoreOne, int scoreTwo) {}

    private final class LazyH2H implements H2HProvider {
        private final UUID cardId;
        private Map<String, Set<String>> met;
        private List<Meeting> meetings;
        private final Map<String, Verdict> cache = new HashMap<>();

        private LazyH2H(UUID cardId) {
            this.cardId = cardId;
        }

        public boolean hasMet(String playerId, String opponentId) {
            if (met == null) met = loadMet();
            return met.getOrDefault(playerId, Set.of()).contains(opponentId);
        }

        public Verdict verdict(String playerId, String opponentId) {
            String key = playerId.compareTo(opponentId) <= 0
                ? playerId + "|" + opponentId : opponentId + "|" + playerId;
            boolean forward = key.startsWith(playerId + "|");
            Verdict cached = cache.get(key);
            if (cached != null) return forward ? cached : flip(cached);

            if (meetings == null) meetings = loadMeetings();
            int wins = 0;
            long diff = 0;
            long points = 0;
            long against = 0;
            for (Meeting meeting : meetings) {
                boolean isOne = meeting.one().equals(playerId) && meeting.two().equals(opponentId);
                boolean isTwo = meeting.one().equals(opponentId) && meeting.two().equals(playerId);
                if (!isOne && !isTwo) continue;
                points += isOne ? meeting.scoreOne() : meeting.scoreTwo();
                against += isOne ? meeting.scoreTwo() : meeting.scoreOne();
                if (meeting.winner() == null) continue;          // a draw counts for neither side
                if (meeting.winner().equals(playerId)) { wins++; diff += meeting.diff(); }
                else if (meeting.winner().equals(opponentId)) { wins--; diff -= meeting.diff(); }
            }
            Verdict result = wins != 0 ? sign(wins) : diff != 0 ? sign(diff) : sign(points - against);
            cache.put(key, forward ? result : flip(result));
            return result;
        }

        /** One cheap query: which pairs have ever met. A penalty is not a game and is excluded. */
        private Map<String, Set<String>> loadMet() {
            Map<String, Set<String>> result = new HashMap<>();
            jdbc.query("""
                SELECT player_one, player_two FROM matches
                WHERE card_id = ? AND result_type IS NOT NULL AND result_type <> 'P'
                  AND player_one IS NOT NULL AND player_two IS NOT NULL
                """, rs -> {
                String one = String.valueOf(rs.getInt("player_one"));
                String two = String.valueOf(rs.getInt("player_two"));
                result.computeIfAbsent(one, ignored -> new HashSet<>()).add(two);
                result.computeIfAbsent(two, ignored -> new HashSet<>()).add(one);
            }, cardId);
            return result;
        }

        /** Meeting detail, loaded once and only when a verdict is genuinely needed. */
        private List<Meeting> loadMeetings() {
            List<Meeting> result = new ArrayList<>();
            jdbc.query("""
                SELECT player_one, player_two, winner, calculated_diff, score_one, score_two
                FROM matches
                WHERE card_id = ? AND result_type IS NOT NULL AND result_type <> 'P'
                  AND player_one IS NOT NULL AND player_two IS NOT NULL
                """, rs -> {
                int winner = rs.getInt("winner");
                result.add(new Meeting(String.valueOf(rs.getInt("player_one")), String.valueOf(rs.getInt("player_two")),
                    rs.wasNull() ? null : String.valueOf(winner), rs.getInt("calculated_diff"),
                    rs.getInt("score_one"), rs.getInt("score_two")));
            }, cardId);
            return result;
        }

        private Verdict sign(long value) {
            return value > 0 ? Verdict.BETTER : value < 0 ? Verdict.WORSE : Verdict.TIED;
        }

        private Verdict flip(Verdict verdict) {
            return verdict == Verdict.BETTER ? Verdict.WORSE : verdict == Verdict.WORSE ? Verdict.BETTER : Verdict.TIED;
        }
    }
}
