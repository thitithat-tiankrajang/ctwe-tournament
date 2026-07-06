package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.domain.pairing.GibsonAnalysis;
import com.ctwe.tournament.domain.pairing.PairingStrategy;
import com.ctwe.tournament.domain.pairing.SchoolAwarePairing;
import com.ctwe.tournament.infrastructure.cache.EvictPublicCard;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.CardDtos;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Caching;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * All rows are keyed by small composite keys (V20): players by (card_id, code SMALLINT), matches by
 * (card_id, game_number, table_number) with the result columns inline, snapshots by
 * (card_id, snapshot_no). The API keeps its old shapes — player ids render as "P001" and a match id
 * renders as "g{game}t{table}" — both are opaque strings to the frontend.
 */
@Service
public class TournamentCardService {
    private static final Pattern MATCH_ID = Pattern.compile("^g(\\d{1,2})t(\\d{1,4})$");

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

        var games = jdbc.query("SELECT game_number, status, max_diff FROM games WHERE card_id = ? ORDER BY game_number",
            (rs, row) -> new CardDtos.GameResponse(String.valueOf(rs.getInt("game_number")), rs.getInt("game_number"),
                "เกม " + rs.getInt("game_number"), rs.getString("status"), rs.getInt("max_diff")), cardId);
        var rules = jdbc.query("SELECT from_game, rule_type FROM pairing_rules WHERE card_id = ? ORDER BY from_game",
            (rs, row) -> new CardDtos.RuleResponse(rs.getInt("from_game"), rs.getInt("from_game") + 1, PairingRuleType.valueOf(rs.getString("rule_type"))), cardId);
        List<CardDtos.PlayerResponse> players = !staffView && card.runtimeStage() == RuntimeStage.PLAYER_REGISTRATION
            ? List.of()
            : jdbc.query("""
            SELECT p.code, p.first_name, p.last_name, p.school, (p.terminated_at IS NOT NULL) terminated,
                   COALESCE(s.wins, 0) wins, COALESCE(s.draws, 0) draws, COALESCE(s.losses, 0) losses,
                   COALESCE(s.win_points, 0) win_points, COALESCE(s.diff, 0) diff
            FROM players p LEFT JOIN standings s ON s.card_id = p.card_id AND s.player_code = p.code
            WHERE p.card_id = ? ORDER BY p.code
            """, (rs, row) -> new CardDtos.PlayerResponse(pcode(rs.getInt("code")), rs.getString("first_name"),
                rs.getString("last_name"), rs.getString("school"), card.division(),
                rs.getInt("wins"), rs.getInt("draws"), rs.getInt("losses"), rs.getInt("win_points"), rs.getInt("diff"),
                rs.getBoolean("terminated")), cardId);
        var tables = staffView ? loadTables(cardId) : List.<CardDtos.TableResponse>of();
        var snapshots = loadSnapshots(cardId, staffView);
        // Audit is intentionally NOT loaded in the card payload — it is the largest part and only the
        // audit page needs it. It is served on demand via GET /{cardId}/audit instead.
        var audit = List.<CardDtos.AuditResponse>of();
        var finalRound = "NONE".equals(card.finalType()) ? null : loadFinalRound(cardId);
        return new CardDtos.CardResponse(card.id(), tournamentId, card.name(), card.division(), card.status(), card.runtimeStage(),
            card.currentGame(), card.version(), games, rules, players, tables, snapshots, audit,
            card.finalType(), card.finalGames(), finalRound, card.gibsonEnabled(), card.createdAt());
    }

    /** On-demand audit log for the audit page (kept out of the card payload to keep the hot path cheap). */
    @Transactional(readOnly = true)
    public List<CardDtos.AuditResponse> auditLog(UUID cardId) {
        return jdbc.query("""
            SELECT id, actor, action, old_value, new_value, created_at
            FROM audit_logs WHERE card_id = ? ORDER BY created_at DESC, id DESC LIMIT 1000
            """, (rs, row) -> new CardDtos.AuditResponse(String.valueOf(rs.getLong("id")),
                rs.getTimestamp("created_at").toInstant().toString(), rs.getString("actor"), rs.getString("action"),
                jsonText(rs.getString("old_value")), jsonText(rs.getString("new_value"))), cardId);
    }

    /** Legacy diagnostic change detector; current clients synchronize through SSE. */
    @Transactional(readOnly = true)
    public long cardVersion(UUID cardId) {
        try {
            Long version = jdbc.queryForObject("SELECT version FROM tournament_cards WHERE id = ?", Long.class, cardId);
            return version == null ? 0 : version;
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament card not found");
        }
    }

    /** Assemble the final-round bracket (null until the director starts it). Player ids are P-codes. */
    private CardDtos.FinalRoundResponse loadFinalRound(UUID cardId) {
        record Slot(int slot, String one, String two, String winner) {}
        List<Slot> pairings = jdbc.query("""
            SELECT slot, player_one, player_two, winner FROM final_pairings WHERE card_id = ? ORDER BY slot
            """, (rs, row) -> new Slot(rs.getInt("slot"), pcode(rs.getInt("player_one")), pcode(rs.getInt("player_two")),
                pcode(nullableInt(rs, "winner"))), cardId);
        if (pairings.isEmpty()) return null;
        List<CardDtos.FinalSlotResponse> slots = new ArrayList<>();
        for (Slot pairing : pairings) {
            var games = jdbc.query("SELECT game_index, score_one, score_two FROM final_game_results WHERE card_id = ? AND slot = ? ORDER BY game_index",
                (rs, row) -> {
                    Integer scoreOne = nullableInt(rs, "score_one");
                    Integer scoreTwo = nullableInt(rs, "score_two");
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
            jdbc.update("INSERT INTO games (card_id, game_number, status, max_diff) VALUES (?, ?, 'PENDING', ?)",
                cardId, game, request.gameMaxDiffs().get(game - 1));
        }
        for (int index = 0; index < request.rules().size(); index++) {
            jdbc.update("INSERT INTO pairing_rules (card_id, from_game, rule_type) VALUES (?, ?, ?)",
                cardId, index + 1, request.rules().get(index).name());
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
        requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        int code = nextPlayerCode(cardId);
        jdbc.update("""
            INSERT INTO players (card_id, code, first_name, last_name, school)
            VALUES (?, ?, ?, ?, ?)
            """, cardId, code, request.firstName().trim(), request.lastName().trim(), request.school().trim());
        jdbc.update("INSERT INTO standings (card_id, player_code) VALUES (?, ?)", cardId, code);
        touch(cardId);
        audit(cardId, actor, "ADD_PLAYER", null, pcode(code) + " " + request.firstName().trim() + " " + request.lastName().trim());
        return get(cardId, true);
    }

    /** Bulk import (e.g. from Excel): append many players in one transaction with sequential codes. */
    @Transactional
    public CardDtos.CardResponse addPlayersBulk(UUID cardId, List<CardDtos.BulkPlayerEntry> players, String actor) {
        requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        int start = nextPlayerCode(cardId);
        for (int index = 0; index < players.size(); index++) {
            CardDtos.BulkPlayerEntry entry = players.get(index);
            int code = start + index;
            jdbc.update("""
                INSERT INTO players (card_id, code, first_name, last_name, school)
                VALUES (?, ?, ?, ?, ?)
                """, cardId, code, entry.firstName().trim(), entry.lastName().trim(), entry.school().trim());
            jdbc.update("INSERT INTO standings (card_id, player_code) VALUES (?, ?)", cardId, code);
        }
        touch(cardId);
        audit(cardId, actor, "IMPORT_PLAYERS", null, Map.of("count", players.size(), "fromCode", pcode(start)));
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse updatePlayer(UUID cardId, String playerExternalId, CardDtos.PlayerRequest request, String actor, boolean operator) {
        // Directors/admins may correct player details throughout the tournament (the edit propagates to
        // every published pairing/ranking/result automatically, since those reference the player by code)
        // — but not once the card has finished. Staff may only edit during registration.
        if (operator) requirePlayerEditable(cardId);
        else requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        PlayerAudit oldPlayer = playerAudit(cardId, playerExternalId);
        if (request.id() != null && !request.id().isBlank() && !request.id().equals(playerExternalId))
            throw new IllegalArgumentException("รหัสนักกีฬาถูกจัดการโดยระบบและไม่สามารถแก้เองได้");
        int changed = jdbc.update("""
            UPDATE players SET first_name = ?, last_name = ?, school = ?
            WHERE card_id = ? AND code = ?
            """, request.firstName().trim(), request.lastName().trim(), request.school().trim(), cardId, oldPlayer.code());
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
        if (count("SELECT COUNT(*) FROM matches WHERE card_id = ? AND (player_one = ? OR player_two = ?)",
            cardId, removedPlayer.code(), removedPlayer.code()) > 0)
            throw new IllegalArgumentException("A player with match history cannot be deleted");
        // During registration standings are all zeros, so re-key by rebuilding them after the renumber.
        jdbc.update("DELETE FROM standings WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM players WHERE card_id = ? AND code = ?", cardId, removedPlayer.code());

        List<Integer> remaining = jdbc.queryForList("SELECT code FROM players WHERE card_id = ? ORDER BY code", Integer.class, cardId);
        // Negative temp codes avoid PK collisions while codes shift down.
        jdbc.update("UPDATE players SET code = -code WHERE card_id = ?", cardId);
        Map<String, String> renumbered = new LinkedHashMap<>();
        for (int index = 0; index < remaining.size(); index++) {
            int oldCode = remaining.get(index);
            int newCode = index + 1;
            jdbc.update("UPDATE players SET code = ? WHERE card_id = ? AND code = ?", newCode, cardId, -oldCode);
            jdbc.update("INSERT INTO standings (card_id, player_code) VALUES (?, ?)", cardId, newCode);
            if (oldCode != newCode) renumbered.put(pcode(oldCode), pcode(newCode));
        }
        touch(cardId);
        audit(cardId, actor, "REMOVE_PLAYER", removedPlayer.asAuditValue(), Map.of(
            "deleted", playerExternalId,
            "renumbered", renumbered
        ));
        return get(cardId, true);
    }

    /**
     * Batch-terminate players out of a running card (director password enforced upstream). A player
     * with an unresulted pairing in the current block must have that result recorded first, so their
     * opponent's game is never left dangling. Terminated players keep their code + past results but
     * are excluded from all future pairings/standings; they can be restored later.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse terminatePlayers(UUID cardId, List<String> playerIds, String actor) {
        CardRow card = cardRow(cardId);
        if (card.status() == CardStatus.DRAFT)
            throw new IllegalArgumentException("ยังไม่เริ่มการแข่งขัน — ใช้ลบผู้เล่นในหน้าลงทะเบียนแทน");
        requirePlayerEditable(cardId);
        List<Integer> codes = playerIds.stream().map(id -> playerCode(cardId, id)).distinct().toList();
        List<Integer> activeGames = activeResultGames(card);
        for (int code : codes) {
            boolean pendingPairing = count("""
                SELECT COUNT(*) FROM matches
                WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL
                  AND result_type IS NULL AND (player_one = ? OR player_two = ?)
                """, cardId, activeGames.get(0), activeGames.get(activeGames.size() - 1), code, code) > 0;
            if (pendingPairing)
                throw new IllegalArgumentException("ต้องกรอกผลคู่ของ " + pcode(code) + " ในเกมปัจจุบันก่อนจึงจะ terminate ได้");
        }
        for (int code : codes)
            jdbc.update("UPDATE players SET terminated_at = now(), terminated_by = ? WHERE card_id = ? AND code = ? AND terminated_at IS NULL",
                actor, cardId, code);
        touch(cardId);
        publishPublicIfPlayersVisible(cardId);
        audit(cardId, actor, "TERMINATE_PLAYERS", null, Map.of(
            "players", codes.stream().map(TournamentCardService::pcode).toList(), "game", card.currentGame()));
        return get(cardId, true);
    }

    /**
     * Batch-restore terminated players. Games they missed become losses of {@code lossPoints} each,
     * carried as running totals (never shown as matches). Placement depends on the current pairing:
     *  - no current pairing yet (case A): they join when the director generates the current pairing;
     *  - pairing exists, no results, and {@code unpair} (case B): the current pairing is discarded so
     *    they re-enter it, exactly like case A;
     *  - otherwise (case B declined / case C): they sit out the current game (also charged a loss) and
     *    rejoin from the next game.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse restorePlayers(UUID cardId, List<String> playerIds, int lossPoints, boolean unpair, String actor) {
        CardRow card = cardRow(cardId);
        requirePlayerEditable(cardId);
        if (lossPoints < 0) throw new IllegalArgumentException("แต้มปรับแพ้ต้องไม่ติดลบ");
        List<Integer> codes = playerIds.stream().map(id -> playerCode(cardId, id)).distinct().toList();
        for (int code : codes)
            if (!Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT terminated_at IS NOT NULL FROM players WHERE card_id = ? AND code = ?", Boolean.class, cardId, code)))
                throw new IllegalArgumentException(pcode(code) + " ไม่ได้อยู่ในสถานะ terminate");

        int currentGame = card.currentGame();
        boolean pairingExists = card.runtimeStage() == RuntimeStage.PAIRING_PREVIEW
            || card.runtimeStage() == RuntimeStage.RESULT_COLLECTION;
        List<Integer> activeGames = activeResultGames(card);
        boolean anyResultInBlock = pairingExists && count("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL AND result_type IS NOT NULL
            """, cardId, activeGames.get(0), activeGames.get(activeGames.size() - 1)) > 0;

        boolean joinCurrentGame;
        boolean unpaired = false;
        if (!pairingExists) {
            joinCurrentGame = true;                       // case A
        } else if (!anyResultInBlock && unpair) {
            discardCurrentPairing(cardId, currentGame);   // case B (director chose to un-pair)
            joinCurrentGame = true;
            unpaired = true;
        } else {
            joinCurrentGame = false;                      // case B declined, or case C
        }

        // Missed games are those in [1, upperExclusive) with no recorded result; the current game is
        // included when the player sits it out.
        int upperExclusive = joinCurrentGame ? currentGame : currentGame + 1;
        int rejoinGame = joinCurrentGame ? currentGame : currentGame + 1;
        for (int code : codes) {
            long played = count("""
                SELECT COUNT(DISTINCT m.game_number) FROM matches m
                WHERE m.card_id = ? AND (m.player_one = ? OR m.player_two = ?)
                  AND m.result_type IS NOT NULL AND m.game_number < ?
                """, cardId, code, code, upperExclusive);
            int missed = Math.max(0, (upperExclusive - 1) - (int) played);
            jdbc.update("""
                UPDATE players SET terminated_at = NULL, terminated_by = NULL,
                                   carry_losses = ?, carry_diff = ?, rejoin_game = ?
                WHERE card_id = ? AND code = ?
                """, missed, missed * lossPoints, rejoinGame, cardId, code);
        }
        recalculateStandings(cardId);
        touch(cardId);
        publishPublicIfPlayersVisible(cardId);
        audit(cardId, actor, "RESTORE_PLAYERS", null, Map.of(
            "players", codes.stream().map(TournamentCardService::pcode).toList(),
            "lossPoints", lossPoints, "joinCurrentGame", joinCurrentGame, "unpaired", unpaired, "game", currentGame));
        return get(cardId, true);
    }

    /** Discards the current game's unpublished pairing back to TABLE_PAIRING (shared by undo + restore). */
    private void discardCurrentPairing(UUID cardId, int currentGame) {
        deleteUnpublishedMatches(cardId, currentGame - 1);
        if (currentGame == 1) jdbc.update("DELETE FROM table_seats WHERE card_id = ?", cardId);
        jdbc.update("UPDATE games SET status = 'PENDING' WHERE card_id = ? AND game_number >= ?", cardId, currentGame);
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'TABLE_PAIRING', version = version + 1 WHERE id = ?", cardId);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse finishRegistration(UUID cardId, String actor) {
        requireStage(cardId, RuntimeStage.PLAYER_REGISTRATION);
        long players = activePlayerCount(cardId);
        if (players < 2) throw new IllegalArgumentException("ต้องมีผู้เล่นอย่างน้อย 2 คน");
        // Any player count is allowed: an odd field gets a bye (one-player pairing), and a non-multiple
        // of 4 in the win/win–lose/lose block is handled by byes + a deferred Swiss group downstream.
        jdbc.update("UPDATE tournament_cards SET status = 'READY', runtime_stage = 'TABLE_PAIRING', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        audit(cardId, actor, "FINISH_PLAYER_REGISTRATION", players + " players", "ready for game 1 pairing");
        return get(cardId, true);
    }

    @Transactional
    public CardDtos.CardResponse generatePairingPreview(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.TABLE_PAIRING);
        if (activeInGame(cardId, card.currentGame()) < 2)
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
        pairingLog.put("players", activeInGame(cardId, card.currentGame()));
        audit(cardId, actor, "GENERATE_PAIRING_PREVIEW", null, pairingLog);
        return get(cardId, true);
    }

    private void generateInitialTables(UUID cardId) {
        jdbc.update("DELETE FROM table_seats WHERE card_id = ?", cardId);
        List<PairingStrategy.PlayerScore> players = new ArrayList<>(jdbc.query("""
            SELECT code, school FROM players
            WHERE card_id = ? AND terminated_at IS NULL AND rejoin_game <= 1
            ORDER BY code
            """, (rs, row) -> new PairingStrategy.PlayerScore(
                String.valueOf(rs.getInt("code")), rs.getString("school"), 0, 0), cardId));
        Collections.shuffle(players, secureRandom);
        // The random pre-shuffle also selects a different bye when the preview is regenerated.
        PairingStrategy.PlayerScore bye = players.size() % 2 != 0 ? players.remove(players.size() - 1) : null;
        List<PairingStrategy.Pair> pairs = players.isEmpty() ? List.of()
            : strategies.resolve(PairingRuleType.RANDOM).generate(players,
                new PairingStrategy.PairingContext(1, List.of()));
        pairs = SchoolAwarePairing.orderForTables(
            pairs, players, secureRandom, bye == null ? null : bye.playerId());
        int tableNumber = 1;
        for (int pairIndex = 0; pairIndex < pairs.size(); pairIndex += 2) {
            int seatNumber = 1;
            for (int offset = 0; offset < 2 && pairIndex + offset < pairs.size(); offset++) {
                PairingStrategy.Pair pair = pairs.get(pairIndex + offset);
                jdbc.update("INSERT INTO table_seats (card_id, table_no, seat_no, player_code) VALUES (?, ?, ?, ?)",
                    cardId, tableNumber, seatNumber++, Integer.parseInt(pair.playerOneId()));
                jdbc.update("INSERT INTO table_seats (card_id, table_no, seat_no, player_code) VALUES (?, ?, ?, ?)",
                    cardId, tableNumber, seatNumber++, Integer.parseInt(pair.playerTwoId()));
            }
            tableNumber++;
        }
        if (bye != null) {
            int byeTable = pairs.size() % 2 != 0 ? tableNumber - 1 : tableNumber;
            int byeSeat = pairs.size() % 2 != 0 ? 3 : 1;
            jdbc.update("INSERT INTO table_seats (card_id, table_no, seat_no, player_code) VALUES (?, ?, ?, ?)",
                cardId, byeTable, byeSeat, Integer.parseInt(bye.playerId()));
        }
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
        int first = playerCode(cardId, request.firstPlayerId());
        int second = playerCode(cardId, request.secondPlayerId());
        if (first == second) throw new IllegalArgumentException("เลือกผู้เล่นสองคนที่ต่างกัน");
        // Game 1 before confirmation lives in table_seats; once matches exist, swap those.
        if (card.currentGame() == 1 && card.runtimeStage() == RuntimeStage.PAIRING_PREVIEW)
            swapSeats(cardId, first, second, request.confirmSchoolConflict());
        else swapMatchPlayers(cardId, card.currentGame(), first, second, request.confirmSchoolConflict());
        touch(cardId);
        if (card.runtimeStage() == RuntimeStage.RESULT_COLLECTION) publishPublic(cardId);
        audit(cardId, actor, "SWAP_PLAYERS", request.firstPlayerId(), request.secondPlayerId() + " · เกม " + card.currentGame());
        return get(cardId, true);
    }

    private void swapSeats(UUID cardId, int first, int second, boolean confirmConflict) {
        var seats = jdbc.query("SELECT table_no, seat_no, player_code FROM table_seats WHERE card_id = ? AND player_code IN (?, ?)",
            (rs, row) -> new Seat(rs.getInt("table_no"), rs.getInt("seat_no"), rs.getInt("player_code")), cardId, first, second);
        if (seats.size() != 2) throw new IllegalArgumentException("Both players must have assigned seats");
        Seat a = seats.stream().filter(seat -> seat.playerCode() == first).findFirst().orElseThrow();
        Seat b = seats.stream().filter(seat -> seat.playerCode() == second).findFirst().orElseThrow();
        if (!confirmConflict && wouldCreateSchoolConflict(cardId, first, second))
            throw new IllegalArgumentException("SCHOOL_CONFLICT: การสลับนี้ทำให้ผู้เล่นโรงเรียนเดียวกันแข่งขันกัน กรุณายืนยันอีกครั้ง");
        jdbc.update("UPDATE table_seats SET player_code = ? WHERE card_id = ? AND table_no = ? AND seat_no = ?", second, cardId, a.tableNo(), a.seatNo());
        jdbc.update("UPDATE table_seats SET player_code = ? WHERE card_id = ? AND table_no = ? AND seat_no = ?", first, cardId, b.tableNo(), b.seatNo());
    }

    /** Swap two players across the unconfirmed preview pairings of any game ≥ 2. */
    private void swapMatchPlayers(UUID cardId, int gameNumber, int first, int second, boolean confirmConflict) {
        var matches = jdbc.query("""
            SELECT table_number, player_one, player_two, (result_type IS NOT NULL) has_result
            FROM matches WHERE card_id = ? AND game_number = ? AND snapshot_no IS NULL
            """, (rs, row) -> new MatchSlot(rs.getInt("table_number"), nullableInt(rs, "player_one"),
                nullableInt(rs, "player_two"), rs.getBoolean("has_result")), cardId, gameNumber);
        MatchSlot firstMatch = null; MatchSlot secondMatch = null;
        boolean firstIsOne = false; boolean secondIsOne = false;
        for (MatchSlot match : matches) {
            if (Objects.equals(first, match.oneId())) { firstMatch = match; firstIsOne = true; }
            else if (Objects.equals(first, match.twoId())) { firstMatch = match; firstIsOne = false; }
            if (Objects.equals(second, match.oneId())) { secondMatch = match; secondIsOne = true; }
            else if (Objects.equals(second, match.twoId())) { secondMatch = match; secondIsOne = false; }
        }
        if (firstMatch == null || secondMatch == null) throw new IllegalArgumentException("ไม่พบผู้เล่นใน pairing ของเกมนี้");
        if (firstMatch.tableNumber() == secondMatch.tableNumber()) throw new IllegalArgumentException("ผู้เล่นสองคนนี้เป็นคู่แข่งกันอยู่แล้ว");
        if (firstMatch.hasResult() || secondMatch.hasResult()) throw new IllegalArgumentException("คู่ที่มีผลแล้วสลับไม่ได้");
        Integer firstOpponent = firstIsOne ? firstMatch.twoId() : firstMatch.oneId();
        Integer secondOpponent = secondIsOne ? secondMatch.twoId() : secondMatch.oneId();
        if (!confirmConflict && (sameSchool(cardId, firstOpponent, second) || sameSchool(cardId, secondOpponent, first)))
            throw new IllegalArgumentException("SCHOOL_CONFLICT: การสลับนี้ทำให้ผู้เล่นโรงเรียนเดียวกันแข่งขันกัน กรุณายืนยันอีกครั้ง");
        jdbc.update("UPDATE matches SET player_" + (firstIsOne ? "one" : "two") + " = ? WHERE card_id = ? AND game_number = ? AND table_number = ?",
            second, cardId, gameNumber, firstMatch.tableNumber());
        jdbc.update("UPDATE matches SET player_" + (secondIsOne ? "one" : "two") + " = ? WHERE card_id = ? AND game_number = ? AND table_number = ?",
            first, cardId, gameNumber, secondMatch.tableNumber());
    }

    private boolean sameSchool(UUID cardId, Integer a, Integer b) {
        if (a == null || b == null || a.equals(b)) return false;
        var schools = jdbc.queryForList("SELECT school FROM players WHERE card_id = ? AND code IN (?, ?)", String.class, cardId, a, b);
        return schools.size() == 2 && schools.get(0) != null && schools.get(0).equalsIgnoreCase(schools.get(1));
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse confirmPairingPreview(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.PAIRING_PREVIEW);
        if (card.currentGame() == 1) createMatchesFromInitialTables(cardId);
        if (count("SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = ?", cardId, card.currentGame()) == 0)
            throw new IllegalArgumentException("ไม่พบ pairing สำหรับเกมปัจจุบัน");
        jdbc.update("UPDATE matches SET pairing_published_at = COALESCE(pairing_published_at, now()) WHERE card_id = ? AND game_number = ?",
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
     * Publishes only the destination pairing of an active PAIR_RESULT block. Staff may materialise
     * and score destination rows before this milestone, but anonymous viewers cannot see them until
     * the director explicitly publishes the pairing after every source result is recorded.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse publishPairResultDestination(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_COLLECTION);
        int sourceGame = card.currentGame();
        if (sourceGame >= card.numberOfGames() || !isOutgoingPairResult(cardId, sourceGame))
            throw new IllegalArgumentException("เกมปัจจุบันไม่ได้ใช้กติกาชนะพบชนะ–แพ้พบแพ้");
        int destinationGame = sourceGame + 1;

        long sourceTotal = count("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND snapshot_no IS NULL
            """, cardId, sourceGame);
        long sourcePending = count("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND snapshot_no IS NULL AND result_type IS NULL
            """, cardId, sourceGame);
        if (sourceTotal == 0 || sourcePending > 0)
            throw new IllegalArgumentException("ต้องกรอกผลเกม " + sourceGame + " ให้ครบทุกคู่ก่อน Publish Pairing เกม " + destinationGame);

        long destinationTotal = count("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND snapshot_no IS NULL
            """, cardId, destinationGame);
        long emptyDestinations = count("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND snapshot_no IS NULL
              AND player_one IS NULL AND player_two IS NULL
            """, cardId, destinationGame);
        if (destinationTotal != sourceTotal || emptyDestinations > 0)
            throw new IllegalArgumentException("Pairing เกม " + destinationGame + " ยังสร้างไม่ครบ");

        long changed = jdbc.update("""
            UPDATE matches SET pairing_published_at = now()
            WHERE card_id = ? AND game_number = ? AND snapshot_no IS NULL AND pairing_published_at IS NULL
            """, cardId, destinationGame);
        if (changed > 0) {
            jdbc.update("UPDATE games SET status = 'OPEN' WHERE card_id = ? AND game_number = ?", cardId, destinationGame);
            touch(cardId);
            publishPublic(cardId);
            audit(cardId, actor, "PUBLISH_PAIR_RESULT_DESTINATION", null, Map.of(
                "sourceGame", sourceGame,
                "publishedPairingGame", destinationGame,
                "pairings", destinationTotal
            ));
        }
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
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL AND result_type IS NOT NULL
            """, cardId, games.get(0), games.get(games.size() - 1));
        if (results > 0)
            throw new IllegalArgumentException("เกมนี้มีการกรอกผลแล้ว — ใช้การสลับผู้เล่น (Swap) แทนการยกเลิกการจับคู่");
        if (card.currentGame() == 1) {
            // Game 1 preview re-derives pairs from table_seats, so drop the matches confirm created.
            jdbc.update("DELETE FROM matches WHERE card_id = ? AND game_number = 1 AND snapshot_no IS NULL", cardId);
        } else {
            jdbc.update("UPDATE matches SET pairing_published_at = NULL WHERE card_id = ? AND game_number = ?", cardId, card.currentGame());
        }
        jdbc.update("UPDATE games SET status = 'PENDING' WHERE card_id = ? AND game_number = ?", cardId, card.currentGame());
        jdbc.update("UPDATE tournament_cards SET runtime_stage = 'PAIRING_PREVIEW', version = version + 1 WHERE id = ?", cardId);
        publishPublic(cardId);
        audit(cardId, actor, "UNPAIR_TO_PREVIEW", "result collection เกม " + card.currentGame(), "กลับสู่ pairing preview");
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.ResultPatch submitResult(UUID cardId, String matchId, CardDtos.ResultRequest request, String actor,
                                             boolean canOverridePenalty) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_COLLECTION);
        int scoreOne = request.scoreOne();
        int scoreTwo = request.scoreTwo();
        MatchKey key = parseMatchId(matchId);
        MatchPlayers match = matchRow(cardId, key);
        // A bye = exactly one player present (no opponent). Both-null means a PAIR_RESULT destination
        // still waiting on its source game.
        boolean bye = isBye(match);
        if (match.oneId() == null && match.twoId() == null)
            throw new IllegalArgumentException("คู่แข่งขันของเกมนี้ยังไม่ครบ รอผลจาก Game ต้นทางก่อน");
        if (match.snapshotNo() != null) throw new IllegalArgumentException("Confirmed results are immutable");
        if ("PENALTY".equals(match.resultType()) && !canOverridePenalty)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                "ผลคู่นี้ถูกลงดาบและล็อกโดยผู้อำนวยการ เจ้าหน้าที่ไม่สามารถแก้ไขได้");
        List<Integer> activeGames = activeResultGames(card);
        if (!activeGames.contains(match.gameNumber()))
            throw new IllegalArgumentException("แก้ผลได้เฉพาะเกมใน Result block ปัจจุบัน " + activeGames);
        // A materialised game-2 bye is only final once its source group is fully recorded.
        if (bye && match.gameNumber() > activeGames.get(0) && isOutgoingPairResult(cardId, match.gameNumber() - 1)
            && !pairResultSourceGroupComplete(cardId, match.gameNumber() - 1, match.tableNumber()))
            throw new IllegalArgumentException("รอผลของกลุ่มต้นทางให้ครบก่อน จึงจะกรอกคู่บาย (bye) ได้");
        boolean existing = match.resultType() != null;
        if (existing && !request.editExisting()) throw new IllegalArgumentException("กรุณากด Edit ก่อนแก้ไขผลที่บันทึกแล้ว");
        Object previousResult = existing ? previousResultAudit(match) : Map.of("matchId", matchId, "status", "UNRECORDED");
        boolean draw = scoreOne == scoreTwo;
        Integer winner;
        String winnerExternal;
        String resultType;
        int calculatedDiff = Math.min(Math.abs(scoreOne - scoreTwo), match.maxDiff());
        if (bye) {
            // The lone player must win; the entered margin becomes their diff (capped by max diff).
            boolean presentIsOne = match.oneId() != null;
            int presentScore = presentIsOne ? scoreOne : scoreTwo;
            int otherScore = presentIsOne ? scoreTwo : scoreOne;
            if (presentScore <= otherScore)
                throw new IllegalArgumentException("คู่ที่ไม่มีคู่แข่ง (บาย) ต้องให้ผู้เล่นที่อยู่เป็นผู้ชนะเท่านั้น");
            winner = presentIsOne ? match.oneId() : match.twoId();
            resultType = "WIN";
        } else {
            winner = draw ? null : scoreOne > scoreTwo ? match.oneId() : match.twoId();
            resultType = draw ? "DRAW" : "WIN";
        }
        winnerExternal = pcode(winner);

        saveResultColumns(cardId, key, winner, scoreOne, scoreTwo, resultType, calculatedDiff, actor);
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
        boolean deferredSwissSource = updatesPairResultDestination
            && isDeferredSwissSource(cardId, card.currentGame(), match.tableNumber());
        if (updatesPairResultDestination && !deferredSwissSource)
            syncPairResultSource(cardId, card.currentGame(), match.tableNumber());
        // The bottom Swiss group is not materialised live — it auto-pairs once all its results are in.
        boolean deferredSwissMaterialized = deferredSwissSource
            && tryMaterializeDeferredSwiss(cardId, card.currentGame());
        if (match.pairingPublishedAt() != null || match.snapshotNo() != null)
            publishPublic(cardId);
        // A normal save changes one row. PAIR_RESULT can additionally materialize/update two
        // destination rows. Broadcasting only those rows keeps SSE traffic bounded at O(1).
        int destinationGame = updatesPairResultDestination ? card.currentGame() + 1 : -1;
        int destinationGroupStart = updatesPairResultDestination
            ? ((match.tableNumber() - 1) / 2) * 2 + 1
            : -1;
        return new CardDtos.ResultPatch(cardVersion(cardId),
            changedResultPairings(cardId, key, destinationGame, destinationGroupStart, deferredSwissMaterialized));
    }

    private List<CardDtos.PairingResponse> changedResultPairings(
        UUID cardId, MatchKey source, int destinationGame, int destinationGroupStart,
        boolean includeWholeDestination
    ) {
        if (includeWholeDestination) {
            return jdbc.query("""
                SELECT m.game_number, m.table_number, m.player_one, m.player_two, m.winner,
                       m.score_one, m.score_two, m.result_type, m.calculated_diff,
                       m.snapshot_no, m.pairing_published_at, s.confirmed_at
                FROM matches m
                LEFT JOIN pairing_snapshots s ON s.card_id = m.card_id AND s.snapshot_no = m.snapshot_no
                WHERE m.card_id = ? AND m.snapshot_no IS NULL
                  AND ((m.game_number = ? AND m.table_number = ?) OR m.game_number = ?)
                ORDER BY m.game_number, m.table_number
                """, this::mapPairingRow,
                cardId, source.gameNumber(), source.tableNumber(), destinationGame)
                .stream().map(row -> toPairingResponse(row, true)).toList();
        }
        return jdbc.query("""
            SELECT m.game_number, m.table_number, m.player_one, m.player_two, m.winner,
                   m.score_one, m.score_two, m.result_type, m.calculated_diff,
                   m.snapshot_no, m.pairing_published_at, s.confirmed_at
            FROM matches m
            LEFT JOIN pairing_snapshots s ON s.card_id = m.card_id AND s.snapshot_no = m.snapshot_no
            WHERE m.card_id = ? AND m.snapshot_no IS NULL
              AND ((m.game_number = ? AND m.table_number = ?) OR (m.game_number = ? AND m.table_number IN (?, ?)))
            ORDER BY m.game_number, m.table_number
            """, this::mapPairingRow,
            cardId, source.gameNumber(), source.tableNumber(), destinationGame, destinationGroupStart, destinationGroupStart + 1)
            .stream().map(row -> toPairingResponse(row, true)).toList();
    }

    @Transactional
    public CardDtos.CardResponse reviewResults(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.RESULT_COLLECTION);
        List<Integer> games = activeResultGames(card);
        int firstGame = games.get(0);
        int lastGame = games.get(games.size() - 1);
        // ceil(N/2) matches per game accounts for a possible bye (one-player pairing).
        long expected = (blockParticipants(cardId, firstGame, lastGame) + 1) / 2 * games.size();
        long total = count("SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL",
            cardId, firstGame, lastGame);
        long completed = count("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL
              AND result_type IN ('W', 'D') AND calculated_diff IS NOT NULL
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
        var rows = pairingRows(cardId);
        List<Integer> gameNumbers = activeResultGames(card);
        var current = rows.stream().filter(row -> gameNumbers.contains(row.gameNumber())).toList();
        if (current.isEmpty()) throw new IllegalArgumentException("No pairing preview exists for the current game");
        var bundleRows = rows.stream().filter(row -> row.snapshotNo() == null && gameNumbers.contains(row.gameNumber())).toList();
        long expected = (blockParticipants(cardId, gameNumbers.get(0), gameNumbers.get(gameNumbers.size() - 1)) + 1) / 2 * gameNumbers.size();
        if (bundleRows.size() != expected)
            throw new IllegalArgumentException("Pairing block ไม่ครบ: พบ " + bundleRows.size() + " จาก " + expected + " คู่");
        if (bundleRows.stream().anyMatch(row -> row.scoreOne() == null || row.scoreTwo() == null || row.resultType() == null))
            throw new IllegalArgumentException("Every match requires a calculated result before confirmation");

        int gameFrom = gameNumbers.get(0);
        int gameTo = gameNumbers.get(gameNumbers.size() - 1);
        jdbc.update("""
            UPDATE matches SET pairing_published_at = COALESCE(pairing_published_at, now())
            WHERE card_id = ? AND game_number BETWEEN ? AND ?
            """, cardId, gameFrom, gameTo);

        // The snapshot is only a confirmation marker; its pairings are always rebuilt from matches on read.
        Integer snapshotNo = jdbc.queryForObject(
            "SELECT COALESCE(MAX(snapshot_no), 0) + 1 FROM pairing_snapshots WHERE card_id = ?", Integer.class, cardId);
        jdbc.update("""
            INSERT INTO pairing_snapshots (card_id, snapshot_no, game_from, game_to, confirmed_at)
            VALUES (?, ?, ?, ?, now())
            """, cardId, snapshotNo, gameFrom, gameTo);
        jdbc.update("UPDATE matches SET snapshot_no = ? WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL",
            snapshotNo, cardId, gameFrom, gameTo);
        jdbc.update("UPDATE games SET status = 'COMPLETED' WHERE card_id = ? AND game_number BETWEEN ? AND ?", cardId, gameFrom, gameTo);
        boolean finished = gameTo >= card.numberOfGames();
        recalculateStandings(cardId);
        // If the card has a final round, the last regular game leads to FINAL_SEEDING (director then starts it),
        // not straight to FINAL_PUBLISHED.
        boolean hasFinal = finished && !"NONE".equals(card.finalType());
        jdbc.update("""
            UPDATE tournament_cards SET current_game = ?, status = ?, runtime_stage = ?, version = version + 1 WHERE id = ?
            """, finished ? gameTo : gameTo + 1,
            (!finished || hasFinal) ? "RUNNING" : "FINISHED",
            !finished ? "TABLE_PAIRING" : (hasFinal ? "FINAL_SEEDING" : "FINAL_PUBLISHED"), cardId);
        publishPublic(cardId);
        if (!finished) jdbc.update("DELETE FROM table_seats WHERE card_id = ?", cardId);
        audit(cardId, actor, finished ? "PUBLISH_FINAL_RESULTS" : "PUBLISH_GAME_RESULTS", "game " + gameNumbers + " review",
            bundleRows.size() + " pairings published (snapshot " + snapshotNo + ")");
        return get(cardId, true);
    }

    // ---- Final / championship round ----

    /** Director starts the final: lock seeds (top 2 / top 4 from standings) into the bracket. */
    @Transactional
    public CardDtos.CardResponse startFinalRound(UUID cardId, String actor) {
        CardRow card = requireStage(cardId, RuntimeStage.FINAL_SEEDING);
        int slotCount = "CHAMPION_AND_THIRD".equals(card.finalType()) ? 2 : 1;
        int needed = slotCount * 2;
        List<Integer> seeds = jdbc.queryForList("""
            SELECT s.player_code FROM standings s
            JOIN players p ON p.card_id = s.card_id AND p.code = s.player_code AND p.terminated_at IS NULL
            WHERE s.card_id = ?
            ORDER BY s.rank NULLS LAST, s.win_points DESC, s.diff DESC LIMIT ?
            """, Integer.class, cardId, needed);
        if (seeds.size() < needed)
            throw new IllegalArgumentException("ผู้เล่นไม่พอสำหรับรอบชิง (ต้องการ " + needed + " คน มี " + seeds.size() + " คน)");
        jdbc.update("DELETE FROM final_game_results WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM final_pairings WHERE card_id = ?", cardId);
        for (int slot = 0; slot < slotCount; slot++) {
            jdbc.update("INSERT INTO final_pairings (card_id, slot, player_one, player_two) VALUES (?, ?, ?, ?)",
                cardId, slot, seeds.get(slot * 2), seeds.get(slot * 2 + 1));
            for (int game = 1; game <= card.finalGames(); game++)
                jdbc.update("INSERT INTO final_game_results (card_id, slot, game_index) VALUES (?, ?, ?)",
                    cardId, slot, game);
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
        int winnerCode = playerCode(cardId, winnerExternalId);
        int updated = jdbc.update("""
            UPDATE final_pairings SET winner = ? WHERE card_id = ? AND slot = ? AND (player_one = ? OR player_two = ?)
            """, winnerCode, cardId, slot, winnerCode, winnerCode);
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
        if (count("SELECT COUNT(*) FROM final_pairings WHERE card_id = ? AND winner IS NULL", cardId) > 0)
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

        discardCurrentPairing(cardId, card.currentGame());
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
    public CardDtos.CardResponse overrideResult(UUID cardId, String matchId, CardDtos.ResultRequest request, String actor) {
        ensureEditable(cardId);
        requireRegularEditable(cardId);
        MatchKey key = parseMatchId(matchId);
        MatchPlayers match = matchRow(cardId, key);
        boolean bye = isBye(match);
        if (match.oneId() == null && match.twoId() == null)
            throw new IllegalArgumentException("คู่แข่งขันนี้ยังไม่ครบ");
        int scoreOne = request.scoreOne();
        int scoreTwo = request.scoreTwo();
        boolean draw = scoreOne == scoreTwo;
        Integer winner;
        String winnerExternal;
        String resultType;
        int calculatedDiff = Math.min(Math.abs(scoreOne - scoreTwo), match.maxDiff());
        if (bye) {
            boolean presentIsOne = match.oneId() != null;
            int presentScore = presentIsOne ? scoreOne : scoreTwo;
            int otherScore = presentIsOne ? scoreTwo : scoreOne;
            if (presentScore <= otherScore)
                throw new IllegalArgumentException("คู่ที่ไม่มีคู่แข่ง (บาย) ต้องให้ผู้เล่นที่อยู่เป็นผู้ชนะเท่านั้น");
            winner = presentIsOne ? match.oneId() : match.twoId();
            resultType = "WIN";
        } else {
            winner = draw ? null : scoreOne > scoreTwo ? match.oneId() : match.twoId();
            resultType = draw ? "DRAW" : "WIN";
        }
        winnerExternal = pcode(winner);
        boolean existing = match.resultType() != null;
        Object previous = existing ? previousResultAudit(match) : Map.of("matchId", matchId, "status", "UNRECORDED");
        saveResultColumns(cardId, key, winner, scoreOne, scoreTwo, resultType, calculatedDiff, actor);
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

    /**
     * Director "ลงดาบ" (penalty): force both players of a pairing to LOSE by {@code points} (no winner,
     * 0 win points, diff −points each). Works on any pairing, including a one-player bye.
     */
    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse applyPenalty(UUID cardId, String matchId, int points, String actor) {
        ensureEditable(cardId);
        requireRegularEditable(cardId);
        if (points < 0) throw new IllegalArgumentException("แต้มลงดาบต้องไม่ติดลบ");
        MatchKey key = parseMatchId(matchId);
        MatchPlayers match = matchRow(cardId, key);
        if (match.oneId() == null && match.twoId() == null)
            throw new IllegalArgumentException("คู่แข่งขันนี้ยังไม่ครบ");
        boolean existing = match.resultType() != null;
        Object previous = existing ? previousResultAudit(match) : Map.of("matchId", matchId, "status", "UNRECORDED");
        saveResultColumns(cardId, key, null, 0, 0, "PENALTY", points, actor);
        recalculateStandings(cardId);
        touch(cardId);
        publishPublic(cardId);
        audit(cardId, actor, "PENALTY_RESULT", previous, Map.of("points", points, "game", match.gameNumber(), "table", match.tableNumber()));
        return get(cardId, true);
    }

    private void deleteUnpublishedMatches(UUID cardId, int afterGame) {
        jdbc.update("DELETE FROM matches WHERE card_id = ? AND snapshot_no IS NULL AND game_number > ?", cardId, afterGame);
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
        jdbc.update("DELETE FROM matches WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM standings WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM table_seats WHERE card_id = ?", cardId);
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
        String[] firstNames = {"กฤต", "ชนัญญา", "ธนภัทร", "ปุณณวิช", "พิมพ์ชนก", "รวิศ", "ศิริน", "ณัฐดนัย"};
        String[] lastNames = {"อนันต์กุล", "บุญรักษา", "วัฒนชัย", "ศรีสุข", "ธรรมวงศ์", "ชูเกียรติ"};
        String[] schools = {"สาธิตพัฒนา", "วิทยาคม", "อนุสรณ์ศึกษา", "ประชารัฐ", "วชิรวิทย์", "เทพศิรินทร์"};
        for (int index = 0; index < amount; index++) {
            int code = index + 1;
            jdbc.update("""
                INSERT INTO players (card_id, code, first_name, last_name, school)
                VALUES (?, ?, ?, ?, ?)
                """, cardId, code, firstNames[index % firstNames.length],
                lastNames[(index * 3) % lastNames.length], schools[(index * 5 + index / 4) % schools.length]);
            jdbc.update("INSERT INTO standings (card_id, player_code) VALUES (?, ?)", cardId, code);
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
                SELECT game_number, table_number, (player_one IS NOT NULL) one_present, (player_two IS NOT NULL) two_present
                FROM matches
                WHERE card_id = ? AND game_number BETWEEN ? AND ? AND snapshot_no IS NULL
                  AND result_type IS NULL AND (player_one IS NOT NULL OR player_two IS NOT NULL)
                ORDER BY game_number, table_number LIMIT 1
                """, (rs, row) -> new AutoMatch(rs.getInt("game_number"), rs.getInt("table_number"),
                    rs.getBoolean("one_present"), rs.getBoolean("two_present")),
                cardId, games.get(0), games.get(games.size() - 1)).stream().findFirst().orElse(null);
            if (match == null) break;
            int scoreOne, scoreTwo;
            if (!match.onePresent() || !match.twoPresent()) {
                // Bye: the lone present player must win.
                scoreOne = match.onePresent() ? 100 : 0;
                scoreTwo = match.twoPresent() ? 100 : 0;
            } else {
                boolean firstWins = match.tableNumber() % 2 == 1;
                scoreOne = firstWins ? 100 : 72;
                scoreTwo = firstWins ? 72 : 100;
            }
            submitResult(cardId, matchApiId(match.gameNumber(), match.tableNumber()),
                new CardDtos.ResultRequest(scoreOne, scoreTwo, false), actor, true);
            generated++;
        }
        if (generated == 0) throw new IllegalArgumentException("Open the current result block before generating results");
        return get(cardId, true);
    }

    @Transactional
    @EvictPublicCard
    public CardDtos.CardResponse simulate(UUID cardId, String actor) {
        resetRuntimeData(cardId, actor, false);
        if (activePlayerCount(cardId) < 2)
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
        jdbc.update("DELETE FROM matches WHERE card_id = ?", cardId);
        jdbc.execute("SET LOCAL app.allow_snapshot_delete = 'on'");
        jdbc.update("DELETE FROM pairing_snapshots WHERE card_id = ?", cardId);
        jdbc.update("DELETE FROM table_seats WHERE card_id = ?", cardId);
        jdbc.update("UPDATE standings SET wins = 0, draws = 0, losses = 0, win_points = 0, diff = 0, rank = NULL WHERE card_id = ?", cardId);
        jdbc.update("UPDATE games SET status = 'PENDING' WHERE card_id = ?", cardId);
        jdbc.update("UPDATE tournament_cards SET status = 'DRAFT', runtime_stage = 'PLAYER_REGISTRATION', current_game = 1, version = version + 1 WHERE id = ?", cardId);
        if (writeAudit) audit(cardId, actor, "RESET_CARD", null, "runtime reset");
    }

    private List<Integer> activeResultGames(CardRow card) {
        if (card.currentGame() < card.numberOfGames() && isOutgoingPairResult(card.id(), card.currentGame()))
            return List.of(card.currentGame(), card.currentGame() + 1);
        return List.of(card.currentGame());
    }

    private boolean isOutgoingPairResult(UUID cardId, int sourceGame) {
        return count("SELECT COUNT(*) FROM pairing_rules WHERE card_id = ? AND from_game = ? AND rule_type = 'PAIR_RESULT'", cardId, sourceGame) > 0;
    }

    private boolean isBye(MatchPlayers match) {
        return (match.oneId() == null) ^ (match.twoId() == null);
    }

    private int gameMatchCount(UUID cardId, int gameNumber) {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = ?",
            Long.class, cardId, gameNumber);
        return n == null ? 0 : n.intValue();
    }

    /**
     * Number of game-1 source tables that form the deferred Swiss group. When the field is not a
     * multiple of four, the bottom 6 (remainder 2) / bottom 5 (remainder 1) — the last 3 game-1 tables
     * — are paired into game 2 by Swiss rather than the live win/win–lose/lose rule.
     */
    private int deferredSwissTableCount(UUID cardId, int sourceGame) {
        // Count who actually entered this source game. This also works after terminate/restore.
        long players = count("""
            SELECT COUNT(*) FROM players p WHERE p.card_id = ? AND EXISTS (
              SELECT 1 FROM matches m WHERE m.card_id = p.card_id AND m.game_number = ?
                AND (m.player_one = p.code OR m.player_two = p.code))
            """, cardId, sourceGame);
        if (players == 0) players = activeInGame(cardId, sourceGame);
        int remainder = (int) (players % 4);
        if (remainder != 1 && remainder != 2) return 0;
        int tables = (int) ((players + 1) / 2); // ceil(N/2) = source-game matches
        return Math.min(3, tables);
    }

    private boolean isDeferredSwissSource(UUID cardId, int sourceGame, int sourceTable) {
        int deferred = deferredSwissTableCount(cardId, sourceGame);
        if (deferred == 0) return false;
        return sourceTable > gameMatchCount(cardId, sourceGame) - deferred;
    }

    /**
     * Once every source-game result of the bottom group is recorded, Swiss-pair those players (scored
     * from that source game only) into the destination game. An odd group leaves its lowest-ranked
     * player as a destination-game bye. The
     * destination tables sit after the live win/win–lose/lose tables.
     */
    private boolean tryMaterializeDeferredSwiss(UUID cardId, int sourceGame) {
        int deferred = deferredSwissTableCount(cardId, sourceGame);
        if (deferred == 0) return false;
        int total = gameMatchCount(cardId, sourceGame);
        int firstDeferred = total - deferred + 1;
        Long pending = jdbc.queryForObject("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND table_number >= ? AND result_type IS NULL
            """, Long.class, cardId, sourceGame, firstDeferred);
        if (pending != null && pending > 0) return false;
        int destGame = sourceGame + 1;
        int topTables = firstDeferred - 1; // live destination tables occupy 1..topTables
        Long already = jdbc.queryForObject("SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = ? AND table_number > ?",
            Long.class, cardId, destGame, topTables);
        if (already != null && already > 0) return false;

        var rows = jdbc.query("""
            SELECT player_one, player_two, winner, result_type, calculated_diff
            FROM matches WHERE card_id = ? AND game_number = ? AND table_number >= ?
            """, (rs, row) -> new ScoreRow(nullableInt(rs, "player_one"), nullableInt(rs, "player_two"),
                nullableInt(rs, "winner"), rtName(rs.getString("result_type")), rs.getInt("calculated_diff")),
            cardId, sourceGame, firstDeferred);
        Map<Integer, int[]> score = new LinkedHashMap<>(); // playerCode -> [winPoints, diff]
        for (ScoreRow row : rows) {
            if (row.one() != null) score.computeIfAbsent(row.one(), key -> new int[2]);
            if (row.two() != null) score.computeIfAbsent(row.two(), key -> new int[2]);
            if ("DRAW".equals(row.resultType())) {
                if (row.one() != null) score.get(row.one())[0] += 1;
                if (row.two() != null) score.get(row.two())[0] += 1;
            } else if ("PENALTY".equals(row.resultType())) {
                if (row.one() != null) score.get(row.one())[1] -= row.calculatedDiff();
                if (row.two() != null) score.get(row.two())[1] -= row.calculatedDiff();
            } else {
                Integer winner = row.winner();
                Integer loser = winner != null && winner.equals(row.one()) ? row.two() : row.one();
                if (winner != null) { score.get(winner)[0] += 2; score.get(winner)[1] += row.calculatedDiff(); }
                if (loser != null) score.get(loser)[1] -= row.calculatedDiff();
            }
        }

        Comparator<PairingStrategy.PlayerScore> ranking = Comparator.comparingInt(PairingStrategy.PlayerScore::winPoints).reversed()
            .thenComparing(Comparator.comparingInt(PairingStrategy.PlayerScore::diff).reversed())
            .thenComparing(PairingStrategy.PlayerScore::playerId);
        List<PairingStrategy.PlayerScore> ranked = new ArrayList<>(score.entrySet().stream()
            .map(entry -> new PairingStrategy.PlayerScore(String.valueOf(entry.getKey()), "", entry.getValue()[0], entry.getValue()[1]))
            .sorted(ranking).toList());
        PairingStrategy.PlayerScore byePlayer = ranked.size() % 2 != 0 ? ranked.remove(ranked.size() - 1) : null;
        List<PairingStrategy.Pair> pairs = ranked.isEmpty() ? List.of()
            : strategies.resolve(PairingRuleType.SWISS).generate(ranked, new PairingStrategy.PairingContext(destGame, List.of()));
        pairs = orderPairsForTables(cardId, pairs, byePlayer == null ? null : byePlayer.playerId());
        int tableNumber = topTables + 1;
        for (PairingStrategy.Pair pair : pairs) {
            jdbc.update("""
                INSERT INTO matches (card_id, game_number, table_number, player_one, player_two) VALUES (?, ?, ?, ?, ?)
                """, cardId, destGame, tableNumber++, Integer.parseInt(pair.playerOneId()), Integer.parseInt(pair.playerTwoId()));
        }
        if (byePlayer != null)
            jdbc.update("""
                INSERT INTO matches (card_id, game_number, table_number, player_one, player_two) VALUES (?, ?, ?, ?, NULL)
                """, cardId, destGame, tableNumber, Integer.parseInt(byePlayer.playerId()));
        jdbc.update("UPDATE games SET status = 'OPEN' WHERE card_id = ? AND game_number = ?", cardId, destGame);
        audit(cardId, "system", "MATERIALIZE_DEFERRED_SWISS", null, Map.of(
            "sourceGame", sourceGame, "players", score.size(), "destTablesFrom", topTables + 1));
        return true;
    }

    /** A materialised game-2 bye is final only when every source match of its group has a result. */
    private boolean pairResultSourceGroupComplete(UUID cardId, int sourceGame, int destTableNumber) {
        int groupStart = ((destTableNumber - 1) / 2) * 2 + 1;
        Long total = jdbc.queryForObject("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND table_number IN (?, ?)
            """, Long.class, cardId, sourceGame, groupStart, groupStart + 1);
        Long pending = jdbc.queryForObject("""
            SELECT COUNT(*) FROM matches
            WHERE card_id = ? AND game_number = ? AND table_number IN (?, ?) AND result_type IS NULL
            """, Long.class, cardId, sourceGame, groupStart, groupStart + 1);
        return total != null && total > 0 && (pending == null || pending == 0);
    }

    private void syncPairResultSource(UUID cardId, int sourceGame, int sourceTableNumber) {
        int groupStart = ((sourceTableNumber - 1) / 2) * 2 + 1;
        PairResultSource source = jdbc.query("""
            SELECT table_number, player_one, player_two, winner, result_type
            FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?
            """, (rs, row) -> new PairResultSource(
                rs.getInt("table_number"), nullableInt(rs, "player_one"), nullableInt(rs, "player_two"),
                nullableInt(rs, "winner"), rtName(rs.getString("result_type"))
            ), cardId, sourceGame, sourceTableNumber).stream().findFirst().orElse(null);
        if (source == null || source.resultType() == null) return;

        PairResultSlots slots = pairResultSlots(source);
        int destinationGame = sourceGame + 1;
        int slotNumber = source.tableNumber() == groupStart ? 1 : 2;
        boolean upperChanged = syncPairResultSlot(cardId, destinationGame, groupStart, slotNumber, slots.upper());
        boolean lowerChanged = syncPairResultSlot(cardId, destinationGame, groupStart + 1, slotNumber, slots.lower());
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
        Integer upper = source.winnerId() != null ? source.winnerId() : source.oneId();
        Integer lower = upper.equals(source.oneId()) ? source.twoId() : source.oneId();
        return new PairResultSlots(upper, lower);
    }

    private boolean syncPairResultSlot(UUID cardId, int gameNumber, int tableNumber, int slotNumber, Integer playerCode) {
        // A bye source has no loser to place — leave that destination slot empty (it becomes a game-2 bye).
        if (playerCode == null) return false;
        PairResultDestination existing = jdbc.query("""
            SELECT player_one, player_two, (result_type IS NOT NULL) has_result
            FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?
            """, (rs, row) -> new PairResultDestination(
                nullableInt(rs, "player_one"), nullableInt(rs, "player_two"), rs.getBoolean("has_result")
            ), cardId, gameNumber, tableNumber).stream().findFirst().orElse(null);
        if (existing == null) {
            Integer one = slotNumber == 1 ? playerCode : null;
            Integer two = slotNumber == 2 ? playerCode : null;
            jdbc.update("""
                INSERT INTO matches (card_id, game_number, table_number, player_one, player_two)
                VALUES (?, ?, ?, ?, ?)
                """, cardId, gameNumber, tableNumber, one, two);
            return true;
        }
        Integer current = slotNumber == 1 ? existing.oneId() : existing.twoId();
        Integer other = slotNumber == 1 ? existing.twoId() : existing.oneId();
        if (Objects.equals(current, playerCode)) return false;
        if (existing.hasResult())
            throw new IllegalArgumentException("ผล Game ถัดไปถูกบันทึกแล้ว จึงเปลี่ยนผู้ชนะ/ผู้แพ้ของ Game ต้นทางไม่ได้");
        if (Objects.equals(other, playerCode))
            throw new IllegalArgumentException("PAIR_RESULT ทำให้ผู้เล่นคนเดียวกันอยู่สองฝั่งในคู่เดียวกัน กรุณาตรวจ Game ต้นทาง");
        jdbc.update("UPDATE matches SET player_" + (slotNumber == 1 ? "one" : "two") + " = ? WHERE card_id = ? AND game_number = ? AND table_number = ?",
            playerCode, cardId, gameNumber, tableNumber);
        return true;
    }

    private PairingRuleType generateSystemMatches(UUID cardId, int gameNumber) {
        if (count("SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = ?", cardId, gameNumber) > 0)
            throw new IllegalArgumentException("มี pairing ของเกมนี้อยู่แล้ว");
        var scores = loadScores(cardId);
        var history = jdbc.query("SELECT player_one, player_two FROM matches WHERE card_id = ? AND player_one IS NOT NULL AND player_two IS NOT NULL",
            (rs, row) -> new PairingStrategy.Pair(String.valueOf(rs.getInt("player_one")), String.valueOf(rs.getInt("player_two"))), cardId);
        PairingRuleType appliedRule = ruleForGame(cardId, gameNumber);
        if (appliedRule == PairingRuleType.PAIR_RESULT)
            throw new IllegalArgumentException("เกมแบบแพ้เจอแพ้/ชนะเจอชนะต้องถูกสร้างจากผลของเกมก่อนหน้าโดยอัตโนมัติ");
        // Every strategy receives an even field. Ranked modes give the lowest-ranked player the bye;
        // RANDOM chooses it from a pre-shuffle so regenerating the preview produces a fresh result.
        Integer byePlayer = null;
        if (scores.size() % 2 != 0) {
            List<PairingStrategy.PlayerScore> ranked = new ArrayList<>(scores);
            if (appliedRule == PairingRuleType.RANDOM) Collections.shuffle(ranked, secureRandom);
            else {
                Comparator<PairingStrategy.PlayerScore> ranking = Comparator.comparingInt(PairingStrategy.PlayerScore::winPoints).reversed()
                    .thenComparing(Comparator.comparingInt(PairingStrategy.PlayerScore::diff).reversed())
                    .thenComparing(PairingStrategy.PlayerScore::playerId);
                ranked.sort(ranking);
            }
            PairingStrategy.PlayerScore bye = ranked.remove(ranked.size() - 1);
            byePlayer = Integer.valueOf(bye.playerId());
            scores = ranked;
        }
        var context = new PairingStrategy.PairingContext(gameNumber, history);
        var pairs = orderPairsForTables(cardId,
            applyGibsonPairing(cardId, gameNumber, scores, context, appliedRule),
            byePlayer == null ? null : String.valueOf(byePlayer));
        int table = 1;
        for (var pair : pairs) {
            jdbc.update("""
                INSERT INTO matches (card_id, game_number, table_number, player_one, player_two)
                VALUES (?, ?, ?, ?, ?)
                """, cardId, gameNumber, table++, Integer.parseInt(pair.playerOneId()), Integer.parseInt(pair.playerTwoId()));
        }
        if (byePlayer != null)
            jdbc.update("""
                INSERT INTO matches (card_id, game_number, table_number, player_one, player_two)
                VALUES (?, ?, ?, ?, NULL)
                """, cardId, gameNumber, table, byePlayer);
        return appliedRule;
    }

    private List<PairingStrategy.Pair> orderPairsForTables(
        UUID cardId,
        List<PairingStrategy.Pair> pairs,
        String byePlayerId
    ) {
        if (pairs.size() < 2) return pairs;
        List<PairingStrategy.PlayerScore> players = jdbc.query("""
            SELECT code, school FROM players WHERE card_id = ?
            """, (rs, row) -> new PairingStrategy.PlayerScore(
                String.valueOf(rs.getInt("code")), rs.getString("school"), 0, 0), cardId);
        return SchoolAwarePairing.orderForTables(pairs, players, secureRandom, byePlayerId);
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
        if (count("SELECT COUNT(*) FROM matches WHERE card_id = ? AND game_number = 1", cardId) > 0)
            throw new IllegalArgumentException("ยืนยัน pairing เกม 1 แล้ว");
        var seats = jdbc.query("""
            SELECT table_no, seat_no, player_code FROM table_seats
            WHERE card_id = ? ORDER BY table_no, seat_no
            """, (rs, row) -> new TableSeat(rs.getInt("table_no"), rs.getInt("seat_no"), rs.getInt("player_code"), null), cardId);
        Map<Integer, List<TableSeat>> byTable = new LinkedHashMap<>();
        seats.forEach(seat -> byTable.computeIfAbsent(seat.tableNumber(), ignored -> new ArrayList<>()).add(seat));
        int matchNumber = 1;
        for (var tableSeats : byTable.values()) {
            for (int index = 0; index < tableSeats.size(); index += 2) {
                // A lone trailing seat is a bye: one player, no opponent (player_two NULL).
                Integer two = index + 1 < tableSeats.size() ? tableSeats.get(index + 1).playerCode() : null;
                jdbc.update("""
                    INSERT INTO matches (card_id, game_number, table_number, player_one, player_two)
                    VALUES (?, 1, ?, ?, ?)
                    """, cardId, matchNumber++, tableSeats.get(index).playerCode(), two);
            }
        }
    }

    private boolean wouldCreateSchoolConflict(UUID cardId, int first, int second) {
        var seats = jdbc.query("""
            SELECT ts.table_no, ts.seat_no, ts.player_code, p.school
            FROM table_seats ts JOIN players p ON p.card_id = ts.card_id AND p.code = ts.player_code
            WHERE ts.card_id = ? ORDER BY ts.table_no, ts.seat_no
            """, (rs, row) -> new TableSeat(rs.getInt("table_no"), rs.getInt("seat_no"), rs.getInt("player_code"), rs.getString("school")), cardId);
        String firstSchool = seats.stream().filter(seat -> seat.playerCode() == first).map(TableSeat::school).findFirst().orElseThrow();
        String secondSchool = seats.stream().filter(seat -> seat.playerCode() == second).map(TableSeat::school).findFirst().orElseThrow();
        var swapped = seats.stream().map(seat -> seat.playerCode() == first ? new TableSeat(seat.tableNumber(), seat.seatNumber(), second, secondSchool)
            : seat.playerCode() == second ? new TableSeat(seat.tableNumber(), seat.seatNumber(), first, firstSchool) : seat).toList();
        Map<Integer, List<TableSeat>> byTable = new LinkedHashMap<>();
        swapped.forEach(seat -> byTable.computeIfAbsent(seat.tableNumber(), ignored -> new ArrayList<>()).add(seat));
        return byTable.values().stream().anyMatch(table -> {
            for (int index = 0; index + 1 < table.size(); index += 2) {
                TableSeat one = table.get(index); TableSeat two = table.get(index + 1);
                boolean affected = one.playerCode() == first || one.playerCode() == second || two.playerCode() == first || two.playerCode() == second;
                if (affected && one.school().equalsIgnoreCase(two.school())) return true;
            }
            return false;
        });
    }

    private List<CardDtos.TableResponse> loadTables(UUID cardId) {
        var rows = jdbc.query("""
            SELECT table_no, seat_no, player_code FROM table_seats
            WHERE card_id = ? ORDER BY table_no, seat_no
            """, (rs, row) -> new TableSeat(rs.getInt("table_no"), rs.getInt("seat_no"), rs.getInt("player_code"), null), cardId);
        Map<Integer, List<TableSeat>> grouped = new LinkedHashMap<>();
        rows.forEach(row -> grouped.computeIfAbsent(row.tableNumber(), ignored -> new ArrayList<>()).add(row));
        return grouped.entrySet().stream().map(entry -> new CardDtos.TableResponse(String.valueOf(entry.getKey()),
            entry.getKey(), entry.getValue().stream().map(seat -> pcode(seat.playerCode())).toList())).toList();
    }

    private List<CardDtos.SnapshotResponse> loadSnapshots(UUID cardId, boolean staffView) {
        var rows = pairingRows(cardId);
        Map<String, List<PairingRow>> grouped = new LinkedHashMap<>();
        for (PairingRow row : rows) {
            if (!staffView && row.snapshotNo() == null && row.pairingPublishedAt() == null) continue;
            String key = row.snapshotNo() == null ? "preview" : "s" + row.snapshotNo();
            grouped.computeIfAbsent(key, ignored -> new ArrayList<>()).add(row);
        }
        return grouped.entrySet().stream().map(entry -> {
            var group = entry.getValue();
            List<Integer> games = group.stream().map(PairingRow::gameNumber).distinct().sorted().toList();
            String confirmedAt = group.get(0).confirmedAt() == null ? "" : group.get(0).confirmedAt().toInstant().toString();
            String id = entry.getKey().equals("preview") ? "preview-" + games.get(0) : entry.getKey();
            return new CardDtos.SnapshotResponse(id, games, group.stream()
                .map(row -> toPairingResponse(row,
                    staffView || row.snapshotNo() != null || row.pairingPublishedAt() != null)).toList(), confirmedAt);
        }).toList();
    }

    private List<PairingRow> pairingRows(UUID cardId) {
        return jdbc.query("""
            SELECT m.game_number, m.table_number, m.player_one, m.player_two, m.winner,
                   m.score_one, m.score_two, m.result_type, m.calculated_diff,
                   m.snapshot_no, m.pairing_published_at, s.confirmed_at
            FROM matches m
            LEFT JOIN pairing_snapshots s ON s.card_id = m.card_id AND s.snapshot_no = m.snapshot_no
            WHERE m.card_id = ? ORDER BY m.game_number, m.table_number
            """, this::mapPairingRow, cardId);
    }

    private PairingRow mapPairingRow(ResultSet rs, int row) throws SQLException {
        return new PairingRow(rs.getInt("game_number"), rs.getInt("table_number"),
            nullableInt(rs, "player_one"), nullableInt(rs, "player_two"), nullableInt(rs, "winner"),
            nullableInt(rs, "score_one"), nullableInt(rs, "score_two"), rtName(rs.getString("result_type")),
            nullableInt(rs, "calculated_diff"), nullableInt(rs, "snapshot_no"),
            rs.getTimestamp("pairing_published_at"), rs.getTimestamp("confirmed_at"));
    }

    private CardDtos.PairingResponse toPairingResponse(PairingRow row, boolean includeResult) {
        return new CardDtos.PairingResponse(matchApiId(row.gameNumber(), row.tableNumber()), row.gameNumber(), row.tableNumber(),
            pcode(row.playerOne()), pcode(row.playerTwo()),
            includeResult ? pcode(row.winner()) : null,
            includeResult ? row.scoreOne() : null,
            includeResult ? row.scoreTwo() : null,
            includeResult ? row.resultType() : null,
            includeResult ? row.calculatedDiff() : null,
            row.snapshotNo() != null || row.pairingPublishedAt() != null);
    }

    private List<PairingStrategy.PlayerScore> loadScores(UUID cardId) {
        return jdbc.query("""
            SELECT p.code, p.school, COALESCE(s.win_points, 0) win_points, COALESCE(s.diff, 0) diff
            FROM players p LEFT JOIN standings s ON s.card_id = p.card_id AND s.player_code = p.code
            WHERE p.card_id = ? AND p.terminated_at IS NULL
              AND p.rejoin_game <= (SELECT current_game FROM tournament_cards WHERE id = p.card_id)
            ORDER BY p.code
            """, (rs, row) -> new PairingStrategy.PlayerScore(String.valueOf(rs.getInt("code")), rs.getString("school"),
                rs.getInt("win_points"), rs.getInt("diff")), cardId);
    }

    private void recalculateStandings(UUID cardId) {
        jdbc.update("UPDATE standings SET wins = 0, draws = 0, losses = 0, win_points = 0, diff = 0 WHERE card_id = ?", cardId);
        var results = jdbc.query("""
            SELECT player_one, player_two, winner, result_type, calculated_diff
            FROM matches WHERE card_id = ? AND result_type IS NOT NULL
            """, (rs, row) -> new ScoreRow(nullableInt(rs, "player_one"), nullableInt(rs, "player_two"),
                nullableInt(rs, "winner"), rtName(rs.getString("result_type")), rs.getInt("calculated_diff")), cardId);
        for (ScoreRow result : results) {
            if ("DRAW".equals(result.resultType())) {
                jdbc.update("UPDATE standings SET draws = draws + 1, win_points = win_points + 1 WHERE card_id = ? AND player_code IN (?, ?)",
                    cardId, result.one(), result.two());
                continue;
            }
            if ("PENALTY".equals(result.resultType())) {
                // ลงดาบ: both players take a loss with diff −X and no win points (skip a null bye slot).
                for (Integer penalised : new Integer[] { result.one(), result.two() })
                    if (penalised != null) jdbc.update(
                        "UPDATE standings SET losses = losses + 1, diff = diff - ? WHERE card_id = ? AND player_code = ?",
                        result.calculatedDiff(), cardId, penalised);
                continue;
            }
            Integer loser = result.winner().equals(result.one()) ? result.two() : result.one();
            jdbc.update("UPDATE standings SET wins = wins + 1, win_points = win_points + 2, diff = diff + ? WHERE card_id = ? AND player_code = ?",
                result.calculatedDiff(), cardId, result.winner());
            jdbc.update("UPDATE standings SET losses = losses + 1, diff = diff - ? WHERE card_id = ? AND player_code = ?",
                result.calculatedDiff(), cardId, loser);
        }
        // Restored players carry a running loss penalty for the games they missed while terminated
        // (not stored as fake matches — their history shows only games from their return onward).
        jdbc.update("""
            UPDATE standings s SET losses = s.losses + p.carry_losses, diff = s.diff - p.carry_diff
            FROM players p
            WHERE p.card_id = s.card_id AND p.code = s.player_code AND s.card_id = ? AND p.carry_losses > 0
            """, cardId);
    }

    private PairingRuleType ruleForGame(UUID cardId, int gameNumber) {
        if (gameNumber == 1) return PairingRuleType.KING_OF_THE_HILL;
        return jdbc.queryForObject("SELECT rule_type FROM pairing_rules WHERE card_id = ? AND from_game = ?",
            (rs, row) -> PairingRuleType.valueOf(rs.getString("rule_type")), cardId, gameNumber - 1);
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

    /** Player details / termination are editable throughout the tournament but not once it has finished. */
    private void requirePlayerEditable(UUID cardId) {
        CardStatus status = cardRow(cardId).status();
        if (status == CardStatus.FINISHED || status == CardStatus.CLOSED)
            throw new IllegalArgumentException("การแข่งขันจบแล้ว ไม่สามารถแก้ไขข้อมูลผู้เล่นได้");
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

    // ---- small-key plumbing ----

    /** Reads the one match row (result included) or 404s. Every mutation targets it by natural key. */
    private MatchPlayers matchRow(UUID cardId, MatchKey key) {
        try {
            return jdbc.queryForObject("""
                SELECT m.player_one, m.player_two, m.snapshot_no, m.pairing_published_at, m.table_number,
                       m.result_type, m.score_one, m.score_two, m.calculated_diff, m.winner, g.max_diff
                FROM matches m JOIN games g ON g.card_id = m.card_id AND g.game_number = m.game_number
                WHERE m.card_id = ? AND m.game_number = ? AND m.table_number = ?
                """, (rs, row) -> new MatchPlayers(nullableInt(rs, "player_one"), nullableInt(rs, "player_two"),
                nullableInt(rs, "snapshot_no"), key.gameNumber(), rs.getInt("max_diff"), rs.getInt("table_number"),
                rtName(rs.getString("result_type")), nullableInt(rs, "score_one"), nullableInt(rs, "score_two"),
                nullableInt(rs, "calculated_diff"), nullableInt(rs, "winner"),
                rs.getTimestamp("pairing_published_at")), cardId, key.gameNumber(), key.tableNumber());
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Match not found");
        }
    }

    private void saveResultColumns(UUID cardId, MatchKey key, Integer winner, int scoreOne, int scoreTwo,
                                   String resultType, int calculatedDiff, String actor) {
        jdbc.update("""
            UPDATE matches SET winner = ?, score_one = ?, score_two = ?, result_type = ?, calculated_diff = ?,
                               submitted_by = ?, submitted_at = now()
            WHERE card_id = ? AND game_number = ? AND table_number = ?
            """, winner, scoreOne, scoreTwo, rtCode(resultType), calculatedDiff, actor, cardId, key.gameNumber(), key.tableNumber());
    }

    /** The audit "previous" value, mirroring the pre-V20 shape, built from the already-loaded row. */
    private Map<String, Object> previousResultAudit(MatchPlayers match) {
        Map<String, Object> previous = new LinkedHashMap<>();
        previous.put("scoreOne", match.scoreOne());
        previous.put("scoreTwo", match.scoreTwo());
        previous.put("resultType", match.resultType());
        previous.put("calculatedDiff", match.calculatedDiff());
        previous.put("winnerId", pcode(match.winner()));
        return previous;
    }

    private int nextPlayerCode(UUID cardId) {
        Integer next = jdbc.queryForObject("SELECT COALESCE(MAX(code), 0) + 1 FROM players WHERE card_id = ?", Integer.class, cardId);
        return next == null ? 1 : next;
    }

    private int playerCode(UUID cardId, String externalId) {
        int code = codeOf(externalId);
        if (count("SELECT COUNT(*) FROM players WHERE card_id = ? AND code = ?", cardId, code) == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found");
        return code;
    }

    private PlayerAudit playerAudit(UUID cardId, String externalId) {
        try {
            return jdbc.queryForObject("""
                SELECT code, first_name, last_name, school
                FROM players WHERE card_id = ? AND code = ?
                """, (rs, row) -> new PlayerAudit(rs.getInt("code"), rs.getString("first_name"),
                    rs.getString("last_name"), rs.getString("school")), cardId, codeOf(externalId));
        } catch (EmptyResultDataAccessException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found");
        }
    }

    /** "P001" -> 1. The P-prefix code is the player's public identity; storage keeps only the number. */
    private int codeOf(String externalId) {
        if (externalId == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found");
        String digits = externalId.startsWith("P") || externalId.startsWith("p") ? externalId.substring(1) : externalId;
        try {
            return Integer.parseInt(digits);
        } catch (NumberFormatException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Player not found");
        }
    }

    /** 1 -> "P001" (codes above 999 stay naturally wider: 1000 -> "P1000"). */
    private static String pcode(Integer code) {
        return code == null ? null : "P" + String.format("%03d", code);
    }

    private static String matchApiId(int gameNumber, int tableNumber) {
        return "g" + gameNumber + "t" + tableNumber;
    }

    private MatchKey parseMatchId(String matchId) {
        Matcher matcher = matchId == null ? null : MATCH_ID.matcher(matchId);
        if (matcher == null || !matcher.matches())
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Match not found");
        return new MatchKey(Integer.parseInt(matcher.group(1)), Integer.parseInt(matcher.group(2)));
    }

    /** DB code -> API name: W/D/P -> WIN/DRAW/PENALTY. */
    private static String rtName(String code) {
        if (code == null) return null;
        return switch (code) {
            case "W" -> "WIN";
            case "D" -> "DRAW";
            case "P" -> "PENALTY";
            default -> code;
        };
    }

    /** API name -> DB code. */
    private static String rtCode(String name) {
        return name == null ? null : name.substring(0, 1);
    }

    private long count(String sql, Object... args) { return Objects.requireNonNull(jdbc.queryForObject(sql, Long.class, args)); }
    /** Players still in the running competition — terminated players are excluded from pairing/counts/seeds. */
    private long activePlayerCount(UUID cardId) { return count("SELECT COUNT(*) FROM players WHERE card_id = ? AND terminated_at IS NULL", cardId); }
    /** Active players eligible for a given game (excludes those restored to rejoin from a later game). */
    private long activeInGame(UUID cardId, int game) {
        return count("SELECT COUNT(*) FROM players WHERE card_id = ? AND terminated_at IS NULL AND rejoin_game <= ?", cardId, game);
    }

    /**
     * Players counted for a result block: active players plus any terminated after they already played
     * in this block (so terminating a player mid-block does not desync the expected match count).
     */
    private long blockParticipants(UUID cardId, int gameFrom, int gameTo) {
        return count("""
            SELECT COUNT(*) FROM players p
            WHERE p.card_id = ? AND ((p.terminated_at IS NULL AND p.rejoin_game <= ?) OR EXISTS (
                SELECT 1 FROM matches m
                WHERE m.card_id = p.card_id AND m.game_number BETWEEN ? AND ? AND m.snapshot_no IS NULL
                  AND m.result_type IS NOT NULL AND (m.player_one = p.code OR m.player_two = p.code)))
            """, cardId, gameFrom, gameFrom, gameTo);
    }
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
            INSERT INTO audit_logs (card_id, actor, action, old_value, new_value)
            VALUES (?, ?, ?, ?, ?)
            """, cardId, actor, action, auditText(oldValue), auditText(newValue));
    }

    /** Audit values are stored as plain TEXT: strings as-is, structured values as compact JSON text. */
    private String auditText(Object value) {
        if (value == null) return null;
        if (value instanceof String text) return text;
        try { return objectMapper.writeValueAsString(value); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Cannot serialize audit data", error); }
    }

    private String jsonText(String value) {
        return value == null ? "—" : value;
    }

    private Integer nullableInt(ResultSet rs, String column) throws SQLException { int value = rs.getInt(column); return rs.wasNull() ? null : value; }
    private boolean hasInvalidPairResultChain(List<PairingRuleType> rules) {
        for (int i = 1; i < rules.size(); i++) if (rules.get(i) == PairingRuleType.PAIR_RESULT && rules.get(i - 1) == PairingRuleType.PAIR_RESULT) return true;
        return false;
    }

    private record CardRow(UUID id, String name, String division, int numberOfGames, CardStatus status, RuntimeStage runtimeStage, int currentGame, Instant createdAt, long version, String finalType, int finalGames, boolean gibsonEnabled) {}
    private record PlayerAudit(int code, String firstName, String lastName, String school) {
        Map<String, String> asAuditValue() {
            return Map.of("id", pcode(code), "firstName", firstName, "lastName", lastName, "school", school);
        }
    }
    private record Seat(int tableNo, int seatNo, int playerCode) {}
    private record MatchSlot(int tableNumber, Integer oneId, Integer twoId, boolean hasResult) {}
    private record MatchKey(int gameNumber, int tableNumber) {}
    private record MatchPlayers(Integer oneId, Integer twoId, Integer snapshotNo, int gameNumber, int maxDiff, int tableNumber,
                                String resultType, Integer scoreOne, Integer scoreTwo, Integer calculatedDiff, Integer winner,
                                Timestamp pairingPublishedAt) {}
    private record TableSeat(int tableNumber, int seatNumber, int playerCode, String school) {}
    private record PairingRow(int gameNumber, int tableNumber, Integer playerOne, Integer playerTwo, Integer winner,
                              Integer scoreOne, Integer scoreTwo, String resultType, Integer calculatedDiff,
                              Integer snapshotNo, Timestamp pairingPublishedAt, Timestamp confirmedAt) {}
    private record PairResultSource(int tableNumber, Integer oneId, Integer twoId, Integer winnerId, String resultType) {}
    private record PairResultSlots(Integer upper, Integer lower) {}
    private record PairResultDestination(Integer oneId, Integer twoId, boolean hasResult) {}
    private record ScoreRow(Integer one, Integer two, Integer winner, String resultType, int calculatedDiff) {}
    private record AutoMatch(int gameNumber, int tableNumber, boolean onePresent, boolean twoPresent) {}
}
