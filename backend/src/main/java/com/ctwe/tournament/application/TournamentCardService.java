package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.domain.pairing.GibsonAnalysis;
import com.ctwe.tournament.domain.pairing.PairingStrategy;
import com.ctwe.tournament.infrastructure.cache.EvictPublicCard;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.CardDtos;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Caching;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@Service
public class TournamentCardService {
    private final JdbcTemplate jdbc;
    private final PairingStrategyRegistry strategies;
    private final ObjectMapper objectMapper;
    private final SecureRandom secureRandom = new SecureRandom();

    public TournamentCardService(JdbcTemplate jdbc, PairingStrategyRegistry strategies, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.strategies = strategies;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public List<CardDtos.CardResponse> list(boolean staffView, Set<UUID> restrictTournaments) {
        if (restrictTournaments != null && restrictTournaments.isEmpty()) return List.of();
        String where = restrictTournaments == null ? ""
            : " WHERE tournament_id IN (" + String.join(", ", Collections.nCopies(restrictTournaments.size(), "?")) + ")";
        Object[] args = restrictTournaments == null ? new Object[0] : restrictTournaments.toArray();
        return jdbc.query("SELECT id FROM tournament_cards" + where + " ORDER BY created_at DESC",
            (rs, row) -> get(rs.getObject("id", UUID.class), staffView), args);
    }

    @Transactional(readOnly = true)
    public CardDtos.CardResponse get(UUID cardId, boolean staffView) {
        CardRow card;
        try {
            card = jdbc.queryForObject("""
                SELECT id, name, division, number_of_games, status, runtime_stage, current_game, created_at, version, final_type, final_games, gibson_enabled
                FROM tournament_cards WHERE id = ?
                """, (rs, row) -> new CardRow(
                rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("division"),
                rs.getInt("number_of_games"), CardStatus.valueOf(rs.getString("status")),
                RuntimeStage.valueOf(rs.getString("runtime_stage")), rs.getInt("current_game"),
                rs.getTimestamp("created_at").toInstant(), rs.getLong("version"),
                rs.getString("final_type"), rs.getInt("final_games"), rs.getBoolean("gibson_enabled")), cardId);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found");
        }
        UUID tournamentId = jdbc.queryForObject("SELECT tournament_id FROM tournament_cards WHERE id = ?", UUID.class, cardId);

        var games = jdbc.query("SELECT id, game_number, status, max_diff FROM games WHERE card_id = ? ORDER BY game_number",
            (rs, row) -> new CardDtos.GameResponse(rs.getObject("id", UUID.class).toString(), rs.getInt("game_number"),
                "เกม " + rs.getInt("game_number"), rs.getString("status"), rs.getInt("max_diff")), cardId);
        var rules = jdbc.query("SELECT from_game, to_game, rule_type FROM pairing_rules WHERE card_id = ? ORDER BY from_game",
            (rs, row) -> new CardDtos.RuleResponse(rs.getInt("from_game"), rs.getInt("to_game"), PairingRuleType.valueOf(rs.getString("rule_type"))), cardId);
        List<CardDtos.PlayerResponse> players = !staffView && card.runtimeStage() == RuntimeStage.PLAYER_REGISTRATION
            ? List.of()
            : jdbc.query("""
            SELECT p.external_id, p.first_name, p.last_name, p.school, p.division,
                   COALESCE(s.wins, 0) wins, COALESCE(s.draws, 0) draws, COALESCE(s.losses, 0) losses,
                   COALESCE(s.win_points, 0) win_points, COALESCE(s.diff, 0) diff
            FROM players p LEFT JOIN standings s ON s.player_id = p.id AND s.card_id = p.card_id
            WHERE p.card_id = ? ORDER BY p.external_id
            """, (rs, row) -> new CardDtos.PlayerResponse(rs.getString("external_id"), rs.getString("first_name"),
                rs.getString("last_name"), rs.getString("school"), rs.getString("division"),
                rs.getInt("wins"), rs.getInt("draws"), rs.getInt("losses"), rs.getInt("win_points"), rs.getInt("diff")), cardId);
        var tables = staffView ? loadTables(cardId) : List.<CardDtos.TableResponse>of();
        var snapshots = loadSnapshots(cardId, staffView);
        // Audit is intentionally NOT loaded in the card payload — it is the largest, JSONB-heavy part and
        // only the audit page needs it. Loading it on every save/poll/list (get() runs per card in list())
        // dominated latency + heap. It is served on demand via GET /{cardId}/audit instead.
        var audit = List.<CardDtos.AuditResponse>of();

        return new CardDtos.CardResponse(card.id(), tournamentId, card.name(), card.division(), card.status(), card.runtimeStage(),
            card.currentGame(), card.version(), games, rules, players, tables, snapshots, audit,
            card.finalType(), card.finalGames(), loadFinalRound(cardId), card.gibsonEnabled(), card.createdAt());
    }

    /** On-demand audit log for the audit page (kept out of the card payload to keep the hot path cheap). */
    @Transactional(readOnly = true)
    public List<CardDtos.AuditResponse> auditLog(UUID cardId) {
        return jdbc.query("""
            SELECT id, actor, action, old_value::text old_value, new_value::text new_value, created_at
            FROM audit_logs WHERE card_id = ? ORDER BY created_at DESC LIMIT 1000
            """, (rs, row) -> new CardDtos.AuditResponse(rs.getObject("id", UUID.class).toString(),
                rs.getTimestamp("created_at").toInstant().toString(), rs.getString("actor"), rs.getString("action"),
                jsonText(rs.getString("old_value")), jsonText(rs.getString("new_value"))), cardId);
    }

    /** Tiny change-detector for live-sync polling: avoids rebuilding the whole card when nothing changed. */
    @Transactional(readOnly = true)
    public long cardVersion(UUID cardId) {
        List<Long> rows = jdbc.queryForList("SELECT version FROM tournament_cards WHERE id = ?", Long.class, cardId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found");
        return rows.get(0);
    }

    /** Assemble the final-round bracket (null until the director starts it). Player ids are external codes. */
    private CardDtos.FinalRoundResponse loadFinalRound(UUID cardId) {
        record Slot(int slot, String one, String two, String winner) {}
        List<Slot> pairings = jdbc.query("""
            SELECT fp.slot, p1.external_id AS one, p2.external_id AS two, w.external_id AS winner
            FROM final_pairings fp
            JOIN players p1 ON p1.id = fp.player_one_id
            JOIN players p2 ON p2.id = fp.player_two_id
            LEFT JOIN players w ON w.id = fp.winner_id
            WHERE fp.card_id = ? ORDER BY fp.slot
            """, (rs, row) -> new Slot(rs.getInt("slot"), rs.getString("one"), rs.getString("two"), rs.getString("winner")), cardId);
        if (pairings.isEmpty()) return null;
        List<CardDtos.FinalSlotResponse> slots = new ArrayList<>();
        for (Slot pairing : pairings) {
            var games = jdbc.query("SELECT game_index, score_one, score_two FROM final_game_results WHERE card_id = ? AND slot = ? ORDER BY game_index",
                (rs, row) -> {
                    Integer scoreOne = (Integer) rs.getObject("score_one");
                    Integer scoreTwo = (Integer) rs.getObject("score_two");
                    String gameWinner = (scoreOne == null || scoreTwo == null || scoreOne.intValue() == scoreTwo.intValue())
                        ? null : (scoreOne > scoreTwo ? pairing.one() : pairing.two());
                    return new CardDtos.FinalGameResponse(rs.getInt("game_index"), scoreOne, scoreTwo, gameWinner);
                }, cardId, pairing.slot());
            slots.add(new CardDtos.FinalSlotResponse(pairing.slot(), pairing.one(), pairing.two(), games, pairing.winner()));
        }
        return new CardDtos.FinalRoundResponse(slots);
    }

    @Transactional
    @Caching(evict = {
        @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_CATALOG, allEntries = true),
        @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_VERSIONS, allEntries = true)
    })
    public CardDtos.CardResponse create(CardDtos.CreateCardRequest request, String actor) {
        if (request.rules().size() != request.numberOfGames() - 1)
            throw new IllegalArgumentException("Every game edge requires exactly one pairing rule");
        if (request.gameMaxDiffs().size() != request.numberOfGames())
            throw new IllegalArgumentException("ต้องกำหนด Maximum Difference ให้ครบทุกเกม");
        if (hasInvalidPairResultChain(request.rules()))
            throw new IllegalArgumentException("PAIR_RESULT cannot chain beyond two games");
        if (count("SELECT COUNT(*) FROM tournaments WHERE id = ?", request.tournamentId()) == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament not found");
        String finalType = request.finalType() == null ? "NONE" : request.finalType();
        int finalGames = "NONE".equals(finalType) ? 0 : request.finalGames();
        if (!"NONE".equals(finalType) && finalGames < 1)
            throw new IllegalArgumentException("รอบชิงต้องมีอย่างน้อย 1 เกม");
        UUID cardId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO tournament_cards (id, tournament_id, name, division, number_of_games, status, runtime_stage, current_game, final_type, final_games, gibson_enabled)
            VALUES (?, ?, ?, ?, ?, 'DRAFT', 'PLAYER_REGISTRATION', 1, ?, ?, ?)
            """, cardId, request.tournamentId(), request.name().trim(), request.division().trim(), request.numberOfGames(), finalType, finalGames, request.gibsonEnabled());
        for (int game = 1; game <= request.numberOfGames(); game++) {
            jdbc.update("INSERT INTO games (id, card_id, game_number, status, max_diff) VALUES (?, ?, ?, 'PENDING', ?)",
                UUID.randomUUID(), cardId, game, request.gameMaxDiffs().get(game - 1));
        }
        for (int index = 0; index < request.rules().size(); index++) {
            jdbc.update("INSERT INTO pairing_rules (id, card_id, from_game, to_game, rule_type) VALUES (?, ?, ?, ?, ?)",
                UUID.randomUUID(), cardId, index + 1, index + 2, request.rules().get(index).name());
        }
        audit(cardId, actor, "CREATE_CARD", null, Map.of(
            "name", request.name().trim(), "division", request.division().trim(), "gameMaxDiffs", request.gameMaxDiffs()
        ));
        return get(cardId, true);
    }

    @Transactional(readOnly = true)
    public void assertVersion(UUID cardId, long expectedVersion) {
        Long actual;
        try { actual = jdbc.queryForObject("SELECT version FROM tournament_cards WHERE id = ?", Long.class, cardId); }
        catch (EmptyResultDataAccessException error) { throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found"); }
        if (actual != expectedVersion) throw new ResponseStatusException(HttpStatus.CONFLICT, "Card changed; reload before retrying");
    }

    @Transactional
    public CardDtos.CardResponse addPlayer(UUID cardId, CardDtos.PlayerRequest request, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        UUID playerId = UUID.randomUUID();
        String externalId = nextPlayerCode(cardId);
        jdbc.update("""
            INSERT INTO players (id, card_id, external_id, first_name, last_name, school, division)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """, playerId, cardId, externalId, request.firstName().trim(), request.lastName().trim(), request.school().trim(), card.division());
        jdbc.update("INSERT INTO standings (id, card_id, player_id) VALUES (?, ?, ?)", UUID.randomUUID(), cardId, playerId);
        touch(cardId);
        audit(cardId, actor, "ADD_PLAYER", null, externalId + " " + request.firstName().trim() + " " + request.lastName().trim());
        return get(cardId, true);
    }

    /** Bulk import (e.g. from Excel): append many players in one transaction with sequential codes. */
    @Transactional
    public CardDtos.CardResponse addPlayersBulk(UUID cardId, List<CardDtos.BulkPlayerEntry> players, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        Integer next = jdbc.queryForObject("""
            SELECT COALESCE(MAX(CASE WHEN external_id ~ '^P[0-9]+$' THEN substring(external_id from 2)::integer END), 0) + 1
            FROM players WHERE card_id = ?
            """, Integer.class, cardId);
        int start = next == null ? 1 : next;
        for (int index = 0; index < players.size(); index++) {
            CardDtos.BulkPlayerEntry entry = players.get(index);
            UUID playerId = UUID.randomUUID();
            String externalId = "P" + String.format("%03d", start + index);
            jdbc.update("""
                INSERT INTO players (id, card_id, external_id, first_name, last_name, school, division)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """, playerId, cardId, externalId, entry.firstName().trim(), entry.lastName().trim(), entry.school().trim(), card.division());
            jdbc.update("INSERT INTO standings (id, card_id, player_id) VALUES (?, ?, ?)", UUID.randomUUID(), cardId, playerId);
        }
        touch(cardId);
        audit(cardId, actor, "IMPORT_PLAYERS", null, Map.of("count", players.size(), "fromCode", "P" + String.format("%03d", start)));
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse updatePlayer(UUID cardId, String playerExternalId, CardDtos.PlayerRequest request, String actor, boolean operator) {
        // Directors/admins may correct player details at any time; staff only during registration.
        if (operator) ensureEditable(cardId);
        else requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        PlayerAudit oldPlayer = playerAudit(cardId, playerExternalId);
        if (request.id() != null && !request.id().isBlank() && !request.id().equals(playerExternalId))
            throw new IllegalArgumentException("รหัสนักกีฬาถูกจัดการโดยระบบและไม่สามารถแก้เองได้");
        int changed = jdbc.update("""
            UPDATE players SET first_name = ?, last_name = ?, school = ?
            WHERE card_id = ? AND external_id = ?
            """, request.firstName().trim(), request.lastName().trim(), request.school().trim(), cardId, playerExternalId);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found");
        touch(cardId);
        publishPublicIfPlayersVisible(cardId);
        audit(cardId, actor, "UPDATE_PLAYER", oldPlayer.asAuditValue(), Map.of(
            "id", playerExternalId,
            "firstName", request.firstName().trim(),
            "lastName", request.lastName().trim(),
            "school", request.school().trim()
        ));
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse removePlayer(UUID cardId, String playerExternalId, String actor) {
        requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        PlayerAudit removedPlayer = playerAudit(cardId, playerExternalId);
        if (count("SELECT COUNT(*) FROM matches WHERE player_one_id = ? OR player_two_id = ?", removedPlayer.id(), removedPlayer.id()) > 0)
            throw new IllegalArgumentException("A player with match history cannot be deleted");
        jdbc.update("DELETE FROM standings WHERE player_id = ?", removedPlayer.id());
        jdbc.update("DELETE FROM players WHERE id = ?", removedPlayer.id());

        List<PlayerCodeRow> remaining = jdbc.query("""
            SELECT id, external_id FROM players WHERE card_id = ?
            ORDER BY CASE WHEN external_id ~ '^P[0-9]+$' THEN substring(external_id from 2)::integer ELSE 2147483647 END,
                     external_id
            """, (rs, row) -> new PlayerCodeRow(rs.getObject("id", UUID.class), rs.getString("external_id")), cardId);
        for (PlayerCodeRow player : remaining)
            jdbc.update("UPDATE players SET external_id = ? WHERE id = ?", "TMP_" + player.id(), player.id());
        Map<String, String> renumbered = new LinkedHashMap<>();
        for (int index = 0; index < remaining.size(); index++) {
            PlayerCodeRow player = remaining.get(index);
            String nextCode = "P" + String.format("%03d", index + 1);
            jdbc.update("UPDATE players SET external_id = ? WHERE id = ?", nextCode, player.id());
            if (!player.externalId().equals(nextCode)) renumbered.put(player.externalId(), nextCode);
        }
        touch(cardId);
        audit(cardId, actor, "REMOVE_PLAYER", removedPlayer.asAuditValue(), Map.of(
            "deleted", playerExternalId,
            "renumbered", renumbered
        ));
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse finishRegistration(UUID cardId, String actor) {
        requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        long players = count("SELECT COUNT(*) FROM players WHERE card_id = ?", cardId);
        if (players < 2) throw new IllegalArgumentException("ต้องมีผู้เล่นอย่างน้อย 2 คน");
        if (players % 2 != 0) throw new IllegalArgumentException("จำนวนผู้เล่นต้องเป็นเลขคู่ก่อนจบการลงทะเบียน");
        if (hasPairResultRule(cardId) && players % 4 != 0)
            throw new IllegalArgumentException("การแข่งขันที่ใช้แพ้เจอแพ้/ชนะเจอชนะต้องมีจำนวนผู้เล่นหาร 4 ลงตัว");
        jdbc.update("UPDATE tournament_cards SET status = 'READY', runtime_stage = 'TABLE_PAIRING', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        audit(cardId, actor, "FINISH_PLAYER_REGISTRATION", players + " players", "ready for game 1 pairing");
        return get(cardId, true);
    }

    @Transactional
    public CardDtos.CardResponse generatePairingPreview(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.TABLE_PAIRING);
        if (count("SELECT COUNT(*) FROM players WHERE card_id = ?", cardId) < 2)
            throw new IllegalArgumentException("ต้องมีผู้เล่นอย่างน้อย 2 คน");

        PairingRuleType appliedRule = null;
        if (card.currentGame() == 1) {
            generateInitialTables(cardId);
        } else {
            appliedRule = generateSystemMatches(cardId, card.currentGame());
        }
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'PAIRING_PREVIEW', version = version + 1 WHERE id = ?", cardId);
        Map<String, Object> pairingLog = new LinkedHashMap<>();
        pairingLog.put("game", card.currentGame());
        pairingLog.put("rule", card.currentGame() == 1 ? "RANDOM_SCHOOL_SAFE" : appliedRule.name());
        pairingLog.put("configuredEdge", card.currentGame() == 1 ? "initial" : "game " + (card.currentGame() - 1) + " -> game " + card.currentGame());
        pairingLog.put("players", count("SELECT COUNT(*) FROM players WHERE card_id = ?", cardId));
        audit(cardId, actor, "GENERATE_PAIRING_PREVIEW", null, pairingLog);
        return get(cardId, true);
    }

    private void generateInitialTables(UUID cardId) {
        jdbc.update("DELETE FROM competition_tables WHERE card_id = ?", cardId);
        var players = jdbc.query("SELECT id, school FROM players WHERE card_id = ? ORDER BY external_id",
            (rs, row) -> new SeatPlayer(rs.getObject("id", UUID.class), rs.getString("school")), cardId);
        Collections.shuffle(players, secureRandom);
        var pairs = randomizedSchoolSafePairs(players);
        Collections.shuffle(pairs, secureRandom);
        int tableNumber = 1;
        for (int pairIndex = 0; pairIndex < pairs.size(); pairIndex += 2) {
            UUID tableId = UUID.randomUUID();
            jdbc.update("INSERT INTO competition_tables (id, card_id, table_number) VALUES (?, ?, ?)", tableId, cardId, tableNumber++);
            int seatNumber = 1;
            for (int offset = 0; offset < 2 && pairIndex + offset < pairs.size(); offset++) {
                InitialPair pair = pairs.get(pairIndex + offset);
                jdbc.update("INSERT INTO table_players (table_id, player_id, seat_number) VALUES (?, ?, ?)", tableId, pair.one().id(), seatNumber++);
                jdbc.update("INSERT INTO table_players (table_id, player_id, seat_number) VALUES (?, ?, ?)", tableId, pair.two().id(), seatNumber++);
            }
        }
    }

    /**
     * Random game-1 pairing that avoids same-school matchups when possible, and ALLOWS them with the
     * mathematically minimum number when unavoidable (no exception). Greedy: every step pairs the two
     * largest *different* schools, which maximises cross-school pairs; same-school pairs only remain when
     * one school's players outnumber everyone else combined — those land on that largest (most-crowded)
     * school, so the unavoidable pressure falls on a big school rather than a small one. Tie-break and
     * within-school order are random, and {@code generateInitialTables} re-shuffles pairs into table
     * numbers, so the result isn't reverse-engineerable.
     */
    private List<InitialPair> randomizedSchoolSafePairs(List<SeatPlayer> shuffledPlayers) {
        if (shuffledPlayers.size() % 2 != 0)
            throw new IllegalArgumentException("จำนวนผู้เล่นต้องเป็นเลขคู่ก่อนสร้าง pairing");

        Map<String, List<SeatPlayer>> grouped = new HashMap<>();
        for (SeatPlayer player : shuffledPlayers)
            grouped.computeIfAbsent(schoolKey(player.school()), key -> new ArrayList<>()).add(player);
        List<List<SeatPlayer>> buckets = new ArrayList<>(grouped.values());
        for (List<SeatPlayer> bucket : buckets) Collections.shuffle(bucket, secureRandom);

        List<InitialPair> pairs = new ArrayList<>();
        while (true) {
            buckets.removeIf(List::isEmpty);
            if (buckets.isEmpty()) break;
            Collections.shuffle(buckets, secureRandom);                       // random tie-break among equal sizes
            buckets.sort((left, right) -> Integer.compare(right.size(), left.size())); // stable: largest first
            List<SeatPlayer> largest = buckets.get(0);
            if (buckets.size() == 1) {
                // Only one school left: pair its surplus internally (the minimum unavoidable same-school pairs).
                while (largest.size() >= 2)
                    pairs.add(new InitialPair(largest.remove(largest.size() - 1), largest.remove(largest.size() - 1)));
            } else {
                List<SeatPlayer> second = buckets.get(1);
                pairs.add(new InitialPair(largest.remove(largest.size() - 1), second.remove(second.size() - 1)));
            }
        }
        return pairs;
    }

    private String schoolKey(String school) {
        return school.trim().toLowerCase(Locale.ROOT);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse swapPlayers(UUID cardId, CardDtos.SwapRequest request, String actor) {
        // Edit pairing is allowed from preview through result collection (director-only, enforced upstream).
        CardRow card = cardRow(cardId);
        if (card.status() == CardStatus.CLOSED || card.status() == CardStatus.FINISHED)
            throw new IllegalArgumentException("การ์ดนี้ประกาศผลหรือปิดแล้ว ไม่สามารถแก้คู่ได้");
        if (card.runtimeStage() != RuntimeStage.PAIRING_PREVIEW && card.runtimeStage() != RuntimeStage.RESULT_COLLECTION)
            throw new IllegalArgumentException("แก้คู่ได้เฉพาะช่วงตรวจ pairing จนถึงกรอกผล");
        UUID first = playerId(cardId, request.firstPlayerId());
        UUID second = playerId(cardId, request.secondPlayerId());
        if (first.equals(second)) throw new IllegalArgumentException("เลือกผู้เล่นสองคนที่ต่างกัน");
        // Game 1 before confirmation lives in competition_tables; once matches exist, swap those.
        if (card.currentGame() == 1 && card.runtimeStage() == RuntimeStage.PAIRING_PREVIEW)
            swapSeats(cardId, first, second, request.confirmSchoolConflict());
        else swapMatchPlayers(cardId, card.currentGame(), first, second, request.confirmSchoolConflict());
        touch(cardId);
        if (card.runtimeStage() == RuntimeStage.RESULT_COLLECTION) publishPublic(cardId);
        audit(cardId, actor, "SWAP_PLAYERS", request.firstPlayerId(), request.secondPlayerId() + " · เกม " + card.currentGame());
        return get(cardId, true);
    }

    private void swapSeats(UUID cardId, UUID first, UUID second, boolean confirmConflict) {
        var seats = jdbc.query("SELECT table_id, player_id, seat_number FROM table_players WHERE player_id IN (?, ?)",
            (rs, row) -> new Seat(rs.getObject("table_id", UUID.class), rs.getObject("player_id", UUID.class), rs.getInt("seat_number")), first, second);
        if (seats.size() != 2) throw new IllegalArgumentException("Both players must have assigned seats");
        Seat a = seats.stream().filter(seat -> seat.playerId().equals(first)).findFirst().orElseThrow();
        Seat b = seats.stream().filter(seat -> seat.playerId().equals(second)).findFirst().orElseThrow();
        if (!confirmConflict && wouldCreateSchoolConflict(cardId, first, second))
            throw new IllegalArgumentException("SCHOOL_CONFLICT: การสลับนี้ทำให้ผู้เล่นโรงเรียนเดียวกันแข่งขันกัน กรุณายืนยันอีกครั้ง");
        jdbc.update("DELETE FROM table_players WHERE player_id IN (?, ?)", first, second);
        jdbc.update("INSERT INTO table_players (table_id, player_id, seat_number) VALUES (?, ?, ?)", a.tableId(), second, a.seatNumber());
        jdbc.update("INSERT INTO table_players (table_id, player_id, seat_number) VALUES (?, ?, ?)", b.tableId(), first, b.seatNumber());
    }

    /** Swap two players across the unconfirmed preview pairings of any game ≥ 2. */
    private void swapMatchPlayers(UUID cardId, int gameNumber, UUID first, UUID second, boolean confirmConflict) {
        var matches = jdbc.query("""
            SELECT m.id, m.player_one_id, m.player_two_id, (r.id IS NOT NULL) has_result
            FROM matches m JOIN games g ON g.id = m.game_id
            LEFT JOIN match_results r ON r.match_id = m.id
            WHERE m.card_id = ? AND g.game_number = ? AND m.snapshot_id IS NULL
            """, (rs, row) -> new MatchSlot(rs.getObject("id", UUID.class), rs.getObject("player_one_id", UUID.class),
                rs.getObject("player_two_id", UUID.class), rs.getBoolean("has_result")), cardId, gameNumber);
        MatchSlot firstMatch = null; MatchSlot secondMatch = null;
        boolean firstIsOne = false; boolean secondIsOne = false;
        for (MatchSlot match : matches) {
            if (first.equals(match.oneId())) { firstMatch = match; firstIsOne = true; }
            else if (first.equals(match.twoId())) { firstMatch = match; firstIsOne = false; }
            if (second.equals(match.oneId())) { secondMatch = match; secondIsOne = true; }
            else if (second.equals(match.twoId())) { secondMatch = match; secondIsOne = false; }
        }
        if (firstMatch == null || secondMatch == null) throw new IllegalArgumentException("ไม่พบผู้เล่นใน pairing ของเกมนี้");
        if (firstMatch.id().equals(secondMatch.id())) throw new IllegalArgumentException("ผู้เล่นสองคนนี้เป็นคู่แข่งกันอยู่แล้ว");
        if (firstMatch.hasResult() || secondMatch.hasResult()) throw new IllegalArgumentException("คู่ที่มีผลแล้วสลับไม่ได้");
        UUID firstOpponent = firstIsOne ? firstMatch.twoId() : firstMatch.oneId();
        UUID secondOpponent = secondIsOne ? secondMatch.twoId() : secondMatch.oneId();
        if (!confirmConflict && (sameSchool(firstOpponent, second) || sameSchool(secondOpponent, first)))
            throw new IllegalArgumentException("SCHOOL_CONFLICT: การสลับนี้ทำให้ผู้เล่นโรงเรียนเดียวกันแข่งขันกัน กรุณายืนยันอีกครั้ง");
        jdbc.update("UPDATE matches SET player_" + (firstIsOne ? "one" : "two") + "_id = ? WHERE id = ?", second, firstMatch.id());
        jdbc.update("UPDATE matches SET player_" + (secondIsOne ? "one" : "two") + "_id = ? WHERE id = ?", first, secondMatch.id());
    }

    private boolean sameSchool(UUID a, UUID b) {
        if (a == null || b == null || a.equals(b)) return false;
        var schools = jdbc.queryForList("SELECT school FROM players WHERE id IN (?, ?)", String.class, a, b);
        return schools.size() == 2 && schools.get(0) != null && schools.get(0).equalsIgnoreCase(schools.get(1));
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse confirmPairingPreview(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.PAIRING_PREVIEW);
        if (card.currentGame() == 1) createMatchesFromInitialTables(cardId);
        if (count("SELECT COUNT(*) FROM matches m JOIN games g ON g.id = m.game_id WHERE m.card_id = ? AND g.game_number = ?", cardId, card.currentGame()) == 0)
            throw new IllegalArgumentException("ไม่พบ pairing สำหรับเกมปัจจุบัน");
        jdbc.update("UPDATE matches m SET pairing_published_at = COALESCE(m.pairing_published_at, now()) FROM games g WHERE m.game_id = g.id AND m.card_id = ? AND g.game_number = ?",
            cardId, card.currentGame());
        jdbc.update("UPDATE games SET status = 'OPEN' WHERE card_id = ? AND game_number = ?", cardId, card.currentGame());
        jdbc.update("UPDATE tournament_cards SET status = 'RUNNING', runtime_stage = 'RESULT_COLLECTION', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        List<Integer> resultGames = activeResultGames(card);
        audit(cardId, actor, "CONFIRM_PAIRING", "preview", Map.of(
            "publishedPairingGame", card.currentGame(),
            "resultCollectionGames", resultGames
        ));
        return get(cardId, true);
    }

    /**
     * Edit-pairing during result collection when NO result is recorded yet for the current game:
     * revert RESULT_COLLECTION -> PAIRING_PREVIEW for that game so the director can re-edit the pairing
     * on the preview page. If any result exists, the caller must use swap instead. Director-only upstream.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse unpairToPreview(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_COLLECTION);
        List<Integer> games = activeResultGames(card);
        long results = count("""
            SELECT COUNT(*) FROM match_results r JOIN matches m ON m.id = r.match_id JOIN games g ON g.id = m.game_id
            WHERE m.card_id = ? AND g.game_number BETWEEN ? AND ? AND m.snapshot_id IS NULL
            """, cardId, games.get(0), games.get(games.size() - 1));
        if (results > 0)
            throw new IllegalArgumentException("เกมนี้มีการกรอกผลแล้ว — ใช้การสลับผู้เล่น (Swap) แทนการยกเลิกการจับคู่");
        if (card.currentGame() == 1) {
            // Game 1 preview re-derives pairs from competition_tables seats, so drop the matches confirm created.
            jdbc.update("DELETE FROM matches m USING games g WHERE m.game_id = g.id AND m.card_id = ? AND g.game_number = 1 AND m.snapshot_id IS NULL", cardId);
        } else {
            jdbc.update("UPDATE matches m SET pairing_published_at = NULL FROM games g WHERE m.game_id = g.id AND m.card_id = ? AND g.game_number = ?", cardId, card.currentGame());
        }
        jdbc.update("UPDATE games SET status = 'PENDING' WHERE card_id = ? AND game_number = ?", cardId, card.currentGame());
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'PAIRING_PREVIEW', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        audit(cardId, actor, "UNPAIR_TO_PREVIEW", "result collection เกม " + card.currentGame(), "กลับสู่ pairing preview");
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.ResultPatch submitResult(UUID cardId, UUID matchId, CardDtos.ResultRequest request, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_COLLECTION);
        int scoreOne = request.scoreOne();
        int scoreTwo = request.scoreTwo();
        MatchPlayers match;
        try {
            match = jdbc.queryForObject("""
                SELECT m.player_one_id, m.player_two_id, p1.external_id one_external, p2.external_id two_external,
                       m.snapshot_id, g.game_number, g.max_diff, m.table_number
                FROM matches m JOIN games g ON g.id = m.game_id
                LEFT JOIN players p1 ON p1.id = m.player_one_id LEFT JOIN players p2 ON p2.id = m.player_two_id
                WHERE m.id = ? AND m.card_id = ?
                """, (rs, row) -> new MatchPlayers(rs.getObject("player_one_id", UUID.class), rs.getObject("player_two_id", UUID.class),
                rs.getString("one_external"), rs.getString("two_external"), rs.getObject("snapshot_id", UUID.class),
                rs.getInt("game_number"), rs.getInt("max_diff"), rs.getInt("table_number")), matchId, cardId);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Match not found");
        }
        if (match.oneId() == null || match.twoId() == null)
            throw new IllegalArgumentException("คู่แข่งขันของเกมนี้ยังไม่ครบ รอผลจาก Game ต้นทางก่อน");
        if (match.snapshotId() != null) throw new IllegalArgumentException("Confirmed results are immutable");
        List<Integer> activeGames = activeResultGames(card);
        if (!activeGames.contains(match.gameNumber()))
            throw new IllegalArgumentException("แก้ผลได้เฉพาะเกมใน Result block ปัจจุบัน " + activeGames);
        boolean existing = count("SELECT COUNT(*) FROM match_results WHERE match_id = ?", matchId) > 0;
        if (existing && !request.editExisting()) throw new IllegalArgumentException("กรุณากด Edit ก่อนแก้ไขผลที่บันทึกแล้ว");
        Object previousResult = existing ? jdbc.queryForMap("""
            SELECT r.score_one AS "scoreOne", r.score_two AS "scoreTwo", r.result_type AS "resultType",
                   r.calculated_diff AS "calculatedDiff", pw.external_id AS "winnerId"
            FROM match_results r LEFT JOIN players pw ON pw.id = r.winner_id WHERE r.match_id = ?
            """, matchId) : Map.of("matchId", matchId.toString(), "status", "UNRECORDED");
        boolean draw = scoreOne == scoreTwo;
        UUID winner = draw ? null : scoreOne > scoreTwo ? match.oneId() : match.twoId();
        String winnerExternal = draw ? null : scoreOne > scoreTwo ? match.oneExternal() : match.twoExternal();
        String resultType = draw ? "DRAW" : "WIN";
        int calculatedDiff = Math.min(Math.abs(scoreOne - scoreTwo), match.maxDiff());

        int changed = jdbc.update("""
            UPDATE match_results SET winner_id = ?, score_one = ?, score_two = ?, result_type = ?, calculated_diff = ?,
                                     submitted_by = ?, submitted_at = now(), version = version + 1
            WHERE match_id = ?
            """, winner, scoreOne, scoreTwo, resultType, calculatedDiff, actor, matchId);
        if (changed == 0) jdbc.update("""
            INSERT INTO match_results (id, match_id, winner_id, score_one, score_two, result_type, calculated_diff, submitted_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, UUID.randomUUID(), matchId, winner, scoreOne, scoreTwo, resultType, calculatedDiff, actor);
        touch(cardId);
        Map<String, Object> calculatedResult = new LinkedHashMap<>();
        calculatedResult.put("scoreOne", scoreOne);
        calculatedResult.put("scoreTwo", scoreTwo);
        calculatedResult.put("resultType", resultType);
        calculatedResult.put("winnerId", winnerExternal);
        calculatedResult.put("calculatedDiff", calculatedDiff);
        calculatedResult.put("maxDiff", match.maxDiff());
        audit(cardId, actor, existing ? "EDIT_RESULT" : "SUBMIT_RESULT", previousResult, calculatedResult);
        boolean updatesPairResultDestination =
            match.gameNumber() == card.currentGame() && isOutgoingPairResult(cardId, card.currentGame());
        if (updatesPairResultDestination)
            syncPairResultSource(cardId, card.currentGame(), match.tableNumber());
        publishPublic(cardId);
        // A normal save changes one row. PAIR_RESULT can additionally materialize/update two
        // destination rows. Broadcasting only those rows keeps SSE traffic bounded at O(1).
        int destinationGame = updatesPairResultDestination ? card.currentGame() + 1 : -1;
        int destinationGroupStart = updatesPairResultDestination
            ? ((match.tableNumber() - 1) / 2) * 2 + 1
            : -1;
        return new CardDtos.ResultPatch(cardVersion(cardId),
            changedResultPairings(cardId, matchId, destinationGame, destinationGroupStart));
    }

    private List<CardDtos.PairingResponse> changedResultPairings(
        UUID cardId, UUID sourceMatchId, int destinationGame, int destinationGroupStart
    ) {
        return jdbc.query("""
            SELECT m.id, g.game_number, m.table_number, p1.external_id player_one, p2.external_id player_two,
                   pw.external_id winner, r.score_one, r.score_two, r.result_type, r.calculated_diff,
                   m.snapshot_id, m.pairing_published_at, s.confirmed_at
            FROM matches m JOIN games g ON g.id = m.game_id
            LEFT JOIN players p1 ON p1.id = m.player_one_id LEFT JOIN players p2 ON p2.id = m.player_two_id
            LEFT JOIN match_results r ON r.match_id = m.id LEFT JOIN players pw ON pw.id = r.winner_id
            LEFT JOIN pairing_snapshots s ON s.id = m.snapshot_id
            WHERE m.card_id = ? AND m.snapshot_id IS NULL
              AND (m.id = ? OR (g.game_number = ? AND m.table_number IN (?, ?)))
            ORDER BY g.game_number, m.table_number
            """, (rs, row) -> new PairingRow(rs.getObject("id", UUID.class), rs.getInt("game_number"), rs.getInt("table_number"),
                rs.getString("player_one"), rs.getString("player_two"), rs.getString("winner"), nullableInt(rs, "score_one"),
                nullableInt(rs, "score_two"), rs.getString("result_type"), nullableInt(rs, "calculated_diff"),
                rs.getObject("snapshot_id", UUID.class), rs.getTimestamp("pairing_published_at"), rs.getTimestamp("confirmed_at")),
            cardId, sourceMatchId, destinationGame, destinationGroupStart, destinationGroupStart + 1)
            .stream().map(row -> toPairingResponse(row, true)).toList();
    }

    @Transactional
    public CardDtos.CardResponse reviewResults(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_COLLECTION);
        List<Integer> games = activeResultGames(card);
        int firstGame = games.get(0);
        int lastGame = games.get(games.size() - 1);
        long expected = count("SELECT COUNT(*) FROM players WHERE card_id = ?", cardId) / 2 * games.size();
        long total = count("SELECT COUNT(*) FROM matches m JOIN games g ON g.id = m.game_id WHERE m.card_id = ? AND g.game_number BETWEEN ? AND ? AND m.snapshot_id IS NULL",
            cardId, firstGame, lastGame);
        long completed = count("""
            SELECT COUNT(*) FROM matches m JOIN games g ON g.id = m.game_id JOIN match_results r ON r.match_id = m.id
            WHERE m.card_id = ? AND g.game_number BETWEEN ? AND ? AND m.snapshot_id IS NULL
              AND r.result_type IN ('WIN', 'DRAW') AND r.calculated_diff IS NOT NULL
            """, cardId, firstGame, lastGame);
        if (total != expected || completed != expected)
            throw new IllegalArgumentException("ต้องบันทึกผลให้ครบทุกคู่ของเกม " + games + " ก่อน Review (" + completed + "/" + expected + ")");
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'RESULT_REVIEW', version = version + 1 WHERE id = ?", cardId);
        audit(cardId, actor, "REVIEW_RESULTS", completed + " results", "ready to publish games " + games);
        return get(cardId, true);
    }

    @Transactional
    public CardDtos.CardResponse reopenResults(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_REVIEW);
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'RESULT_COLLECTION', version = version + 1 WHERE id = ?", cardId);
        audit(cardId, actor, "REOPEN_RESULTS", "review", "edit game " + card.currentGame());
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse publishResults(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_REVIEW);
        var rows = pairingRows(cardId, true);
        List<Integer> gameNumbers = activeResultGames(card);
        var current = rows.stream().filter(row -> gameNumbers.contains(row.gameNumber())).toList();
        if (current.isEmpty()) throw new IllegalArgumentException("No pairing preview exists for the current game");
        var bundleRows = rows.stream().filter(row -> row.snapshotId() == null && gameNumbers.contains(row.gameNumber())).toList();
        long expected = count("SELECT COUNT(*) FROM players WHERE card_id = ?", cardId) / 2 * gameNumbers.size();
        if (bundleRows.size() != expected)
            throw new IllegalArgumentException("Pairing block ไม่ครบ: พบ " + bundleRows.size() + " จาก " + expected + " คู่");
        if (bundleRows.stream().anyMatch(row -> row.scoreOne() == null || row.scoreTwo() == null || row.resultType() == null))
            throw new IllegalArgumentException("Every match requires a calculated result before confirmation");

        jdbc.update("""
            UPDATE matches m SET pairing_published_at = COALESCE(m.pairing_published_at, now())
            FROM games g WHERE m.game_id = g.id AND m.card_id = ? AND g.game_number BETWEEN ? AND ?
            """, cardId, gameNumbers.get(0), gameNumbers.get(gameNumbers.size() - 1));

        UUID snapshotId = UUID.randomUUID();
        UUID bundleKey = UUID.randomUUID();
        var responsePairs = bundleRows.stream().map(this::toPairingResponse).toList();
        String payload = json(responsePairs);
        String hash = sha256(payload);
        Integer[] games = gameNumbers.toArray(Integer[]::new);
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                INSERT INTO pairing_snapshots (id, card_id, bundle_key, game_numbers, payload, confirmed_at, payload_hash)
                VALUES (?, ?, ?, ?, CAST(? AS jsonb), now(), ?)
                """);
            statement.setObject(1, snapshotId);
            statement.setObject(2, cardId);
            statement.setObject(3, bundleKey);
            Array sqlArray = connection.createArrayOf("integer", games);
            statement.setArray(4, sqlArray);
            statement.setString(5, payload);
            statement.setString(6, hash);
            return statement;
        });
        for (PairingRow row : bundleRows) jdbc.update("UPDATE matches SET snapshot_id = ? WHERE id = ?", snapshotId, row.id());
        for (int game : gameNumbers) jdbc.update("UPDATE games SET status = 'COMPLETED' WHERE card_id = ? AND game_number = ?", cardId, game);
        int last = gameNumbers.get(gameNumbers.size() - 1);
        boolean finished = last >= card.numberOfGames();
        recalculateStandings(cardId);
        // If the card has a final round, the last regular game leads to FINAL_SEEDING (director then starts it),
        // not straight to FINAL_PUBLISHED.
        boolean hasFinal = finished && !"NONE".equals(card.finalType());
        jdbc.update("""
            UPDATE tournament_cards SET current_game = ?, status = ?, runtime_stage = ?, version = version + 1 WHERE id = ?
            """, finished ? last : last + 1,
            (!finished || hasFinal) ? "RUNNING" : "FINISHED",
            !finished ? "TABLE_PAIRING" : (hasFinal ? "FINAL_SEEDING" : "FINAL_PUBLISHED"), cardId);
        publishPublic(cardId);
        if (!finished) jdbc.update("DELETE FROM competition_tables WHERE card_id = ?", cardId);
        audit(cardId, actor, finished ? "PUBLISH_FINAL_RESULTS" : "PUBLISH_GAME_RESULTS", "game " + gameNumbers + " review", hash);
        return get(cardId, true);
    }

    // ---- Final / championship round ----

    /** Director starts the final: lock seeds (top 2 / top 4 from standings) into the bracket. */
    @Transactional
    public CardDtos.CardResponse startFinalRound(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.FINAL_SEEDING);
        int slotCount = "CHAMPION_AND_THIRD".equals(card.finalType()) ? 2 : 1;
        int needed = slotCount * 2;
        List<UUID> seeds = jdbc.queryForList("""
            SELECT player_id FROM standings WHERE card_id = ?
            ORDER BY rank NULLS LAST, win_points DESC, diff DESC LIMIT ?
            """, UUID.class, cardId, needed);
        if (seeds.size() < needed)
            throw new IllegalArgumentException("ผู้เล่นไม่พอสำหรับรอบชิง (ต้องการ " + needed + " คน มี " + seeds.size() + " คน)");
        jdbc.update("DELETE FROM final_game_results WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM final_pairings WHERE card_id = ?", cardId);
        for (int slot = 0; slot < slotCount; slot++) {
            jdbc.update("INSERT INTO final_pairings (id, card_id, slot, player_one_id, player_two_id) VALUES (?, ?, ?, ?, ?)",
                UUID.randomUUID(), cardId, slot, seeds.get(slot * 2), seeds.get(slot * 2 + 1));
            for (int game = 1; game <= card.finalGames(); game++)
                jdbc.update("INSERT INTO final_game_results (id, card_id, slot, game_index) VALUES (?, ?, ?, ?)",
                    UUID.randomUUID(), cardId, slot, game);
        }
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'FINAL_COLLECTION', version = version + 1 WHERE id = ?", cardId);
        audit(cardId, actor, "START_FINAL", null, "seeds=" + needed);
        return get(cardId, true);
    }

    /** Record one final game's scores (no max diff; per-game winner is derived from the scores). */
    @Transactional
    public CardDtos.CardResponse submitFinalResult(UUID cardId, int slot, int gameIndex, int scoreOne, int scoreTwo, String actor) {
        requireStage(cardId, RuntimeStage.FINAL_COLLECTION);
        int updated = jdbc.update("UPDATE final_game_results SET score_one = ?, score_two = ? WHERE card_id = ? AND slot = ? AND game_index = ?",
            scoreOne, scoreTwo, cardId, slot, gameIndex);
        if (updated == 0) throw new IllegalArgumentException("ไม่พบช่องผลรอบชิงนี้");
        touch(cardId);
        audit(cardId, actor, "FINAL_RESULT", null, "slot " + slot + " game " + gameIndex + " = " + scoreOne + ":" + scoreTwo);
        return get(cardId, true);
    }

    /** Manual conclusion: the director/staff picks the winner of a final pairing (criteria vary). */
    @Transactional
    public CardDtos.CardResponse setFinalWinner(UUID cardId, int slot, String winnerExternalId, String actor) {
        requireStage(cardId, RuntimeStage.FINAL_COLLECTION);
        UUID winnerId = jdbc.query("SELECT id FROM players WHERE card_id = ? AND external_id = ?",
            (rs, row) -> rs.getObject("id", UUID.class), cardId, winnerExternalId).stream().findFirst().orElse(null);
        if (winnerId == null) throw new IllegalArgumentException("ไม่พบผู้เล่น");
        int updated = jdbc.update("""
            UPDATE final_pairings SET winner_id = ? WHERE card_id = ? AND slot = ? AND (player_one_id = ? OR player_two_id = ?)
            """, winnerId, cardId, slot, winnerId, winnerId);
        if (updated == 0) throw new IllegalArgumentException("ผู้ชนะต้องเป็นหนึ่งในผู้เข้าชิงของคู่นี้");
        touch(cardId);
        audit(cardId, actor, "FINAL_WINNER", null, "slot " + slot + " winner " + winnerExternalId);
        return get(cardId, true);
    }

    /** Finish the final once every pairing has a manually-decided winner. */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse publishFinalRound(UUID cardId, String actor) {
        requireStage(cardId, RuntimeStage.FINAL_COLLECTION);
        if (count("SELECT COUNT(*) FROM final_pairings WHERE card_id = ? AND winner_id IS NULL", cardId) > 0)
            throw new IllegalArgumentException("ต้องสรุปผู้ชนะให้ครบทุกคู่ก่อนเผยแพร่");
        jdbc.update("UPDATE tournament_cards SET status = 'FINISHED', runtime_stage = 'FINAL_PUBLISHED', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        audit(cardId, actor, "PUBLISH_FINAL", null, "final published");
        return get(cardId, true);
    }

    /**
     * Un-pairing discards only the current, unpublished pairing preview. Published results and
     * snapshots from earlier games are immutable here; correcting those uses the result override flow.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse undoPairing(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.PAIRING_PREVIEW);
        requireRegularEditable(cardId);

        deleteUnpublishedMatches(cardId, card.currentGame() - 1);
        if (card.currentGame() == 1)
            jdbc.update("DELETE FROM competition_tables WHERE card_id = ?", cardId);
        jdbc.update("UPDATE games SET status = 'PENDING' WHERE card_id = ? AND game_number >= ?", cardId, card.currentGame());
        jdbc.update("""
            UPDATE tournament_cards SET runtime_stage = 'TABLE_PAIRING', version = version + 1 WHERE id = ?
            """, cardId);
        publishPublic(cardId);
        audit(cardId, actor, "UNDO_PAIRING", "preview เกม " + card.currentGame(), "กลับสู่ TABLE_PAIRING เกม " + card.currentGame());
        return get(cardId, true);
    }

    /**
     * Director override: edit any match result at any time (including a published game), recalculating
     * standings. Pairings are NOT regenerated; to re-pair from the new standings, undo the pairing first.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse overrideResult(UUID cardId, UUID matchId, CardDtos.ResultRequest request, String actor) {
        ensureEditable(cardId);
        requireRegularEditable(cardId);
        MatchPlayers match;
        try {
            match = jdbc.queryForObject("""
                SELECT m.player_one_id, m.player_two_id, p1.external_id one_external, p2.external_id two_external,
                       m.snapshot_id, g.game_number, g.max_diff, m.table_number
                FROM matches m JOIN games g ON g.id = m.game_id
                LEFT JOIN players p1 ON p1.id = m.player_one_id LEFT JOIN players p2 ON p2.id = m.player_two_id
                WHERE m.id = ? AND m.card_id = ?
                """, (rs, row) -> new MatchPlayers(rs.getObject("player_one_id", UUID.class), rs.getObject("player_two_id", UUID.class),
                rs.getString("one_external"), rs.getString("two_external"), rs.getObject("snapshot_id", UUID.class),
                rs.getInt("game_number"), rs.getInt("max_diff"), rs.getInt("table_number")), matchId, cardId);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Match not found");
        }
        if (match.oneId() == null || match.twoId() == null)
            throw new IllegalArgumentException("คู่แข่งขันนี้ยังไม่ครบ");
        int scoreOne = request.scoreOne();
        int scoreTwo = request.scoreTwo();
        boolean draw = scoreOne == scoreTwo;
        UUID winner = draw ? null : scoreOne > scoreTwo ? match.oneId() : match.twoId();
        String winnerExternal = draw ? null : scoreOne > scoreTwo ? match.oneExternal() : match.twoExternal();
        String resultType = draw ? "DRAW" : "WIN";
        int calculatedDiff = Math.min(Math.abs(scoreOne - scoreTwo), match.maxDiff());
        boolean existing = count("SELECT COUNT(*) FROM match_results WHERE match_id = ?", matchId) > 0;
        Object previous = existing ? jdbc.queryForMap("""
            SELECT r.score_one AS "scoreOne", r.score_two AS "scoreTwo", r.result_type AS "resultType",
                   r.calculated_diff AS "calculatedDiff", pw.external_id AS "winnerId"
            FROM match_results r LEFT JOIN players pw ON pw.id = r.winner_id WHERE r.match_id = ?
            """, matchId) : Map.of("matchId", matchId.toString(), "status", "UNRECORDED");
        int changed = jdbc.update("""
            UPDATE match_results SET winner_id = ?, score_one = ?, score_two = ?, result_type = ?, calculated_diff = ?,
                                     submitted_by = ?, submitted_at = now(), version = version + 1
            WHERE match_id = ?
            """, winner, scoreOne, scoreTwo, resultType, calculatedDiff, actor, matchId);
        if (changed == 0) jdbc.update("""
            INSERT INTO match_results (id, match_id, winner_id, score_one, score_two, result_type, calculated_diff, submitted_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, UUID.randomUUID(), matchId, winner, scoreOne, scoreTwo, resultType, calculatedDiff, actor);
        recalculateStandings(cardId);
        touch(cardId);
        publishPublic(cardId);
        Map<String, Object> calculated = new LinkedHashMap<>();
        calculated.put("scoreOne", scoreOne);
        calculated.put("scoreTwo", scoreTwo);
        calculated.put("resultType", resultType);
        calculated.put("winnerId", winnerExternal);
        calculated.put("calculatedDiff", calculatedDiff);
        calculated.put("game", match.gameNumber());
        audit(cardId, actor, "OVERRIDE_RESULT", previous, calculated);
        return get(cardId, true);
    }

    private void deleteUnpublishedMatches(UUID cardId, int afterGame) {
        jdbc.update("""
            DELETE FROM match_results WHERE match_id IN (
              SELECT m.id FROM matches m JOIN games g ON g.id = m.game_id
              WHERE m.card_id = ? AND m.snapshot_id IS NULL AND g.game_number > ?)
            """, cardId, afterGame);
        jdbc.update("""
            DELETE FROM matches m USING games g
            WHERE m.game_id = g.id AND m.card_id = ? AND m.snapshot_id IS NULL AND g.game_number > ?
            """, cardId, afterGame);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse close(UUID cardId, String actor) {
        CardRow card = cardRow(cardId);
        if (card.status() != CardStatus.FINISHED) throw new IllegalArgumentException("Only a finished card can be closed");
        jdbc.update("UPDATE tournament_cards SET status = 'CLOSED', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        audit(cardId, actor, "CLOSE_CARD", card.status().name(), "CLOSED");
        return get(cardId, true);
    }

    /** Permanently removes a card and every row tied to it (players, pairings, results, standings, audit logs). */
    @Transactional
    @Caching(evict = {
        @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_DETAILS, key = "#cardId"),
        @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_CATALOG, allEntries = true),
        @CacheEvict(cacheNames = TournamentCaches.PUBLIC_CARD_VERSIONS, allEntries = true)
    })
    public void delete(UUID cardId) {
        cardRow(cardId); // 404 + row lock if the card does not exist
        jdbc.update("DELETE FROM match_results WHERE match_id IN (SELECT id FROM matches WHERE card_id = ?)", cardId);
        jdbc.update("DELETE FROM matches WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM standings WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM table_players WHERE table_id IN (SELECT id FROM competition_tables WHERE card_id = ?)", cardId);
        jdbc.update("DELETE FROM competition_tables WHERE card_id = ?", cardId);
        // pairing_snapshots are append-only; the trigger only permits deletion under this flag.
        jdbc.execute("SET LOCAL app.allow_snapshot_delete = 'on'");
        jdbc.update("DELETE FROM pairing_snapshots WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM final_game_results WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM final_pairings WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM players WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM pairing_rules WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM games WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM audit_logs WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM tournament_cards WHERE id = ?", cardId);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse generateTestPlayers(UUID cardId, int amount, String actor) {
        if (amount != 300 && amount != 400 && amount != 1000)
            throw new IllegalArgumentException("Test player count must be 300, 400 or 1000");
        resetRuntimeData(cardId, actor, false);
        jdbc.update("DELETE FROM standings WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM players WHERE card_id = ?", cardId);
        String division = cardDivision(cardId);
        String[] firstNames = {"กฤต", "ชนัญญา", "ธนภัทร", "ปุณณวิช", "พิมพ์ชนก", "รวิศ", "ศิริน", "ณัฐดนัย"};
        String[] lastNames = {"อนันต์กุล", "บุญรักษา", "วัฒนชัย", "ศรีสุข", "ธรรมวงศ์", "ชูเกียรติ"};
        String[] schools = {"สาธิตพัฒนา", "วิทยาคม", "อนุสรณ์ศึกษา", "ประชารัฐ", "วชิรวิทย์", "เทพศิรินทร์"};
        for (int index = 0; index < amount; index++) {
            UUID playerId = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO players (id, card_id, external_id, first_name, last_name, school, division)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """, playerId, cardId, "P" + String.format("%03d", index + 1), firstNames[index % firstNames.length],
                lastNames[(index * 3) % lastNames.length], schools[(index * 5 + index / 4) % schools.length], division);
            jdbc.update("INSERT INTO standings (id, card_id, player_id) VALUES (?, ?, ?)", UUID.randomUUID(), cardId, playerId);
        }
        touch(cardId);
        publishPublic(cardId);
        audit(cardId, actor, "GENERATE_TEST_PLAYERS", null, amount + " players");
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse resetRuntime(UUID cardId, String actor) {
        resetRuntimeData(cardId, actor, true);
        publishPublic(cardId);
        return get(cardId, true);
    }

    @Transactional
    public CardDtos.CardResponse autoResults(UUID cardId, String actor) {
        CardRow card = cardRow(cardId);
        List<Integer> games = activeResultGames(card);
        int generated = 0;
        while (true) {
            AutoMatch match = jdbc.query("""
                SELECT m.id, p1.external_id one_id, p2.external_id two_id, m.table_number
                FROM matches m JOIN games g ON g.id = m.game_id
                JOIN players p1 ON p1.id = m.player_one_id JOIN players p2 ON p2.id = m.player_two_id
                LEFT JOIN match_results r ON r.match_id = m.id
                WHERE m.card_id = ? AND g.game_number BETWEEN ? AND ? AND m.snapshot_id IS NULL AND r.id IS NULL
                ORDER BY g.game_number, m.table_number LIMIT 1
                """, (rs, row) -> new AutoMatch(rs.getObject("id", UUID.class), rs.getString("one_id"), rs.getString("two_id"), rs.getInt("table_number")),
                cardId, games.get(0), games.get(games.size() - 1)).stream().findFirst().orElse(null);
            if (match == null) break;
            boolean firstWins = match.tableNumber() % 2 == 1;
            submitResult(cardId, match.id(), new CardDtos.ResultRequest(
                firstWins ? 100 : 72, firstWins ? 72 : 100, false), actor);
            generated++;
        }
        if (generated == 0) throw new IllegalArgumentException("Open the current result block before generating results");
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse simulate(UUID cardId, String actor) {
        resetRuntimeData(cardId, actor, false);
        CardRow card = cardRow(cardId);
        if (count("SELECT COUNT(*) FROM players WHERE card_id = ?", cardId) < 2)
            throw new IllegalArgumentException("Add players before simulation");
        finishRegistration(cardId, actor);
        while (cardRow(cardId).status() != CardStatus.FINISHED) {
            generatePairingPreview(cardId, actor);
            confirmPairingPreview(cardId, actor);
            autoResults(cardId, actor);
            reviewResults(cardId, actor);
            publishResults(cardId, actor);
        }
        audit(cardId, actor, "SIMULATE_TOURNAMENT", "DRAFT", "FINISHED");
        return get(cardId, true);
    }

    private void resetRuntimeData(UUID cardId, String actor, boolean writeAudit) {
        if (cardRow(cardId).status() == CardStatus.CLOSED) throw new IllegalArgumentException("Closed cards cannot be reset");
        jdbc.update("DELETE FROM match_results WHERE match_id IN (SELECT id FROM matches WHERE card_id = ?)", cardId);
        jdbc.update("DELETE FROM matches WHERE card_id = ?", cardId);
        jdbc.execute("SET LOCAL app.allow_snapshot_delete = 'on'");
        jdbc.update("DELETE FROM pairing_snapshots WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM competition_tables WHERE card_id = ?", cardId);
        jdbc.update("UPDATE standings SET wins = 0, draws = 0, losses = 0, win_points = 0, diff = 0, rank = NULL, recalculated_at = now() WHERE card_id = ?", cardId);
        jdbc.update("UPDATE games SET status = 'PENDING' WHERE card_id = ?", cardId);
        jdbc.update("UPDATE tournament_cards SET status = 'DRAFT', runtime_stage = 'PLAYER_REGISTRATION', current_game = 1, version = version + 1 WHERE id = ?", cardId);
        if (writeAudit) audit(cardId, actor, "RESET_CARD", null, "runtime reset");
    }

    private List<Integer> activeResultGames(CardRow card) {
        if (card.currentGame() < card.numberOfGames() && isOutgoingPairResult(card.id(), card.currentGame()))
            return List.of(card.currentGame(), card.currentGame() + 1);
        return List.of(card.currentGame());
    }

    private boolean hasPairResultRule(UUID cardId) {
        return count("SELECT COUNT(*) FROM pairing_rules WHERE card_id = ? AND rule_type = 'PAIR_RESULT'", cardId) > 0;
    }

    private boolean isOutgoingPairResult(UUID cardId, int sourceGame) {
        return count("SELECT COUNT(*) FROM pairing_rules WHERE card_id = ? AND from_game = ? AND rule_type = 'PAIR_RESULT'", cardId, sourceGame) > 0;
    }

    private void syncPairResultSource(UUID cardId, int sourceGame, int sourceTableNumber) {
        int groupStart = ((sourceTableNumber - 1) / 2) * 2 + 1;
        PairResultSource source = jdbc.query("""
            SELECT m.table_number, m.player_one_id, m.player_two_id, r.winner_id, r.result_type
            FROM matches m JOIN games g ON g.id = m.game_id
            JOIN match_results r ON r.match_id = m.id
            WHERE m.card_id = ? AND g.game_number = ? AND m.table_number = ?
            """, (rs, row) -> new PairResultSource(
                rs.getInt("table_number"), rs.getObject("player_one_id", UUID.class), rs.getObject("player_two_id", UUID.class),
                rs.getObject("winner_id", UUID.class), rs.getString("result_type")
            ), cardId, sourceGame, sourceTableNumber).stream().findFirst().orElse(null);
        if (source == null || source.resultType() == null) return;

        PairResultSlots slots = pairResultSlots(source);
        int destinationGame = sourceGame + 1;
        UUID destinationGameId = gameId(cardId, destinationGame);
        int slotNumber = source.tableNumber() == groupStart ? 1 : 2;
        boolean upperChanged = syncPairResultSlot(cardId, destinationGameId, groupStart, slotNumber, slots.upper());
        boolean lowerChanged = syncPairResultSlot(cardId, destinationGameId, groupStart + 1, slotNumber, slots.lower());
        jdbc.update("UPDATE games SET status = 'OPEN' WHERE card_id = ? AND game_number = ?", cardId, destinationGame);
        if (upperChanged || lowerChanged)
            audit(cardId, "system", "MATERIALIZE_PAIR_RESULT_SOURCE", null, Map.of(
                "sourceGame", sourceGame,
                "sourceTable", source.tableNumber(),
                "destinationGame", destinationGame,
                "destinationTables", List.of(groupStart, groupStart + 1),
                "slot", slotNumber
            ));
    }

    private PairResultSlots pairResultSlots(PairResultSource source) {
        UUID upper = source.winnerId() != null ? source.winnerId() : source.oneId();
        UUID lower = upper.equals(source.oneId()) ? source.twoId() : source.oneId();
        return new PairResultSlots(upper, lower);
    }

    private boolean syncPairResultSlot(UUID cardId, UUID gameId, int tableNumber, int slotNumber, UUID playerId) {
        PairResultDestination existing = jdbc.query("""
            SELECT m.id, m.player_one_id, m.player_two_id, (r.id IS NOT NULL) has_result
            FROM matches m LEFT JOIN match_results r ON r.match_id = m.id
            WHERE m.game_id = ? AND m.table_number = ?
            """, (rs, row) -> new PairResultDestination(
                rs.getObject("id", UUID.class), rs.getObject("player_one_id", UUID.class), rs.getObject("player_two_id", UUID.class), rs.getBoolean("has_result")
            ), gameId, tableNumber).stream().findFirst().orElse(null);
        if (existing == null) {
            UUID one = slotNumber == 1 ? playerId : null;
            UUID two = slotNumber == 2 ? playerId : null;
            jdbc.update("""
                INSERT INTO matches (id, card_id, game_id, table_number, player_one_id, player_two_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """, UUID.randomUUID(), cardId, gameId, tableNumber, one, two);
            return true;
        }
        UUID current = slotNumber == 1 ? existing.oneId() : existing.twoId();
        UUID other = slotNumber == 1 ? existing.twoId() : existing.oneId();
        if (Objects.equals(current, playerId)) return false;
        if (existing.hasResult())
            throw new IllegalArgumentException("ผล Game ถัดไปถูกบันทึกแล้ว จึงเปลี่ยนผู้ชนะ/ผู้แพ้ของ Game ต้นทางไม่ได้");
        if (Objects.equals(other, playerId))
            throw new IllegalArgumentException("PAIR_RESULT ทำให้ผู้เล่นคนเดียวกันอยู่สองฝั่งในคู่เดียวกัน กรุณาตรวจ Game ต้นทาง");
        if (slotNumber == 1) jdbc.update("UPDATE matches SET player_one_id = ? WHERE id = ?", playerId, existing.id());
        else jdbc.update("UPDATE matches SET player_two_id = ? WHERE id = ?", playerId, existing.id());
        return true;
    }

    private PairingRuleType generateSystemMatches(UUID cardId, int gameNumber) {
        if (count("SELECT COUNT(*) FROM matches m JOIN games g ON g.id = m.game_id WHERE m.card_id = ? AND g.game_number = ?", cardId, gameNumber) > 0)
            throw new IllegalArgumentException("มี pairing ของเกมนี้อยู่แล้ว");
        var scores = loadScores(cardId);
        var history = jdbc.query("SELECT player_one_id, player_two_id FROM matches WHERE card_id = ? AND player_one_id IS NOT NULL AND player_two_id IS NOT NULL",
            (rs, row) -> new PairingStrategy.Pair(rs.getObject("player_one_id", UUID.class).toString(), rs.getObject("player_two_id", UUID.class).toString()), cardId);
        PairingRuleType appliedRule = ruleForGame(cardId, gameNumber);
        if (appliedRule == PairingRuleType.PAIR_RESULT)
            throw new IllegalArgumentException("เกมแบบแพ้เจอแพ้/ชนะเจอชนะต้องถูกสร้างจากผลของเกมก่อนหน้าโดยอัตโนมัติ");
        var context = new PairingStrategy.PairingContext(gameNumber, history);
        var pairs = applyGibsonPairing(cardId, gameNumber, scores, context, appliedRule);
        UUID gameId = gameId(cardId, gameNumber);
        for (int index = 0; index < pairs.size(); index++) {
            var pair = pairs.get(index);
            jdbc.update("""
                INSERT INTO matches (id, card_id, game_id, table_number, player_one_id, player_two_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """, UUID.randomUUID(), cardId, gameId, index + 1, UUID.fromString(pair.playerOneId()), UUID.fromString(pair.playerTwoId()));
        }
        return appliedRule;
    }

    /**
     * If Gibsonization is enabled and the maths prove a player has CLINCHED a top-K finish, pull each such
     * leader out and pair them with the lowest out-of-contention player (Gibson pairing) so their spread
     * cannot reorder the remaining contenders; the rest are paired by the normal strategy. Falls back to
     * the plain strategy when disabled, when nobody has clinched, or when there is no eliminated opponent.
     */
    private List<PairingStrategy.Pair> applyGibsonPairing(UUID cardId, int gameNumber, List<PairingStrategy.PlayerScore> scores,
                                                          PairingStrategy.PairingContext context, PairingRuleType appliedRule) {
        PairingStrategy strategy = strategies.resolve(appliedRule);
        CardRow card = cardRow(cardId);
        if (!card.gibsonEnabled()) return strategy.generate(scores, context);

        int qualifyCut = "CHAMPION_AND_THIRD".equals(card.finalType()) ? 4 : "CHAMPION".equals(card.finalType()) ? 2 : 1;
        int remainingGames = card.numberOfGames() - gameNumber + 1;
        Long maxDiffSum = jdbc.queryForObject("SELECT COALESCE(SUM(max_diff), 0) FROM games WHERE card_id = ? AND game_number BETWEEN ? AND ?",
            Long.class, cardId, gameNumber, card.numberOfGames());
        List<GibsonAnalysis.PlayerStanding> standings = scores.stream()
            .map(score -> new GibsonAnalysis.PlayerStanding(score.playerId(), score.winPoints(), score.diff())).toList();
        GibsonAnalysis.Result analysis = GibsonAnalysis.analyze(standings, remainingGames, maxDiffSum == null ? 0L : maxDiffSum, qualifyCut);
        if (analysis.gibsonized().isEmpty() || analysis.eliminated().isEmpty()) return strategy.generate(scores, context);

        Comparator<PairingStrategy.PlayerScore> ranking = Comparator.comparingInt(PairingStrategy.PlayerScore::winPoints).reversed()
            .thenComparing(Comparator.comparingInt(PairingStrategy.PlayerScore::diff).reversed())
            .thenComparing(PairingStrategy.PlayerScore::playerId);
        List<PairingStrategy.PlayerScore> ranked = scores.stream().sorted(ranking).toList();
        List<PairingStrategy.PlayerScore> clinched = ranked.stream().filter(player -> analysis.gibsonized().contains(player.playerId())).toList();
        List<PairingStrategy.PlayerScore> deadPool = new ArrayList<>(ranked.stream().filter(player -> analysis.eliminated().contains(player.playerId())).toList());
        Collections.reverse(deadPool); // lowest-ranked out-of-contention player first

        Set<String> used = new HashSet<>();
        List<PairingStrategy.Pair> gibsonPairs = new ArrayList<>();
        List<Map<String, Object>> gibsonLog = new ArrayList<>();
        for (PairingStrategy.PlayerScore leader : clinched) {
            PairingStrategy.PlayerScore opponent = pickDeadOpponent(deadPool, used, leader, context);
            if (opponent == null) continue; // not enough out-of-contention players; leader stays in the normal pool
            used.add(leader.playerId());
            used.add(opponent.playerId());
            gibsonPairs.add(new PairingStrategy.Pair(leader.playerId(), opponent.playerId()));
            gibsonLog.add(Map.of("clinched", leader.playerId(), "vsEliminated", opponent.playerId()));
        }
        if (gibsonPairs.isEmpty()) return strategy.generate(scores, context);

        List<PairingStrategy.PlayerScore> remaining = ranked.stream().filter(player -> !used.contains(player.playerId())).toList();
        List<PairingStrategy.Pair> rest = remaining.isEmpty() ? List.of() : strategy.generate(remaining, context);

        Map<String, Object> log = new LinkedHashMap<>();
        log.put("game", gameNumber);
        log.put("qualifyCut", qualifyCut);
        log.put("remainingGames", remainingGames);
        log.put("maxDiffSum", maxDiffSum);
        log.put("gibsonPairs", gibsonLog);
        log.put("proof", analysis.proof());
        audit(cardId, "system", "GIBSON_PAIRING", null, log);

        List<PairingStrategy.Pair> all = new ArrayList<>(gibsonPairs);
        all.addAll(rest);
        return all;
    }

    /** Lowest-ranked out-of-contention player for a Gibson pairing, preferring one the leader hasn't met. */
    private PairingStrategy.PlayerScore pickDeadOpponent(List<PairingStrategy.PlayerScore> deadPool, Set<String> used,
                                                         PairingStrategy.PlayerScore leader, PairingStrategy.PairingContext context) {
        PairingStrategy.PlayerScore fallback = null;
        for (PairingStrategy.PlayerScore candidate : deadPool) {
            if (used.contains(candidate.playerId())) continue;
            if (fallback == null) fallback = candidate;
            if (!context.alreadyPlayed(leader.playerId(), candidate.playerId())) return candidate;
        }
        return fallback;
    }

    private void createMatchesFromInitialTables(UUID cardId) {
        if (count("SELECT COUNT(*) FROM matches m JOIN games g ON g.id = m.game_id WHERE m.card_id = ? AND g.game_number = 1", cardId) > 0)
            throw new IllegalArgumentException("ยืนยัน pairing เกม 1 แล้ว");
        var seats = jdbc.query("""
            SELECT t.table_number, tp.seat_number, tp.player_id
            FROM competition_tables t JOIN table_players tp ON tp.table_id = t.id
            WHERE t.card_id = ? ORDER BY t.table_number, tp.seat_number
            """, (rs, row) -> new TableSeat(rs.getInt("table_number"), rs.getInt("seat_number"), rs.getObject("player_id", UUID.class), null), cardId);
        Map<Integer, List<TableSeat>> byTable = new LinkedHashMap<>();
        seats.forEach(seat -> byTable.computeIfAbsent(seat.tableNumber(), ignored -> new ArrayList<>()).add(seat));
        UUID gameId = gameId(cardId, 1);
        int matchNumber = 1;
        for (var tableSeats : byTable.values()) {
            for (int index = 0; index + 1 < tableSeats.size(); index += 2) {
                jdbc.update("""
                    INSERT INTO matches (id, card_id, game_id, table_number, player_one_id, player_two_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """, UUID.randomUUID(), cardId, gameId, matchNumber++, tableSeats.get(index).playerId(), tableSeats.get(index + 1).playerId());
            }
        }
    }

    private boolean wouldCreateSchoolConflict(UUID cardId, UUID first, UUID second) {
        var seats = jdbc.query("""
            SELECT t.table_number, tp.seat_number, tp.player_id, p.school
            FROM competition_tables t JOIN table_players tp ON tp.table_id = t.id JOIN players p ON p.id = tp.player_id
            WHERE t.card_id = ? ORDER BY t.table_number, tp.seat_number
            """, (rs, row) -> new TableSeat(rs.getInt("table_number"), rs.getInt("seat_number"), rs.getObject("player_id", UUID.class), rs.getString("school")), cardId);
        String firstSchool = seats.stream().filter(seat -> seat.playerId().equals(first)).map(TableSeat::school).findFirst().orElseThrow();
        String secondSchool = seats.stream().filter(seat -> seat.playerId().equals(second)).map(TableSeat::school).findFirst().orElseThrow();
        var swapped = seats.stream().map(seat -> seat.playerId().equals(first) ? new TableSeat(seat.tableNumber(), seat.seatNumber(), second, secondSchool)
            : seat.playerId().equals(second) ? new TableSeat(seat.tableNumber(), seat.seatNumber(), first, firstSchool) : seat).toList();
        Map<Integer, List<TableSeat>> byTable = new LinkedHashMap<>();
        swapped.forEach(seat -> byTable.computeIfAbsent(seat.tableNumber(), ignored -> new ArrayList<>()).add(seat));
        return byTable.values().stream().anyMatch(table -> {
            for (int index = 0; index + 1 < table.size(); index += 2) {
                TableSeat one = table.get(index); TableSeat two = table.get(index + 1);
                boolean affected = one.playerId().equals(first) || one.playerId().equals(second) || two.playerId().equals(first) || two.playerId().equals(second);
                if (affected && one.school().equalsIgnoreCase(two.school())) return true;
            }
            return false;
        });
    }

    private List<CardDtos.TableResponse> loadTables(UUID cardId) {
        var rows = jdbc.query("""
            SELECT t.id, t.table_number, p.external_id FROM competition_tables t
            LEFT JOIN table_players tp ON tp.table_id = t.id LEFT JOIN players p ON p.id = tp.player_id
            WHERE t.card_id = ? ORDER BY t.table_number, tp.seat_number
            """, (rs, row) -> new TablePlayerRow(rs.getObject("id", UUID.class), rs.getInt("table_number"), rs.getString("external_id")), cardId);
        Map<UUID, List<TablePlayerRow>> grouped = new LinkedHashMap<>();
        rows.forEach(row -> grouped.computeIfAbsent(row.tableId(), ignored -> new ArrayList<>()).add(row));
        return grouped.values().stream().map(group -> new CardDtos.TableResponse(group.get(0).tableId().toString(),
            group.get(0).number(), group.stream().map(TablePlayerRow::externalId).filter(Objects::nonNull).toList())).toList();
    }

    private List<CardDtos.SnapshotResponse> loadSnapshots(UUID cardId, boolean staffView) {
        var rows = pairingRows(cardId, false);
        Map<String, List<PairingRow>> grouped = new LinkedHashMap<>();
        for (PairingRow row : rows) {
            if (!staffView && row.snapshotId() == null && row.pairingPublishedAt() == null) continue;
            String key = row.snapshotId() == null ? "preview" : row.snapshotId().toString();
            grouped.computeIfAbsent(key, ignored -> new ArrayList<>()).add(row);
        }
        return grouped.entrySet().stream().map(entry -> {
            var group = entry.getValue();
            List<Integer> games = group.stream().map(PairingRow::gameNumber).distinct().sorted().toList();
            String confirmedAt = group.get(0).confirmedAt() == null ? "" : group.get(0).confirmedAt().toInstant().toString();
            String id = entry.getKey().equals("preview") ? "preview-" + games.get(0) : entry.getKey();
            return new CardDtos.SnapshotResponse(id, games, group.stream()
                .map(row -> toPairingResponse(row,
                    staffView || row.snapshotId() != null || row.pairingPublishedAt() != null)).toList(), confirmedAt);
        }).toList();
    }

    private List<PairingRow> pairingRows(UUID cardId, boolean unconfirmedFirst) {
        return jdbc.query("""
            SELECT m.id, g.game_number, m.table_number, p1.external_id player_one, p2.external_id player_two,
                   pw.external_id winner, r.score_one, r.score_two, r.result_type, r.calculated_diff,
                   m.snapshot_id, m.pairing_published_at, s.confirmed_at
            FROM matches m JOIN games g ON g.id = m.game_id
            LEFT JOIN players p1 ON p1.id = m.player_one_id LEFT JOIN players p2 ON p2.id = m.player_two_id
            LEFT JOIN match_results r ON r.match_id = m.id LEFT JOIN players pw ON pw.id = r.winner_id
            LEFT JOIN pairing_snapshots s ON s.id = m.snapshot_id
            WHERE m.card_id = ? ORDER BY g.game_number, m.table_number
            """, (rs, row) -> new PairingRow(rs.getObject("id", UUID.class), rs.getInt("game_number"), rs.getInt("table_number"),
                rs.getString("player_one"), rs.getString("player_two"), rs.getString("winner"), nullableInt(rs, "score_one"),
                nullableInt(rs, "score_two"), rs.getString("result_type"), nullableInt(rs, "calculated_diff"),
                rs.getObject("snapshot_id", UUID.class), rs.getTimestamp("pairing_published_at"), rs.getTimestamp("confirmed_at")), cardId);
    }

    private CardDtos.PairingResponse toPairingResponse(PairingRow row) {
        return toPairingResponse(row, true);
    }

    private CardDtos.PairingResponse toPairingResponse(PairingRow row, boolean includeResult) {
        return new CardDtos.PairingResponse(row.id().toString(), row.gameNumber(), row.tableNumber(), row.playerOne(), row.playerTwo(),
            includeResult ? row.winnerId() : null,
            includeResult ? row.scoreOne() : null,
            includeResult ? row.scoreTwo() : null,
            includeResult ? row.resultType() : null,
            includeResult ? row.calculatedDiff() : null);
    }

    private List<PairingStrategy.PlayerScore> loadScores(UUID cardId) {
        return jdbc.query("""
            SELECT p.id, p.school, COALESCE(s.win_points, 0) win_points, COALESCE(s.diff, 0) diff
            FROM players p LEFT JOIN standings s ON s.player_id = p.id WHERE p.card_id = ? ORDER BY p.external_id
            """, (rs, row) -> new PairingStrategy.PlayerScore(rs.getObject("id", UUID.class).toString(), rs.getString("school"),
                rs.getInt("win_points"), rs.getInt("diff")), cardId);
    }

    private void recalculateStandings(UUID cardId) {
        jdbc.update("UPDATE standings SET wins = 0, draws = 0, losses = 0, win_points = 0, diff = 0, recalculated_at = now() WHERE card_id = ?", cardId);
        var results = jdbc.query("""
            SELECT m.player_one_id, m.player_two_id, r.winner_id, r.result_type, r.calculated_diff
            FROM matches m JOIN match_results r ON r.match_id = m.id WHERE m.card_id = ?
            """, (rs, row) -> new ScoreRow(rs.getObject("player_one_id", UUID.class), rs.getObject("player_two_id", UUID.class),
                rs.getObject("winner_id", UUID.class), rs.getString("result_type"), rs.getInt("calculated_diff")), cardId);
        for (ScoreRow result : results) {
            if ("DRAW".equals(result.resultType())) {
                jdbc.update("UPDATE standings SET draws = draws + 1, win_points = win_points + 1 WHERE card_id = ? AND player_id IN (?, ?)",
                    cardId, result.one(), result.two());
                continue;
            }
            UUID loser = result.winner().equals(result.one()) ? result.two() : result.one();
            jdbc.update("UPDATE standings SET wins = wins + 1, win_points = win_points + 2, diff = diff + ? WHERE card_id = ? AND player_id = ?",
                result.calculatedDiff(), cardId, result.winner());
            jdbc.update("UPDATE standings SET losses = losses + 1, diff = diff - ? WHERE card_id = ? AND player_id = ?",
                result.calculatedDiff(), cardId, loser);
        }
    }

    private PairingRuleType ruleForGame(UUID cardId, int gameNumber) {
        if (gameNumber == 1) return PairingRuleType.KING_OF_THE_HILL;
        return jdbc.queryForObject("SELECT rule_type FROM pairing_rules WHERE card_id = ? AND to_game = ?",
            (rs, row) -> PairingRuleType.valueOf(rs.getString("rule_type")), cardId, gameNumber);
    }

    private CardRow cardRow(UUID cardId) {
        try {
            return jdbc.queryForObject("""
                SELECT id, name, division, number_of_games, status, runtime_stage, current_game, created_at, version, final_type, final_games, gibson_enabled
                FROM tournament_cards WHERE id = ? FOR UPDATE
                """, (rs, row) -> new CardRow(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("division"),
                rs.getInt("number_of_games"), CardStatus.valueOf(rs.getString("status")), RuntimeStage.valueOf(rs.getString("runtime_stage")),
                rs.getInt("current_game"), rs.getTimestamp("created_at").toInstant(), rs.getLong("version"),
                rs.getString("final_type"), rs.getInt("final_games"), rs.getBoolean("gibson_enabled")), cardId);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found");
        }
    }

    private void ensureEditable(UUID cardId) {
        if (cardRow(cardId).status() == CardStatus.CLOSED) throw new IllegalArgumentException("This card is closed and immutable");
    }

    /** Once a card enters/concludes its final round, the regular games are frozen (no override / un-pair). */
    private void requireRegularEditable(UUID cardId) {
        CardRow card = cardRow(cardId);
        boolean inFinal = card.runtimeStage() == RuntimeStage.FINAL_SEEDING
            || card.runtimeStage() == RuntimeStage.FINAL_COLLECTION
            || (card.runtimeStage() == RuntimeStage.FINAL_PUBLISHED && !"NONE".equals(card.finalType()));
        if (inFinal) throw new IllegalArgumentException("การ์ดเข้าสู่รอบชิงแล้ว แก้ไขผลเกมปกติหรือยกเลิกการจับคู่ไม่ได้");
    }

    private CardRow requireStage(UUID cardId, RuntimeStage expected) {
        CardRow card = cardRow(cardId);
        if (card.status() == CardStatus.CLOSED || card.status() == CardStatus.FINISHED)
            throw new IllegalArgumentException("การ์ดนี้ประกาศผลหรือปิดแล้ว ไม่สามารถแก้ไขได้");
        if (card.runtimeStage() != expected)
            throw new IllegalArgumentException("ขั้นตอนปัจจุบันคือ " + card.runtimeStage() + " ไม่อนุญาตให้ทำรายการนี้");
        return card;
    }

    private String nextPlayerCode(UUID cardId) {
        Integer next = jdbc.queryForObject("""
            SELECT COALESCE(MAX(CASE WHEN external_id ~ '^P[0-9]+$' THEN substring(external_id from 2)::integer END), 0) + 1
            FROM players WHERE card_id = ?
            """, Integer.class, cardId);
        return "P" + String.format("%03d", next == null ? 1 : next);
    }

    private String cardDivision(UUID cardId) { return cardRow(cardId).division(); }
    private UUID gameId(UUID cardId, int number) { return jdbc.queryForObject("SELECT id FROM games WHERE card_id = ? AND game_number = ?", UUID.class, cardId, number); }
    private UUID playerId(UUID cardId, String externalId) {
        try { return jdbc.queryForObject("SELECT id FROM players WHERE card_id = ? AND external_id = ?", UUID.class, cardId, externalId); }
        catch (EmptyResultDataAccessException error) { throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found"); }
    }
    private PlayerAudit playerAudit(UUID cardId, String externalId) {
        try {
            return jdbc.queryForObject("""
                SELECT id, external_id, first_name, last_name, school
                FROM players WHERE card_id = ? AND external_id = ?
                """, (rs, row) -> new PlayerAudit(
                    rs.getObject("id", UUID.class), rs.getString("external_id"), rs.getString("first_name"),
                    rs.getString("last_name"), rs.getString("school")
                ), cardId, externalId);
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found");
        }
    }
    private long count(String sql, Object... args) { return Objects.requireNonNull(jdbc.queryForObject(sql, Long.class, args)); }
    private void touch(UUID cardId) { jdbc.update("UPDATE tournament_cards SET version = version + 1 WHERE id = ?", cardId); }
    private void publishPublic(UUID cardId) {
        jdbc.update("UPDATE tournament_cards SET public_version = public_version + 1 WHERE id = ?", cardId);
    }
    private void publishPublicIfPlayersVisible(UUID cardId) {
        String stage = jdbc.queryForObject("SELECT runtime_stage FROM tournament_cards WHERE id = ?", String.class, cardId);
        if (!RuntimeStage.PLAYER_REGISTRATION.name().equals(stage)) publishPublic(cardId);
    }

    private void audit(UUID cardId, String actor, String action, Object oldValue, Object newValue) {
        jdbc.update("""
            INSERT INTO audit_logs (id, card_id, actor, action, old_value, new_value)
            VALUES (?, ?, ?, ?, CAST(? AS jsonb), CAST(? AS jsonb))
            """, UUID.randomUUID(), cardId, actor, action, json(oldValue), json(newValue));
    }

    private String json(Object value) {
        try { return objectMapper.writeValueAsString(value); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Cannot serialize audit data", error); }
    }

    private String jsonText(String value) {
        if (value == null) return "—";
        try { JsonNode node = objectMapper.readTree(value); return node.isTextual() ? node.asText() : node.toString(); }
        catch (JsonProcessingException ignored) { return value; }
    }

    private String sha256(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    private Integer nullableInt(ResultSet rs, String column) throws SQLException { int value = rs.getInt(column); return rs.wasNull() ? null : value; }
    private boolean hasInvalidPairResultChain(List<PairingRuleType> rules) {
        for (int i = 1; i < rules.size(); i++) if (rules.get(i) == PairingRuleType.PAIR_RESULT && rules.get(i - 1) == PairingRuleType.PAIR_RESULT) return true;
        return false;
    }

    private record CardRow(UUID id, String name, String division, int numberOfGames, CardStatus status, RuntimeStage runtimeStage, int currentGame, Instant createdAt, long version, String finalType, int finalGames, boolean gibsonEnabled) {}
    private record PlayerCodeRow(UUID id, String externalId) {}
    private record PlayerAudit(UUID id, String externalId, String firstName, String lastName, String school) {
        Map<String, String> asAuditValue() {
            return Map.of("id", externalId, "firstName", firstName, "lastName", lastName, "school", school);
        }
    }
    private record SeatPlayer(UUID id, String school) {}
    private record InitialPair(SeatPlayer one, SeatPlayer two) {}
    private record Seat(UUID tableId, UUID playerId, int seatNumber) {}
    private record MatchSlot(UUID id, UUID oneId, UUID twoId, boolean hasResult) {}
    private record TablePlayerRow(UUID tableId, int number, String externalId) {}
    private record MatchPlayers(UUID oneId, UUID twoId, String oneExternal, String twoExternal, UUID snapshotId, int gameNumber, int maxDiff, int tableNumber) {}
    private record TableSeat(int tableNumber, int seatNumber, UUID playerId, String school) {}
    private record PairingRow(UUID id, int gameNumber, int tableNumber, String playerOne, String playerTwo, String winnerId,
                              Integer scoreOne, Integer scoreTwo, String resultType, Integer calculatedDiff,
                              UUID snapshotId, Timestamp pairingPublishedAt, Timestamp confirmedAt) {}
    private record PairResultSource(int tableNumber, UUID oneId, UUID twoId, UUID winnerId, String resultType) {}
    private record PairResultSlots(UUID upper, UUID lower) {}
    private record PairResultDestination(UUID id, UUID oneId, UUID twoId, boolean hasResult) {}
    private record ScoreRow(UUID one, UUID two, UUID winner, String resultType, int calculatedDiff) {}
    private record AutoMatch(UUID id, String one, String two, int tableNumber) {}
}
