package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PairingSessionService;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.application.WebPushService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.infrastructure.security.LoginThrottle;
import com.ctwe.tournament.infrastructure.security.ReauthenticationService;
import com.ctwe.tournament.infrastructure.security.SecurityConfiguration;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import javax.sql.DataSource;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * Tournament scope on the internal single-card read, {@code GET /api/cards/{cardId}}.
 *
 * <p>The internal ("staff view") card carries the roster, unpublished pairings, seating and the
 * Screening Pool. A back-office ROLE alone must not unlock it: a director or staff member only sees
 * it for tournaments they are assigned to ({@code tournament_members} / {@code
 * staff_tournament_access}); ADMIN keeps platform-wide access.
 *
 * <p>What is REAL here: the production {@link SecurityConfiguration} filter chain, the real
 * {@link CardController}, and the real {@link AuthorizationService} making the decision. What is
 * synthetic: the rows underneath — {@link TenancyJdbc} answers the authorization queries from an
 * in-memory tenancy fixture, and the card services return fixed DTOs. No DataSource, no Flyway, no
 * network. The SQL strings themselves are therefore NOT exercised against Postgres here.
 */
@WebMvcTest(controllers = CardController.class)
@Import({SecurityConfiguration.class, AuthorizationService.class, CardReadScopeTest.Fixture.class})
@TestPropertySource(properties = {
    // Synthetic bootstrap account (same throwaway hash the DB-backed matrix test uses).
    "security.staff.username=ittest",
    "security.staff.password-hash=$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm",
    "app.security.allowed-origins=http://localhost:3000",
})
class CardReadScopeTest {

    static final UUID T_OPEN = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    static final UUID T_CLOSED = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    static final UUID T_OTHER = UUID.fromString("00000000-0000-0000-0000-0000000000a3");

    static final UUID CARD_OPEN = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    static final UUID CARD_CLOSED = UUID.fromString("00000000-0000-0000-0000-0000000000c2");
    static final UUID CARD_OTHER = UUID.fromString("00000000-0000-0000-0000-0000000000c3");
    static final UUID CARD_UNKNOWN = UUID.fromString("00000000-0000-0000-0000-0000000000cf");

    /** Strings that exist ONLY in the internal projection. Their absence is the "no payload" proof. */
    static final String ROSTER_MARKER = "SyntheticRosterName";
    static final String POOL_MARKER = "SyntheticScreeningReason";

    /**
     * Answers exactly the queries {@link AuthorizationService} issues, from a fixed tenancy. Any other
     * SQL fails the test loudly instead of silently returning null.
     */
    static class TenancyJdbc extends JdbcTemplate {
        static final Map<UUID, UUID> CARD_TOURNAMENT = Map.of(
            CARD_OPEN, T_OPEN, CARD_CLOSED, T_CLOSED, CARD_OTHER, T_OTHER);
        static final Map<UUID, String> TOURNAMENT_STATUS = Map.of(
            T_OPEN, "OPEN", T_CLOSED, "CLOSED", T_OTHER, "OPEN");
        static final Map<String, Set<UUID>> MEMBERS = Map.of(
            "dir_assigned", Set.of(T_OPEN, T_CLOSED),
            "dir_elsewhere", Set.of(T_OTHER),
            "dir_unassigned", Set.of());
        static final Map<String, Set<UUID>> STAFF_GRANTS = Map.of(
            "staff_granted", Set.of(T_OPEN),
            "staff_elsewhere", Set.of(T_OTHER),
            "staff_ungranted", Set.of());

        @Override
        @SuppressWarnings("unchecked")
        public <T> T queryForObject(String sql, Class<T> type, Object... args) {
            if (sql.equals("SELECT tournament_id FROM tournament_cards WHERE id = ?")) {
                UUID tournament = CARD_TOURNAMENT.get((UUID) args[0]);
                if (tournament == null) throw new org.springframework.dao.EmptyResultDataAccessException(1);
                return (T) tournament;
            }
            if (sql.equals("SELECT status FROM tournaments WHERE id = ?")) {
                String status = TOURNAMENT_STATUS.get((UUID) args[0]);
                if (status == null) throw new org.springframework.dao.EmptyResultDataAccessException(1);
                return (T) status;
            }
            throw new AssertionError("unexpected queryForObject: " + sql);
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> List<T> queryForList(String sql, Class<T> type, Object... args) {
            if (sql.equals("SELECT tournament_id FROM tournament_members WHERE username = ?"))
                return (List<T>) List.copyOf(MEMBERS.getOrDefault((String) args[0], Set.of()));
            if (sql.equals("SELECT tournament_id FROM staff_tournament_access WHERE username = ?"))
                return (List<T>) List.copyOf(STAFF_GRANTS.getOrDefault((String) args[0], Set.of()));
            throw new AssertionError("unexpected queryForList: " + sql);
        }

        /** No DataSource behind this template — it never opens a connection. */
        @Override
        public void afterPropertiesSet() { }

        /** The bootstrap ApplicationRunner upserts the ADMIN account; nothing to persist here. */
        @Override
        public int update(String sql, Object... args) { return 0; }
    }

    @TestConfiguration
    static class Fixture {
        @Bean JdbcTemplate jdbcTemplate() { return new TenancyJdbc(); }
        @Bean DataSource dataSource() { return mock(DataSource.class); }
    }

    @Autowired MockMvc mvc;

    @MockitoBean TournamentCardService cards;
    @MockitoBean PublicCardQueryService publicCards;
    @MockitoBean ReauthenticationService reauthentication;
    @MockitoBean CardEventPublisher events;
    @MockitoBean WebPushService push;
    @MockitoBean PairingSessionService pairingSession;
    @MockitoBean LoginThrottle loginThrottle;

    @BeforeEach
    void cardContent() {
        for (var entry : TenancyJdbc.CARD_TOURNAMENT.entrySet()) {
            when(cards.get(entry.getKey(), true)).thenReturn(internalCard(entry.getKey(), entry.getValue()));
            when(publicCards.get(entry.getKey())).thenReturn(publicCard(entry.getKey(), entry.getValue()));
        }
        when(cards.get(CARD_UNKNOWN, true)).thenThrow(new org.springframework.web.server.ResponseStatusException(
            org.springframework.http.HttpStatus.NOT_FOUND, "Tournament card not found"));
    }

    // ---- allowed: meaningful internal payload ---------------------------------------------------

    @Test
    void adminReadsInternalViewOfAnyTournament() throws Exception {
        MvcResult result = read(CARD_OTHER, user("platform_admin").roles("ADMIN"));
        assertInternal(result, CARD_OTHER, T_OTHER);
        result = read(CARD_OPEN, user("platform_admin").roles("ADMIN"));
        assertInternal(result, CARD_OPEN, T_OPEN);
    }

    @Test
    void assignedDirectorReadsInternalView() throws Exception {
        assertInternal(read(CARD_OPEN, user("dir_assigned").roles("DIRECTOR")), CARD_OPEN, T_OPEN);
    }

    @Test
    void grantedStaffReadsInternalView() throws Exception {
        assertInternal(read(CARD_OPEN, user("staff_granted").roles("STAFF")), CARD_OPEN, T_OPEN);
    }

    /** Reads are not mutations: a CLOSED tournament stays readable to its own director. */
    @Test
    void assignedDirectorReadsClosedTournamentCard() throws Exception {
        assertInternal(read(CARD_CLOSED, user("dir_assigned").roles("DIRECTOR")), CARD_CLOSED, T_CLOSED);
    }

    /**
     * ADMIN inspection relies on this read: platform-wide, OPEN or CLOSED, with the configuration
     * fields (per-game maxDiff, rules, final, Gibson, slot label) intact in the payload.
     */
    @Test
    void adminReadsClosedTournamentCardWithConfiguration() throws Exception {
        MvcResult result = read(CARD_CLOSED, user("platform_admin").roles("ADMIN"));
        assertInternal(result, CARD_CLOSED, T_CLOSED);
        assertThat(result.getResponse().getContentAsString())
            .contains("\"maxDiff\":250").contains("\"maxDiff\":400")
            .contains("\"initialPairingRule\":\"RANDOM\"")
            .contains("\"fromGame\":1,\"toGame\":2,\"type\":\"SWISS\"")
            .contains("\"finalType\":\"CHAMPION\"").contains("\"finalGames\":3")
            .contains("\"gibsonEnabled\":true").contains("\"slotLabel\":\"SEAT\"");
    }

    // ---- refused: no internal payload, internal service never consulted -------------------------

    @Test
    void crossTournamentDirectorGetsNoInternalPayload() throws Exception {
        assertRefused(read(CARD_OPEN, user("dir_elsewhere").roles("DIRECTOR")));
        verify(cards, never()).get(eq(CARD_OPEN), anyBoolean());
    }

    @Test
    void crossTournamentStaffGetsNoInternalPayload() throws Exception {
        assertRefused(read(CARD_OPEN, user("staff_elsewhere").roles("STAFF")));
        verify(cards, never()).get(eq(CARD_OPEN), anyBoolean());
    }

    @Test
    void directorWithoutAnyMembershipIsRefused() throws Exception {
        assertRefused(read(CARD_OPEN, user("dir_unassigned").roles("DIRECTOR")));
        verify(cards, never()).get(eq(CARD_OPEN), anyBoolean());
    }

    @Test
    void staffWithoutAnyGrantIsRefused() throws Exception {
        assertRefused(read(CARD_CLOSED, user("staff_ungranted").roles("STAFF")));
        verify(cards, never()).get(eq(CARD_CLOSED), anyBoolean());
    }

    /** Refusal must not quietly degrade to the public projection either: it is an explicit 403. */
    @Test
    void refusalDoesNotFallBackToAnyProjection() throws Exception {
        assertRefused(read(CARD_OTHER, user("dir_assigned").roles("DIRECTOR")));
        verify(publicCards, never()).get(any());
        verify(cards, never()).get(eq(CARD_OTHER), anyBoolean());
    }

    // ---- not found ------------------------------------------------------------------------------

    @Test
    void unknownCardIsNotFoundForBackOffice() throws Exception {
        assertThat(read(CARD_UNKNOWN, user("dir_assigned").roles("DIRECTOR")).getResponse().getStatus()).isEqualTo(404);
        assertThat(read(CARD_UNKNOWN, user("platform_admin").roles("ADMIN")).getResponse().getStatus()).isEqualTo(404);
    }

    // ---- anonymous: public projection, unchanged ------------------------------------------------

    @Test
    void anonymousGetsPublicProjectionOnly() throws Exception {
        MvcResult result = mvc.perform(get("/api/cards/" + CARD_OPEN)).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        String body = result.getResponse().getContentAsString();
        assertThat(body).contains("\"id\":\"" + CARD_OPEN + "\"").contains("PublicOnlyName");
        assertThat(body).doesNotContain(ROSTER_MARKER).doesNotContain(POOL_MARKER);
        verify(cards, never()).get(any(), anyBoolean());
    }

    // ---- neighbouring routes keep their existing scope checks -----------------------------------

    @Test
    void crossTournamentStaffStreamIsRefused() throws Exception {
        int status = mvc.perform(get("/api/cards/" + CARD_OPEN + "/events")
            .with(user("dir_elsewhere").roles("DIRECTOR"))).andReturn().getResponse().getStatus();
        assertThat(status).isEqualTo(403);
        verify(events, never()).subscribe(any(), any());
    }

    @Test
    void crossTournamentMutationIsRefused() throws Exception {
        int status = mvc.perform(post("/api/cards/" + CARD_OPEN + "/close").with(csrf())
            .with(user("dir_elsewhere").roles("DIRECTOR"))).andReturn().getResponse().getStatus();
        assertThat(status).isEqualTo(403);
        verify(cards, never()).close(any(), any());
    }

    @Test
    void backOfficeListStaysRestrictedToAssignedTournaments() throws Exception {
        when(cards.list(eq(true), any())).thenReturn(List.of());
        mvc.perform(get("/api/cards").with(user("dir_assigned").roles("DIRECTOR"))).andReturn();
        verify(cards).list(true, Set.of(T_OPEN, T_CLOSED));
    }

    // ---- helpers --------------------------------------------------------------------------------

    private MvcResult read(UUID cardId, RequestPostProcessor principal) throws Exception {
        return mvc.perform(get("/api/cards/" + cardId).with(principal)).andReturn();
    }

    private static void assertInternal(MvcResult result, UUID cardId, UUID tournamentId) throws Exception {
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        String body = result.getResponse().getContentAsString();
        assertThat(body)
            .contains("\"id\":\"" + cardId + "\"")
            .contains("\"tournamentId\":\"" + tournamentId + "\"")
            .contains(ROSTER_MARKER)
            .contains(POOL_MARKER);
        // Authenticated/internal responses must never be stored by a shared cache.
        assertThat(result.getResponse().getHeader("Cache-Control")).contains("no-store");
    }

    private static void assertRefused(MvcResult result) throws Exception {
        assertThat(result.getResponse().getStatus()).isEqualTo(403);
        String body = result.getResponse().getContentAsString();
        assertThat(body).doesNotContain(ROSTER_MARKER).doesNotContain(POOL_MARKER).doesNotContain("\"players\"");
    }

    private static CardDtos.CardResponse internalCard(UUID id, UUID tournamentId) {
        var player = new CardDtos.PlayerResponse("A001", ROSTER_MARKER, "Last", "School", "DIV",
            0, 0, 0, 0, 0, false);
        var hold = new CardDtos.ScreeningHold("A001", "2026-01-01T00:00:00Z", "dir_assigned", POOL_MARKER,
            null, 1, 1, 1, null, false);
        return new CardDtos.CardResponse(
            id, tournamentId, "InternalName", "DIV", CardStatus.RUNNING,
            RuntimeStage.PLAYER_REGISTRATION, 1, 3,
            List.of(new CardDtos.GameResponse("1", 1, "เกม 1", "COMPLETED", 250),
                    new CardDtos.GameResponse("2", 2, "เกม 2", "OPEN", 400)),
            PairingRuleType.RANDOM,
            List.of(new CardDtos.RuleResponse(1, 2, PairingRuleType.SWISS)), List.of(player), List.of(), List.of(), List.of(),
            "CHAMPION", 3, null, true, Instant.EPOCH, "A", "SEAT", List.of(hold));
    }

    private static CardDtos.CardResponse publicCard(UUID id, UUID tournamentId) {
        return new CardDtos.CardResponse(
            id, tournamentId, "PublicOnlyName", "DIV", CardStatus.RUNNING,
            RuntimeStage.PLAYER_REGISTRATION, 1, 3,
            List.of(), PairingRuleType.RANDOM,
            List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH, "A", "PAIR", List.of());
    }
}
