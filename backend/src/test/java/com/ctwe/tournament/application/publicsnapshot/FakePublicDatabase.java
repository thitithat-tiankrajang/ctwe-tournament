package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.web.dto.CardDtos;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/**
 * One set of database rows, served to <b>both</b> public read paths.
 *
 * <p>Phase C asks whether {@code GET /api/public/tournaments/{token}/bundle} and
 * {@link PublicSnapshotBuilder} describe the same tournament. That question is only meaningful if
 * both are answered from the same rows, so this class is the single source those two paths share: it
 * holds the tournaments and cards, and answers each of the five queries the two paths actually issue
 * by evaluating them against that one model.
 *
 * <p><b>What is faked and what is not.</b> Only PostgreSQL is faked. Every production class on both
 * paths — {@code TenantService}, {@code PublicCardReadCache}, {@code PublicCardQueryService},
 * {@code PublicTournamentController}, {@code PublicSnapshotBuilder}, {@code PublicCardProjection} —
 * runs for real, unmodified, above this double. Nothing here reimplements a projection or a bundle
 * assembly.
 *
 * <p><b>The one thing it does reimplement</b> is the SQL itself: the {@code ORDER BY} of the two card
 * queries and the two {@code COUNT} predicates behind {@code cardCount}/{@code publishedCardCount}.
 * They are written out below, next to the statement each mirrors, so the duplication is visible. That
 * makes this test blind to a change in the real SQL text, which is precisely the gap
 * {@code SnapshotLiveEquivalenceDatabaseTest} closes by running the same comparison against a real
 * PostgreSQL.
 *
 * <p>Every mutating {@code JdbcTemplate} method is left unstubbed and is asserted never to be called
 * ({@link #assertNoWrites()}): snapshot generation is a read, and this double would happily accept a
 * write if one were ever introduced.
 */
final class FakePublicDatabase {

    /** A row of {@code tournaments}. {@code status} gates the public link (OPEN/CLOSED). */
    record Tournament(UUID id, String name, String accessToken, String status) {
        static Tournament open(UUID id, String name, String accessToken) {
            return new Tournament(id, name, accessToken, "OPEN");
        }
    }

    /**
     * A row of {@code tournament_cards}, plus the internal card the staff read model would return
     * for it. {@code createdAt} is what both card queries order by; {@code publicVersion} is what
     * viewers cache against.
     */
    record Card(UUID id, UUID tournamentId, long publicVersion, Instant createdAt,
                CardDtos.CardResponse source) {}

    private final List<Tournament> tournaments;
    private final List<Card> cards;
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService cardService = mock(TournamentCardService.class);

    private FakePublicDatabase(List<Tournament> tournaments, List<Card> cards) {
        this.tournaments = List.copyOf(tournaments);
        this.cards = List.copyOf(cards);
    }

    static FakePublicDatabase of(List<Tournament> tournaments, List<Card> cards) {
        FakePublicDatabase database = new FakePublicDatabase(tournaments, cards);
        database.wire();
        return database;
    }

    JdbcTemplate jdbc() {
        return jdbc;
    }

    TournamentCardService cardService() {
        return cardService;
    }

    // ------------------------------------------------------------------ query evaluation

    /**
     * {@code PublicCardReadCache.summaries()} — every card, {@code ORDER BY c.created_at DESC}.
     * Deliberately unscoped: the live catalog is global and the controller narrows it afterwards.
     */
    private List<Card> summaryOrder() {
        return cards.stream()
            .sorted(Comparator.comparing(Card::createdAt).reversed())
            .toList();
    }

    /**
     * {@code PublicSnapshotBuilder.CARDS_OF_TOURNAMENT} — one tournament's cards,
     * {@code ORDER BY created_at DESC, id}. The {@code id} tie-break is the snapshot's addition;
     * with distinct timestamps it produces exactly {@link #summaryOrder()} restricted to the
     * tournament.
     */
    private List<Card> snapshotOrder(UUID tournamentId) {
        return cards.stream()
            .filter(card -> tournamentId.equals(card.tournamentId()))
            .sorted(Comparator.comparing(Card::createdAt).reversed().thenComparing(Card::id))
            .toList();
    }

    /** {@code (SELECT COUNT(*) FROM tournament_cards c WHERE c.tournament_id = t.id)}. */
    private int cardCount(UUID tournamentId) {
        return (int) cards.stream().filter(card -> tournamentId.equals(card.tournamentId())).count();
    }

    /** The same count {@code AND c.status IN ('FINISHED', 'CLOSED')}. */
    private int publishedCardCount(UUID tournamentId) {
        return (int) cards.stream()
            .filter(card -> tournamentId.equals(card.tournamentId()))
            .filter(card -> card.source().status() == CardStatus.FINISHED
                || card.source().status() == CardStatus.CLOSED)
            .count();
    }

    // ------------------------------------------------------------------ wiring

    private void wire() {
        // TenantService.resolveOpenTournament(token) — queryForObject(sql, RowMapper, token)
        doAnswer(invocation -> {
            String accessToken = (String) invocation.getArgument(2);
            Tournament tournament = tournaments.stream()
                .filter(row -> row.accessToken().equals(accessToken) && "OPEN".equals(row.status()))
                .findFirst()
                .orElseThrow(() -> new org.springframework.dao.EmptyResultDataAccessException(1));
            return invocation.<RowMapper<?>>getArgument(1).mapRow(tournamentResultSet(tournament), 0);
        }).when(jdbc).queryForObject(anyString(), any(RowMapper.class), any(Object[].class));

        // PublicCardReadCache.summaries() and .versions() — query(sql, RowMapper), no arguments
        doAnswer(invocation -> {
            RowMapper<?> mapper = invocation.getArgument(1);
            List<Object> rows = new ArrayList<>();
            int index = 0;
            for (Card card : summaryOrder()) rows.add(mapper.mapRow(summaryResultSet(card), index++));
            return rows;
        }).when(jdbc).query(anyString(), any(RowMapper.class));

        // PublicSnapshotBuilder.build(...) — query(sql, RowMapper, tournamentId)
        doAnswer(invocation -> {
            RowMapper<?> mapper = invocation.getArgument(1);
            UUID tournamentId = (UUID) invocation.getArgument(2);
            List<Object> rows = new ArrayList<>();
            int index = 0;
            for (Card card : snapshotOrder(tournamentId)) rows.add(mapper.mapRow(cardRefResultSet(card), index++));
            return rows;
        }).when(jdbc).query(anyString(), any(RowMapper.class), any(Object[].class));

        // PublicSnapshotBuilder.tournamentName(...) — queryForObject(sql, String.class, tournamentId)
        doAnswer(invocation -> {
            UUID tournamentId = (UUID) invocation.getArgument(2);
            return tournaments.stream()
                .filter(row -> row.id().equals(tournamentId))
                .map(Tournament::name)
                .findFirst()
                .orElseThrow(() -> new org.springframework.dao.EmptyResultDataAccessException(1));
        }).when(jdbc).queryForObject(anyString(), any(Class.class), any(Object[].class));

        // PublicCardReadCache.version(cardId) — queryForList(sql, Long.class, cardId)
        doAnswer(invocation -> {
            UUID cardId = (UUID) invocation.getArgument(2);
            return cards.stream()
                .filter(card -> card.id().equals(cardId))
                .map(Card::publicVersion)
                .map(Object.class::cast)
                .toList();
        }).when(jdbc).queryForList(anyString(), any(Class.class), any(Object[].class));

        // TournamentCardService.get(cardId, false) — the internal card both paths project from
        for (Card card : cards)
            org.mockito.Mockito.when(cardService.get(card.id(), false)).thenReturn(card.source());
    }

    /** Snapshot generation is a read. Nothing on either path may write. */
    void assertNoWrites() {
        org.mockito.Mockito.verify(jdbc, org.mockito.Mockito.never()).update(anyString());
        org.mockito.Mockito.verify(jdbc, org.mockito.Mockito.never()).update(anyString(), any(Object[].class));
        org.mockito.Mockito.verify(jdbc, org.mockito.Mockito.never()).batchUpdate(anyString());
        org.mockito.Mockito.verify(jdbc, org.mockito.Mockito.never()).batchUpdate(any(String[].class));
        org.mockito.Mockito.verify(jdbc, org.mockito.Mockito.never()).execute(anyString());
    }

    // ------------------------------------------------------------------ result sets

    /**
     * The columns {@code TenantService.resolveOpenTournament} maps. The two counts are computed from
     * the same card rows the snapshot builder reads, so a disagreement between the bundle's
     * SQL-derived counts and the snapshot's card-derived counts is a real finding, not a fixture.
     */
    private ResultSet tournamentResultSet(Tournament tournament) throws Exception {
        ResultSet rs = mock(ResultSet.class);
        org.mockito.Mockito.when(rs.getObject("id", UUID.class)).thenReturn(tournament.id());
        org.mockito.Mockito.when(rs.getString("name")).thenReturn(tournament.name());
        org.mockito.Mockito.when(rs.getString("access_token")).thenReturn(tournament.accessToken());
        org.mockito.Mockito.when(rs.getInt("card_count")).thenReturn(cardCount(tournament.id()));
        org.mockito.Mockito.when(rs.getInt("published_card_count")).thenReturn(publishedCardCount(tournament.id()));
        return rs;
    }

    /**
     * The columns {@code PublicCardReadCache.summaries()} maps. {@code public_stage} is computed in
     * SQL there; the bundle uses a summary only for its id and its position, never for its stage, so
     * this double passes the stored stage through rather than restating that CASE expression.
     */
    private ResultSet summaryResultSet(Card card) throws Exception {
        CardDtos.CardResponse source = card.source();
        ResultSet rs = mock(ResultSet.class);
        org.mockito.Mockito.when(rs.getObject("id", UUID.class)).thenReturn(card.id());
        org.mockito.Mockito.when(rs.getObject("tournament_id", UUID.class)).thenReturn(card.tournamentId());
        org.mockito.Mockito.when(rs.getString("name")).thenReturn(source.name());
        org.mockito.Mockito.when(rs.getString("division")).thenReturn(source.division());
        org.mockito.Mockito.when(rs.getString("status")).thenReturn(source.status().name());
        org.mockito.Mockito.when(rs.getString("public_stage")).thenReturn(source.runtimeStage().name());
        org.mockito.Mockito.when(rs.getInt("current_game")).thenReturn(source.currentGame());
        org.mockito.Mockito.when(rs.getInt("number_of_games")).thenReturn(source.games().size());
        org.mockito.Mockito.when(rs.getInt("player_count")).thenReturn(source.players().size());
        org.mockito.Mockito.when(rs.getInt("published_game_count")).thenReturn(0);
        org.mockito.Mockito.when(rs.getLong("public_version")).thenReturn(card.publicVersion());
        org.mockito.Mockito.when(rs.getTimestamp("created_at")).thenReturn(Timestamp.from(card.createdAt()));
        return rs;
    }

    /** The two columns {@code PublicSnapshotBuilder} selects. */
    private static ResultSet cardRefResultSet(Card card) throws Exception {
        ResultSet rs = mock(ResultSet.class);
        org.mockito.Mockito.when(rs.getObject("id", UUID.class)).thenReturn(card.id());
        org.mockito.Mockito.when(rs.getLong("public_version")).thenReturn(card.publicVersion());
        return rs;
    }
}
