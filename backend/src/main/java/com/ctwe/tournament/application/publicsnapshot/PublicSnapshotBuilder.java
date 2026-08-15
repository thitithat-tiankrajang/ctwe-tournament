package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.PublicCardProjection;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.web.dto.CardDtos;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Generates a Public Snapshot artifact for one tournament, straight from PostgreSQL.
 *
 * <p><b>Read-only, always.</b> The whole build runs in one {@code readOnly} transaction, so the JDBC
 * connection itself rejects writes — generating a snapshot cannot modify tournament data even if a
 * future change tried to. PostgreSQL remains the source of truth; a snapshot is a derived artifact
 * that can be regenerated from it at any time.
 *
 * <p><b>Never reads the cache.</b> {@code PublicCardReadCache} answers viewer traffic from Caffeine
 * with a TTL. That is right for a live read that will be superseded seconds later, and wrong for an
 * artifact intended to be permanent: a stale cache entry would be frozen forever. This class talks to
 * {@link TournamentCardService} and {@link JdbcTemplate} directly, and {@code REPEATABLE_READ} gives
 * every card in the snapshot the same consistent view of the database.
 *
 * <p><b>One projection.</b> The public view is produced exclusively by
 * {@link PublicCardProjection#of}, the same function the live API uses. There is deliberately no
 * second copy of that logic here — if there were, adding a field to {@code CardDtos.CardResponse}
 * would silently make snapshots disagree with the live API, and a published snapshot is permanent.
 */
@Service
public class PublicSnapshotBuilder {
    /**
     * The tournament's cards, newest first — matching the order the live catalog uses
     * ({@code PublicCardReadCache.summaries()} orders by {@code created_at DESC}).
     *
     * <p>{@code id} is appended as a tie-break, which the live query does not have. Two cards created
     * in the same microsecond would otherwise come back in an order PostgreSQL is free to vary between
     * executions, and a snapshot must be byte-identical every time it is regenerated. With distinct
     * timestamps — every real case — this produces exactly the live ordering.
     */
    private static final String CARDS_OF_TOURNAMENT = """
        SELECT id, public_version
        FROM tournament_cards
        WHERE tournament_id = ?
        ORDER BY created_at DESC, id
        """;

    private final JdbcTemplate jdbc;
    private final TournamentCardService cards;

    public PublicSnapshotBuilder(JdbcTemplate jdbc, TournamentCardService cards) {
        this.jdbc = jdbc;
        this.cards = cards;
    }

    /**
     * Builds the snapshot for {@code tournamentId}.
     *
     * <p>Deliberately keyed by tournament id and not by access token, and deliberately indifferent to
     * {@code tournaments.status}: generation is a read, and an operator must be able to inspect what
     * would be published for a tournament whose public link is currently closed.
     *
     * @throws ResponseStatusException 404 when the tournament does not exist
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PublicSnapshotArtifact build(UUID tournamentId) {
        String name = tournamentName(tournamentId);

        List<CardRef> refs = jdbc.query(CARDS_OF_TOURNAMENT,
            (rs, row) -> new CardRef(rs.getObject("id", UUID.class), rs.getLong("public_version")), tournamentId);

        List<CardDtos.CardResponse> projected = new ArrayList<>(refs.size());
        for (CardRef ref : refs) {
            // The same source-data selection the live API reads, then the same single projection.
            projected.add(PublicCardProjection.of(cards.get(ref.id(), false), ref.publicVersion()));
        }

        // Derived from the cards actually in the snapshot rather than from separate COUNT queries, so
        // the numbers can never disagree with the list they describe. 'Published' matches the live
        // definition in TenantService (status FINISHED or CLOSED), expressed against the enum.
        int publishedCardCount = (int) projected.stream()
            .filter(card -> card.status() == CardStatus.FINISHED || card.status() == CardStatus.CLOSED)
            .count();

        return PublicSnapshotArtifact.of(
            new PublicSnapshotPayload(tournamentId, name, projected.size(), publishedCardCount, List.copyOf(projected)));
    }

    private String tournamentName(UUID tournamentId) {
        try {
            return jdbc.queryForObject("SELECT name FROM tournaments WHERE id = ?", String.class, tournamentId);
        } catch (EmptyResultDataAccessException notFound) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบทัวร์นาเมนต์");
        }
    }

    /** A card's identity plus the version viewers cache against; nothing else is needed up front. */
    private record CardRef(UUID id, long publicVersion) {}
}
