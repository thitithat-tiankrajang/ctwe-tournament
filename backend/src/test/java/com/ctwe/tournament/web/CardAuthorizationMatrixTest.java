package com.ctwe.tournament.web;

import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import com.ctwe.tournament.application.WebPushService;

/**
 * The staff/director boundary, asserted at the HTTP layer rather than by which buttons render.
 *
 * <p>Staff record results. The DIRECTOR owns the competition lifecycle: pairing, switching,
 * screening, termination, review, publication, historical override and the final's start and
 * publication. A staff session that calls those endpoints directly must be refused.
 *
 * <p>The fixture matters as much as the assertions. The card is REAL and the staff principal is
 * genuinely granted access to its tournament, so a 403 here can only come from the role rule in
 * {@code AuthorizationService} — not from "card not found" and not from "not your tournament",
 * either of which would make the whole matrix pass for the wrong reason.
 *
 * <p>Allowed routes are asserted as "not 403": the stage guards downstream legitimately answer 4xx.
 * What is proven is that authorization did not stop it.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class CardAuthorizationMatrixTest {

    /** Test-scoped: Web Push must not create/store VAPID keys, run its scheduled cleanup, or send. */
    @MockitoBean WebPushService webPush;

    /**
     * A real password for the seeded principals. Password-bearing endpoints re-authenticate AFTER
     * the authorization check, so without a correct password the director's "may reach it" probes
     * would all answer 403 for the wrong reason and hide whatever authorization actually did.
     */
    private static final String PASSWORD = "matrix-password-1";
    private static final String PASSWORD_HASH = "{bcrypt}$2y$12$Uk9bpX1P1GaASlpp1vCAlOOQ5wp3knfOCjoTQFpqQGWA6PIsbVD1W";
    private static final String STAFF = "matrix_staff";
    private static final String DIRECTOR = "matrix_director";
    private static final String MATCH = "g1t1";

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired com.ctwe.tournament.application.TournamentCardService cards;

    private UUID cardId;
    private UUID tournamentId;

    /** A synthetic tournament inside the rolled-back test transaction: no reliance on existing data. */
    private UUID syntheticTournament() {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            id, "IT " + id, "it-" + id);
        return id;
    }

    @BeforeEach
    void seedTenancy() {
        tournamentId = syntheticTournament();
        cardId = cards.create(new CardDtos.CreateCardRequest(tournamentId, "AUTHZ-" + UUID.randomUUID(),
            "DIV", 2, List.of(PairingRuleType.SWISS), List.of(250, 250), "NONE", 0, false,
            PairingRuleType.RANDOM, null), "ittest").id();

        for (String user : List.of(STAFF, DIRECTOR)) {
            jdbc.update("""
                INSERT INTO staff_accounts (username, password_hash, enabled) VALUES (?, ?, true)
                ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = true
                """, user, PASSWORD_HASH);
        }
        jdbc.update("INSERT INTO staff_tournament_access (username, tournament_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            STAFF, tournamentId);
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?) ON CONFLICT DO NOTHING",
            tournamentId, DIRECTOR);
    }

    /** A request plus the label the failure message needs — a builder's toString says nothing. */
    private record Probe(String label, MockHttpServletRequestBuilder request) {}

    private MockHttpServletRequestBuilder json(MockHttpServletRequestBuilder builder, String body) {
        return builder.contentType(MediaType.APPLICATION_JSON).content(body);
    }

    private int status(Probe probe) throws Exception {
        return mvc.perform(probe.request().with(csrf())).andReturn().getResponse().getStatus();
    }

    private List<Probe> labelled() {
        List<MockHttpServletRequestBuilder> requests = lifecycleMutations();
        List<Probe> probes = new ArrayList<>(requests.size());
        for (int index = 0; index < requests.size(); index++) {
            var built = requests.get(index).buildRequest(new org.springframework.mock.web.MockServletContext());
            probes.add(new Probe(built.getMethod() + " " + built.getRequestURI(), requests.get(index)));
        }
        return probes;
    }

    /**
     * Every lifecycle mutation the owner reserved for the director.
     *
     * <p>Each body is deliberately VALID. Bean validation runs before the handler, so a {@code "{}"}
     * body on a password-bearing endpoint answers 400 and the authorization rule is never consulted —
     * a matrix built that way would prove nothing about who may call what.
     */
    private List<MockHttpServletRequestBuilder> lifecycleMutations() {
        String card = "/api/cards/" + cardId;
        String pw = "{\"password\":\"" + PASSWORD + "\"}";
        String version = "\"" + cards.cardVersion(cardId) + "\"";
        String commit = "{\"commitKey\":\"" + UUID.randomUUID() + "\",\"password\":\"" + PASSWORD + "\",\"force\":false,"
            + "\"expect\":[],\"slots\":[],\"screen\":[],\"release\":[],\"confirmWarnings\":[]}";
        List<MockHttpServletRequestBuilder> requests = new ArrayList<>(List.of(
            json(post(card + "/players"), "{\"firstName\":\"a\",\"lastName\":\"b\",\"school\":\"c\"}"),
            json(post(card + "/players/bulk"), "{\"players\":[{\"firstName\":\"a\",\"lastName\":\"b\",\"school\":\"c\"}]}"),
            json(put(card + "/players/A001").header("If-Match", version), "{\"firstName\":\"a\",\"lastName\":\"b\",\"school\":\"c\"}"),
            delete(card + "/players/A001").header("If-Match", version),
            post(card + "/registration/finish"),
            post(card + "/registration/reopen"),
            post(card + "/pairings/preview"),
            post(card + "/pairings/confirm"),
            post(card + "/pairings/publish-next"),
            json(post(card + "/pairings/unpair"), pw),
            json(post(card + "/pairings/undo"), pw),
            json(post(card + "/pairing/commit"), commit),
            json(post(card + "/pairing/validate"), commit),
            json(post(card + "/pairing/session"), pw),
            get(card + "/pairing/pool"),
            json(post(card + "/tables/swap"),
                "{\"firstPlayerId\":\"A001\",\"secondPlayerId\":\"A002\",\"password\":\"" + PASSWORD + "\",\"confirmSchoolConflict\":false}")));
        requests.addAll(List.of(
            json(post(card + "/players/terminate"), "{\"playerIds\":[\"A001\"],\"password\":\"" + PASSWORD + "\"}"),
            json(post(card + "/players/restore"), "{\"playerIds\":[\"A001\"],\"password\":\"" + PASSWORD + "\",\"lossPoints\":100,\"unpair\":false}"),
            post(card + "/results/review"),
            post(card + "/results/reopen"),
            post(card + "/results/publish"),
            json(put(card + "/matches/" + MATCH + "/override"), "{\"scoreOne\":120,\"scoreTwo\":90,\"editExisting\":true}"),
            json(post(card + "/matches/" + MATCH + "/penalty"), "{\"points\":50,\"password\":\"" + PASSWORD + "\"}"),
            json(post(card + "/matches/" + MATCH + "/penalty/revoke"), pw),
            post(card + "/final/start"),
            post(card + "/final/publish"),
            post(card + "/close"),
            delete(card),
            get(card + "/audit")));
        return requests;
    }

    @Test
    @WithMockUser(username = STAFF, roles = "STAFF")
    void staffIsRefusedEveryLifecycleMutation() throws Exception {
        for (Probe probe : labelled())
            assertThat(status(probe)).as("staff must not reach %s", probe.label()).isEqualTo(403);
    }

    @Test
    @WithMockUser(username = STAFF, roles = "STAFF")
    void staffMayStillReadAndRecordAResult() throws Exception {
        assertThat(mvc.perform(get("/api/cards/" + cardId)).andReturn().getResponse().getStatus())
            .as("staff read stays open").isNotEqualTo(403);

        int status = mvc.perform(put("/api/cards/" + cardId + "/matches/" + MATCH + "/result")
            .with(csrf()).contentType(MediaType.APPLICATION_JSON)
            .content("{\"scoreOne\":120,\"scoreTwo\":90,\"editExisting\":false}"))
            .andReturn().getResponse().getStatus();
        assertThat(status).as("result entry is the staff mutation").isNotEqualTo(403);
    }

    @Test
    @WithMockUser(username = DIRECTOR, roles = "DIRECTOR")
    void directorReachesEveryLifecycleMutation() throws Exception {
        for (Probe probe : labelled())
            assertThat(status(probe)).as("director must reach %s", probe.label()).isNotEqualTo(403);
        assertThat(mvc.perform(put("/api/cards/" + cardId + "/matches/" + MATCH + "/result")
            .with(csrf()).contentType(MediaType.APPLICATION_JSON)
            .content("{\"scoreOne\":120,\"scoreTwo\":90,\"editExisting\":false}"))
            .andReturn().getResponse().getStatus()).isNotEqualTo(403);
    }

    /**
     * Owner-confirmed final-round boundary. Recording a final slot IS result entry, so staff reach
     * every field of it — the game scores and the slot summary (winner, wins, losses, totalDiff).
     * What staff may not do is move the tournament: starting the final and publishing it are the
     * director's, and both appear in {@link #lifecycleMutations()} as refusals.
     */
    @Test
    @WithMockUser(username = STAFF, roles = "STAFF")
    void staffRecordsTheFinalResultButNeverStartsOrPublishesIt() throws Exception {
        String card = "/api/cards/" + cardId;
        assertThat(mvc.perform(json(put(card + "/final/0/games/1"), "{\"scoreOne\":465,\"scoreTwo\":441}")
            .with(csrf())).andReturn().getResponse().getStatus())
            .as("entering a final game's scores is result entry").isNotEqualTo(403);
        assertThat(mvc.perform(json(put(card + "/final/0/winner"),
            "{\"winnerId\":\"A001\",\"winnerWins\":1,\"winnerLosses\":0,\"totalDiff\":24}")
            .with(csrf())).andReturn().getResponse().getStatus())
            .as("the slot summary is part of the same result entry").isNotEqualTo(403);

        assertThat(mvc.perform(post(card + "/final/start").with(csrf()))
            .andReturn().getResponse().getStatus()).as("starting the final is the director's").isEqualTo(403);
        assertThat(mvc.perform(post(card + "/final/publish").with(csrf()))
            .andReturn().getResponse().getStatus()).as("publishing the final is the director's").isEqualTo(403);
    }

    /**
     * Tenancy, not just role: a director of a DIFFERENT tournament is a stranger to this card, and
     * the same matrix must refuse them too. Without this, "director" would look like a global role.
     */
    @Test
    @WithMockUser(username = "matrix_outsider", roles = "DIRECTOR")
    void aDirectorOfAnotherTournamentIsRefusedTheSameMatrix() throws Exception {
        for (Probe probe : labelled())
            assertThat(status(probe)).as("an unassigned director must not reach %s", probe.label()).isEqualTo(403);
    }
}
