package com.ctwe.tournament.application;

import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * The only cached application boundary: anonymous card data that is identical for every public user.
 * Back-office reads never pass through this service.
 */
@Service
public class PublicCardReadCache {
    private static final String CATALOG_KEY = "all";
    private static final String VERSIONS_KEY = "all";

    private final JdbcTemplate jdbc;
    private final TournamentCardService cards;

    public PublicCardReadCache(JdbcTemplate jdbc, TournamentCardService cards) {
        this.jdbc = jdbc;
        this.cards = cards;
    }

    @Cacheable(cacheNames = TournamentCaches.PUBLIC_CARD_CATALOG, key = "'" + CATALOG_KEY + "'", sync = true)
    @Transactional(readOnly = true)
    public List<PublicCardDtos.CardSummary> summaries() {
        return List.copyOf(jdbc.query("""
            SELECT c.id, c.tournament_id, c.name, c.division, c.status,
                   CASE
                     WHEN c.status IN ('FINISHED', 'CLOSED') OR c.runtime_stage = 'FINAL_PUBLISHED'
                       THEN 'FINAL_PUBLISHED'
                     WHEN c.runtime_stage = 'PLAYER_REGISTRATION' THEN 'PLAYER_REGISTRATION'
                     WHEN EXISTS (
                       SELECT 1 FROM matches m
                       WHERE m.card_id = c.id AND m.pairing_published_at IS NOT NULL AND m.snapshot_id IS NULL
                     ) THEN 'RESULT_COLLECTION'
                     ELSE 'TABLE_PAIRING'
                   END AS public_stage,
                   c.current_game, c.number_of_games,
                   CASE WHEN c.runtime_stage = 'PLAYER_REGISTRATION' THEN 0
                        ELSE (SELECT count(*) FROM players p WHERE p.card_id = c.id) END AS player_count,
                   (SELECT count(*) FROM games g WHERE g.card_id = c.id AND g.status = 'COMPLETED') AS published_game_count,
                   c.public_version, c.created_at
            FROM tournament_cards c
            ORDER BY c.created_at DESC
            """, (rs, row) -> new PublicCardDtos.CardSummary(
                rs.getObject("id", UUID.class),
                rs.getObject("tournament_id", UUID.class),
                rs.getString("name"),
                rs.getString("division"),
                com.ctwe.tournament.domain.model.CardStatus.valueOf(rs.getString("status")),
                com.ctwe.tournament.domain.model.RuntimeStage.valueOf(rs.getString("public_stage")),
                rs.getInt("current_game"),
                rs.getInt("number_of_games"),
                rs.getInt("player_count"),
                rs.getInt("published_game_count"),
                rs.getLong("public_version"),
                rs.getTimestamp("created_at").toInstant()
            )));
    }

    @Cacheable(cacheNames = TournamentCaches.PUBLIC_CARD_DETAILS, key = "#cardId", sync = true)
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public CardDtos.CardResponse card(UUID cardId) {
        long publicVersion = publicVersion(cardId);
        CardDtos.CardResponse source = cards.get(cardId, false);
        boolean finalPublished = source.runtimeStage() == com.ctwe.tournament.domain.model.RuntimeStage.FINAL_PUBLISHED
            || source.status() == com.ctwe.tournament.domain.model.CardStatus.FINISHED
            || source.status() == com.ctwe.tournament.domain.model.CardStatus.CLOSED;
        boolean collectingPublishedPairing = source.snapshots().stream()
            .anyMatch(snapshot -> snapshot.confirmedAt() == null || snapshot.confirmedAt().isBlank());
        com.ctwe.tournament.domain.model.RuntimeStage publicStage = finalPublished
            ? com.ctwe.tournament.domain.model.RuntimeStage.FINAL_PUBLISHED
            : source.runtimeStage() == com.ctwe.tournament.domain.model.RuntimeStage.PLAYER_REGISTRATION
                ? com.ctwe.tournament.domain.model.RuntimeStage.PLAYER_REGISTRATION
                : collectingPublishedPairing
                    ? com.ctwe.tournament.domain.model.RuntimeStage.RESULT_COLLECTION
                    : com.ctwe.tournament.domain.model.RuntimeStage.TABLE_PAIRING;
        return new CardDtos.CardResponse(
            source.id(), source.tournamentId(), source.name(), source.division(), source.status(), publicStage,
            source.currentGame(), publicVersion, source.games(), List.of(), source.players(), List.of(),
            source.snapshots(), List.of(), source.finalType(), source.finalGames(),
            finalPublished ? source.finalRound() : null, source.gibsonEnabled(), source.createdAt()
        );
    }

    @Cacheable(cacheNames = TournamentCaches.PUBLIC_CARD_VERSIONS, key = "'" + VERSIONS_KEY + "'", sync = true)
    @Transactional(readOnly = true)
    public List<PublicCardDtos.CardVersion> versions() {
        return List.copyOf(jdbc.query("""
            SELECT id, public_version FROM tournament_cards ORDER BY created_at DESC
            """, (rs, row) -> new PublicCardDtos.CardVersion(
                rs.getObject("id", UUID.class), rs.getLong("public_version"))));
    }

    private long publicVersion(UUID cardId) {
        List<Long> versions = jdbc.queryForList(
            "SELECT public_version FROM tournament_cards WHERE id = ?", Long.class, cardId);
        if (versions.isEmpty())
            throw new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.NOT_FOUND, "Tournament card not found");
        return versions.get(0);
    }
}
