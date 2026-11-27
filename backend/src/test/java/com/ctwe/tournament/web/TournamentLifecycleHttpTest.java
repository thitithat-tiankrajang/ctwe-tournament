package com.ctwe.tournament.web;

import com.ctwe.tournament.application.WebPushService;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cache.CacheManager;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
    "security.staff.username=flow-test-bootstrap",
    "security.staff.password-hash=$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm"
})
@AutoConfigureMockMvc
@Transactional
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class TournamentLifecycleHttpTest {
    private static final String PASSWORD = "synthetic-flow-test";
    private static final RequestPostProcessor ADMIN = user("flow-test-bootstrap").roles("ADMIN");
    private static final Map<String, Integer> TIE = Map.of("scoreOne", 400, "scoreTwo", 400);

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired CacheManager caches;
    @MockitoBean WebPushService webPush;

    @Test
    void createsTournamentAndCardWithSeparatePlatformAndEventRoles() throws Exception {
        Fixture event = tournament();
        JsonNode publicEvent = body(mvc.perform(get("/api/public/tournaments/" + event.slug())), 200);
        assertThat(publicEvent.path("id").asText()).isEqualTo(event.id());
        assertThat(publicEvent.path("cardCount").asInt()).isZero();

        body(mvc.perform(post("/api/admin/tournaments").with(event.director()).with(csrf())
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(Map.of("name", "Denied event", "slug", "denied-" + event.slug())))), 403);
        body(mvc.perform(post("/api/cards").with(event.director()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(cardInput(event)))), 403);
        send(post("/api/cards"), event.staff(), cardInput(event), 403);
        send(post("/api/cards"), user("unassigned-director").roles("DIRECTOR"), cardInput(event), 403);

        JsonNode card = makeCard(event);
        assertThat(card.path("runtimeStage").asText()).isEqualTo("PLAYER_REGISTRATION");
        assertThat(card.path("tournamentId").asText()).isEqualTo(event.id());
        assertThat(card.path("games").size()).isEqualTo(2);
        assertThat(card.path("rules").get(0).path("type").asText()).isEqualTo("SWISS");
        assertThat(body(mvc.perform(get(cardPath(card)).with(event.staff())), 200).path("id")).isEqualTo(card.path("id"));

        send(delete("/api/director/staff/" + event.staffName() + "/tournaments/" + event.id()),
            event.director(), null, 200);
        body(mvc.perform(get(cardPath(card)).with(event.staff())), 403);
    }

    @Test
    void rejectsInvalidCreationWithoutAddingACardThenAcceptsValidConfiguration() throws Exception {
        Fixture event = tournament();
        var input = new HashMap<>(cardInput(event));
        input.put("rules", List.of("PAIR_RESULT", "PAIR_RESULT"));
        input.put("numberOfGames", 3);
        input.put("gameMaxDiffs", List.of(250, 250, 250));
        send(post("/api/cards"), event.director(), input, 400);
        assertThat(body(mvc.perform(get("/api/public/tournaments/" + event.slug())), 200)
            .path("cardCount").asInt()).isZero();

        input.put("rules", List.of("RANDOM", "KING_OF_THE_HILL"));
        input.put("initialPairingRule", "SWISS");
        input.put("finalType", "CHAMPION_AND_THIRD");
        input.put("finalGames", 1);
        input.put("slotLabel", "SEAT");
        JsonNode card = send(post("/api/cards"), event.director(), input, 201);
        assertThat(card.path("initialPairingRule").asText()).isEqualTo("SWISS");
        assertThat(card.path("finalType").asText()).isEqualTo("CHAMPION_AND_THIRD");
        assertThat(card.path("slotLabel").asText()).isEqualTo("SEAT");
        assertThat(card.path("games").size()).isEqualTo(3);
    }

    @Test
    void insufficientFinalistsKeepRegistrationOpenUntilTheConfiguredTournamentCanFinish() throws Exception {
        Fixture event = tournament();
        var input = new HashMap<>(cardInput(event));
        input.put("finalType", "CHAMPION_AND_THIRD");
        input.put("finalGames", 1);
        String url = cardPath(send(post("/api/cards"), event.director(), input, 201));
        JsonNode roster = send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("กอ"), player("ขอ"), player("คอ"))), 201);

        JsonNode refusal = send(post(url + "/registration/finish"), event.director(), null, 400);
        assertThat(refusal.path("error").asText()).contains("4 คน");
        JsonNode afterRefusal = body(mvc.perform(get(url).with(event.director())), 200);
        assertThat(afterRefusal.path("runtimeStage").asText()).isEqualTo("PLAYER_REGISTRATION");
        assertThat(afterRefusal.path("version")).isEqualTo(roster.path("version"));
        assertThat(afterRefusal.path("players")).isEqualTo(roster.path("players"));

        JsonNode readyRoster = send(post(url + "/players"), event.director(), player("งอ"), 201);
        String finalist = readyRoster.path("players").get(3).path("id").asText();
        send(post(url + "/registration/finish"), event.director(), null, 200);
        for (int game = 1; game <= 2; game++) {
            JsonNode published = publishRegularGame(event, url, game);
            send(post(url + "/results/publish"), event.director(), null, 400);
            JsonNode afterRetry = body(mvc.perform(get(url).with(event.director())), 200);
            assertThat(afterRetry.path("version")).isEqualTo(published.path("version"));
            assertThat(afterRetry.path("snapshots")).isEqualTo(published.path("snapshots"));
        }

        send(post(url + "/players/terminate"), event.director(),
            Map.of("playerIds", List.of(finalist), "password", PASSWORD), 200);
        JsonNode unavailable = send(post(url + "/final/start"), event.director(), null, 400);
        assertThat(unavailable.path("error").asText()).contains("ต้องการ 4 คน มี 3 คน");
        send(post(url + "/players/restore"), event.director(),
            Map.of("playerIds", List.of(finalist), "password", PASSWORD, "lossPoints", 0, "unpair", false), 200);
        JsonNode slots = send(post(url + "/final/start"), event.director(), null, 200).path("finalRound").path("slots");
        assertThat(slots.size()).isEqualTo(2);
        for (JsonNode slot : slots) {
            String finalUrl = url + "/final/" + slot.path("slot").asInt();
            send(put(finalUrl + "/games/1"), event.staff(), Map.of("scoreOne", 500, "scoreTwo", 400), 200);
            send(put(finalUrl + "/winner"), event.staff(), Map.of(
                "winnerId", slot.path("playerOneId").asText(), "winnerWins", 1, "winnerLosses", 0, "totalDiff", 100), 200);
        }
        JsonNode finished = send(post(url + "/final/publish"), event.director(), null, 200);
        assertThat(finished.path("runtimeStage").asText()).isEqualTo("FINAL_PUBLISHED");
        assertThat(finished.path("status").asText()).isEqualTo("FINISHED");
    }

    @Test
    void directorCanFinishOnRegularRankingsWhenAnEligibleFinalistWithdraws() throws Exception {
        Fixture event = tournament();
        var input = new HashMap<>(cardInput(event));
        input.put("finalType", "CHAMPION_AND_THIRD");
        input.put("finalGames", 1);
        String url = cardPath(send(post("/api/cards"), event.director(), input, 201));
        JsonNode roster = send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("กอ"), player("ขอ"), player("คอ"), player("งอ"))), 201);
        String withdrawn = roster.path("players").get(3).path("id").asText();
        send(post(url + "/registration/finish"), event.director(), null, 200);
        publishRegularGame(event, url, 1);
        JsonNode seeding = publishRegularGame(event, url, 2);
        String fallback = url + "/final/finish-with-regular-results";
        send(post(fallback), event.director(), null, 400);
        JsonNode underfilled = send(post(url + "/players/terminate"), event.director(),
            Map.of("playerIds", List.of(withdrawn), "password", PASSWORD), 200);
        assertThat(underfilled.path("finalRound").path("seedPlayerIds").size()).isEqualTo(3);
        assertThat(underfilled.path("finalRound").path("seedPlayerIds").toString()).doesNotContain(withdrawn);

        send(post(fallback), event.staff(), null, 403);
        send(post(fallback), ADMIN, null, 403);
        JsonNode finished = send(post(fallback), event.director(), null, 200);
        assertThat(finished.path("runtimeStage").asText()).isEqualTo("FINAL_PUBLISHED");
        assertThat(finished.path("status").asText()).isEqualTo("FINISHED");
        assertThat(finished.path("finalType").asText()).isEqualTo("NONE");
        assertThat(finished.path("snapshots")).isEqualTo(seeding.path("snapshots"));
        send(post(fallback), event.director(), null, 400);
        JsonNode afterRetry = body(mvc.perform(get(url).with(event.director())), 200);
        assertThat(afterRetry.path("version")).isEqualTo(finished.path("version"));
        JsonNode audit = body(mvc.perform(get(url + "/audit").with(event.director())), 200);
        assertThat(audit).anySatisfy(entry -> {
            assertThat(entry.path("action").asText()).isEqualTo("FINISH_WITH_REGULAR_RESULTS");
            assertThat(entry.path("oldValue").asText()).contains("CHAMPION_AND_THIRD");
        });
    }

    @Test
    void removesAndAddsPlayersThenSwapsAcrossTablesWithoutChangingTheRoster() throws Exception {
        Fixture event = tournament();
        JsonNode card = makeCard(event);
        String url = cardPath(card);
        JsonNode roster = send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("หนึ่ง"), player("สอง"), player("สาม"), player("สี่"),
                player("ห้า"), player("หก"), player("เจ็ด"), player("แปด"))), 201);
        String removedId = roster.path("players").get(1).path("id").asText();
        JsonNode removed = send(delete(url + "/players/" + removedId).header("If-Match", versionTag(roster)),
            event.director(), null, 200);
        assertThat(names(removed)).containsExactly("หนึ่ง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด");
        assertThat(removed.path("players").get(1).path("id").asText()).isEqualTo(removedId);
        JsonNode added = send(post(url + "/players"), event.director(), player("เก้า"), 201);
        assertThat(names(added)).containsExactly("หนึ่ง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า");
        String currentId = added.path("players").get(0).path("id").asText();

        send(post(url + "/registration/finish"), event.director(), null, 200);
        send(delete(url + "/players/" + currentId).header("If-Match", versionTag(added)), event.director(), null, 400);
        JsonNode preview = send(post(url + "/pairings/preview"), event.director(), null, 200);
        assertThat(preview.path("runtimeStage").asText()).isEqualTo("PAIRING_PREVIEW");
        var pairings = preview.path("snapshots").get(0).path("pairings");
        assertThat(pairings.size()).isEqualTo(4);
        var first = pairings.get(0).path("playerOneId");
        var second = pairings.get(2).path("playerOneId");
        Map<String, Object> swap = Map.of("firstPlayerId", first.asText(), "secondPlayerId", second.asText(),
            "password", PASSWORD, "confirmSchoolConflict", true);

        send(post(url + "/tables/swap"), event.staff(), swap, 403);
        JsonNode afterDenied = body(mvc.perform(get(url).with(event.director())), 200);
        assertThat(afterDenied.path("snapshots").get(0).path("pairings")).isEqualTo(pairings);
        assertThat(afterDenied.path("version")).isEqualTo(preview.path("version"));
        JsonNode swapped = send(post(url + "/tables/swap"), event.director(), swap, 200);
        var swappedPairings = swapped.path("snapshots").get(0).path("pairings");
        assertThat(swappedPairings.get(0).path("playerOneId")).isEqualTo(second);
        assertThat(swappedPairings.get(2).path("playerOneId")).isEqualTo(first);
        assertThat(names(swapped)).containsExactlyElementsOf(names(added));
    }

    @Test
    void staleRosterActionsCannotDeleteOrEditAPlayerWhoseCodeWasReused() throws Exception {
        Fixture event = tournament();
        String url = cardPath(makeCard(event));
        JsonNode roster = send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("หนึ่ง"), player("สอง"), player("สาม"))), 201);
        String first = roster.path("players").get(0).path("id").asText();
        String stale = roster.path("players").get(1).path("id").asText();
        JsonNode current = send(delete(url + "/players/" + first).header("If-Match", versionTag(roster)),
            event.director(), null, 200);
        assertThat(current.path("players").get(1).path("id").asText()).isEqualTo(stale);

        String staleTarget = url + "/players/" + stale;
        send(delete(staleTarget).header("If-Match", versionTag(roster)), event.director(), null, 409);
        send(put(staleTarget).header("If-Match", versionTag(roster)), event.director(), player("แก้ไข"), 409);
        send(delete(staleTarget), event.director(), null, 428);
        send(put(staleTarget).header("If-Match", "*"), event.director(), player("แก้ไข"), 400);
        JsonNode unchanged = body(mvc.perform(get(url).with(event.director())), 200);
        assertThat(unchanged.path("version")).isEqualTo(current.path("version"));
        assertThat(unchanged.path("players")).isEqualTo(current.path("players"));

        JsonNode corrected = send(put(staleTarget).header("If-Match", versionTag(unchanged)),
            event.director(), player("แก้ไข"), 200);
        assertThat(names(corrected)).containsExactly("สอง", "แก้ไข");
    }

    @Test
    void withdrawsAndRestoresAPlayerThenPublishesTheFinalWithoutLosingScores() throws Exception {
        Fixture event = tournament();
        var input = new HashMap<>(cardInput(event));
        input.put("finalType", "CHAMPION");
        input.put("finalGames", 1);
        String url = cardPath(send(post("/api/cards"), event.director(), input, 201));
        JsonNode roster = send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("กอ"), player("ขอ"), player("คอ"), player("งอ"))), 201);
        String id = roster.path("players").get(0).path("id").asText();
        Map<String, Object> terminate = Map.of("playerIds", List.of(id), "password", PASSWORD);
        send(post(url + "/registration/finish"), event.director(), null, 200);
        send(post(url + "/pairings/preview"), event.director(), null, 200);
        JsonNode paired = send(post(url + "/pairings/confirm"), event.director(), null, 200);
        assertThat(paired.path("runtimeStage").asText()).isEqualTo("RESULT_COLLECTION");

        send(post(url + "/players/terminate"), event.director(), terminate, 400);
        assertThat(body(mvc.perform(get(url).with(event.director())), 200).path("version")).isEqualTo(paired.path("version"));
        send(put(url + "/matches/g1t1/result"), event.staff(), TIE, 200);
        send(put(url + "/matches/g1t2/result"), event.staff(), TIE, 200);
        send(post(url + "/results/review"), event.director(), null, 200);
        JsonNode published = send(post(url + "/results/publish"), event.director(), null, 200);
        assertThat(published.path("currentGame").asInt()).isEqualTo(2);
        assertThat(published.path("runtimeStage").asText()).isEqualTo("TABLE_PAIRING");

        JsonNode withdrawn = send(post(url + "/players/terminate"), event.director(), terminate, 200);
        assertThat(withdrawn.path("players").get(0).path("terminated").asBoolean()).isTrue();
        send(post(url + "/pairings/preview"), event.director(), null, 200);
        JsonNode restored = send(post(url + "/players/restore"), event.director(),
            Map.of("playerIds", List.of(id), "password", PASSWORD, "lossPoints", 100, "unpair", true), 200);
        assertThat(restored.path("players").get(0).path("terminated").asBoolean()).isFalse();
        assertThat(restored.path("runtimeStage").asText()).isEqualTo("TABLE_PAIRING");
        assertThat(restored.path("snapshots").get(0)).isEqualTo(published.path("snapshots").get(0));

        send(post(url + "/pairings/preview"), event.director(), null, 200);
        send(post(url + "/pairings/confirm"), event.director(), null, 200);
        send(put(url + "/matches/g2t1/result"), event.staff(), TIE, 200);
        send(put(url + "/matches/g2t2/result"), event.staff(), TIE, 200);
        send(post(url + "/results/review"), event.director(), null, 200);
        JsonNode seeding = send(post(url + "/results/publish"), event.director(), null, 200);
        assertThat(seeding.path("runtimeStage").asText()).isEqualTo("FINAL_SEEDING");
        JsonNode finals = send(post(url + "/final/start"), event.director(), null, 200);
        JsonNode slot = finals.path("finalRound").path("slots").get(0);
        String results = url + "/final/" + slot.path("slot").asInt();
        int game = slot.path("games").get(0).path("gameIndex").asInt();
        String winner = slot.path("playerOneId").asText();
        send(put(results + "/games/" + game), event.staff(), Map.of("scoreOne", 500, "scoreTwo", 400), 200);
        send(put(results + "/winner"), event.staff(),
            Map.of("winnerId", winner, "winnerWins", 1, "winnerLosses", 0, "totalDiff", 100), 200);
        send(post(url + "/final/publish"), event.staff(), null, 403);
        JsonNode finished = send(post(url + "/final/publish"), event.director(), null, 200);
        assertThat(finished.path("runtimeStage").asText()).isEqualTo("FINAL_PUBLISHED");
        assertThat(finished.path("snapshots").get(0)).isEqualTo(published.path("snapshots").get(0));
        assertThat(finished.path("finalRound").path("slots").get(0).path("winnerId").asText())
            .isEqualTo(winner);
    }

    @Test
    void correctsPublishedScoresBeforeFinalAndLocksOnlyTheReviewedSeeds() throws Exception {
        Fixture event = tournament();
        var input = new HashMap<>(cardInput(event));
        input.put("finalType", "CHAMPION");
        input.put("finalGames", 1);
        String url = cardPath(send(post("/api/cards"), event.director(), input, 201));
        send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("กอ"), player("ขอ"), player("คอ"), player("งอ"))), 201);
        send(post(url + "/registration/finish"), event.director(), null, 200);
        publishRegularGame(event, url, 1);
        send(post(url + "/pairings/preview"), event.director(), null, 200);
        send(post(url + "/pairings/confirm"), event.director(), null, 200);
        send(put(url + "/matches/g2t1/result"), event.staff(), Map.of("scoreOne", 600, "scoreTwo", 400), 200);
        send(put(url + "/matches/g2t2/result"), event.staff(), Map.of("scoreOne", 500, "scoreTwo", 400), 200);
        send(post(url + "/results/review"), event.director(), null, 200);
        JsonNode seeding = send(post(url + "/results/publish"), event.director(), null, 200);
        JsonNode lastGame = seeding.path("snapshots").get(1).path("pairings").get(0);
        assertThat(lastGame.path("id").asText()).isEqualTo("g2t1");
        assertThat(seeding.path("finalRound").path("seedPlayerIds").get(0)).isEqualTo(lastGame.path("playerOneId"));

        String edit = url + "/matches/g2t1/override";
        var newScore = Map.of("scoreOne", 400, "scoreTwo", 600, "editExisting", true);
        send(put(edit), event.staff(), newScore, 403);
        JsonNode corrected = send(put(edit), event.director(), newScore, 200);
        assertThat(corrected.path("runtimeStage").asText()).isEqualTo("FINAL_SEEDING");
        assertThat(corrected.path("finalRound").path("seedPlayerIds").get(0)).isEqualTo(lastGame.path("playerTwoId"));
        assertThat(corrected.path("snapshots").get(0)).isEqualTo(seeding.path("snapshots").get(0));
        var updatedMatch = corrected.path("snapshots").get(1).path("pairings").get(0);
        assertThat(updatedMatch.path("playerOneId")).isEqualTo(lastGame.path("playerOneId"));
        assertThat(updatedMatch.path("playerTwoId")).isEqualTo(lastGame.path("playerTwoId"));

        String start = url + "/final/start";
        send(post(start).header("If-Match", versionTag(seeding)), event.director(), null, 409);
        JsonNode finals = send(post(start).header("If-Match", versionTag(corrected)), event.director(), null, 200);
        assertThat(finals.path("runtimeStage").asText()).isEqualTo("FINAL_COLLECTION");
        var slot = finals.path("finalRound").path("slots").get(0);
        assertThat(slot.path("playerOneId")).isEqualTo(corrected.path("finalRound").path("seedPlayerIds").get(0));
        assertThat(slot.path("playerTwoId")).isEqualTo(corrected.path("finalRound").path("seedPlayerIds").get(1));
        send(put(edit), event.director(), TIE, 400);
    }

    @Test
    void emptyFinalCanBeCancelledWithAuditAndNewBracketRejectsOldScores() throws Exception {
        Fixture event = tournament();
        JsonNode seeding = seedFinal(event);
        String url = cardPath(seeding);
        String cancel = url + "/final/cancel";
        var password = Map.of("password", PASSWORD);
        send(post(cancel).header("If-Match", versionTag(seeding)), event.director(), password, 400);
        JsonNode locked = send(post(url + "/final/start"), event.director(), null, 200);
        JsonNode oldSlots = locked.path("finalRound").path("slots");
        assertThat(oldSlots.size()).isEqualTo(2);
        var publicUrl = url.replace("/api/cards/", "/api/public/cards/");
        JsonNode announced = publicRead(publicUrl);
        assertThat(announced.path("finalRound").path("slots").get(0).has("pairingId")).isFalse();

        send(post(cancel).header("If-Match", versionTag(locked)), event.staff(), password, 403);
        send(post(cancel).header("If-Match", versionTag(locked)), event.director(), Map.of("password", "incorrect"), 403);
        send(post(cancel).header("If-Match", versionTag(seeding)), event.director(), password, 409);
        JsonNode reset = send(post(cancel).header("If-Match", versionTag(locked)), event.director(), password, 200);
        assertThat(reset.path("runtimeStage").asText()).isEqualTo("FINAL_SEEDING");
        assertThat(reset.path("snapshots")).isEqualTo(seeding.path("snapshots"));
        assertThat(reset.path("finalRound").path("seedPlayerIds")).isEqualTo(seeding.path("finalRound").path("seedPlayerIds"));
        assertThat(reset.path("finalRound").path("slots").isEmpty()).isTrue();
        var viewer = publicRead(publicUrl);
        assertThat(viewer.path("finalRound").isMissingNode() || viewer.path("finalRound").isNull()).isTrue();
        assertThat(viewer.path("version").asLong()).isGreaterThan(announced.path("version").asLong());

        JsonNode audit = body(mvc.perform(get(url + "/audit").with(event.director())), 200);
        var canceled = new ArrayList<JsonNode>();
        audit.forEach(entry -> { if (entry.path("action").asText().equals("CANCEL_FINAL")) canceled.add(entry); });
        assertThat(canceled).hasSize(1);
        assertThat(canceled.get(0).path("user").asText()).startsWith("director-");
        for (JsonNode slot : oldSlots)
            assertThat(canceled.get(0).path("oldValue").asText()).contains(slot.path("playerOneId").asText(), slot.path("playerTwoId").asText());

        send(put(url + "/matches/g2t1/override"), event.director(), Map.of("scoreOne", 500, "scoreTwo", 400), 200);
        var relocked = send(post(url + "/final/start"), event.director(), null, 200);
        var newSlot = relocked.path("finalRound").path("slots").get(1);
        assertThat(newSlot.path("pairingId").asText()).isNotEmpty().isNotEqualTo(oldSlots.get(1).path("pairingId").asText());
        String consolation = url + "/final/1/games/2";
        send(put(consolation), event.staff(), Map.of("scoreOne", 0, "scoreTwo", 0, "pairingId", oldSlots.get(1).path("pairingId").asText()), 409);
        send(post(cancel).header("If-Match", versionTag(locked)), event.director(), password, 409);
        var scored = send(put(consolation), event.staff(), Map.of("scoreOne", 0, "scoreTwo", 0, "pairingId", newSlot.path("pairingId").asText()), 200);
        send(post(cancel).header("If-Match", versionTag(scored)), event.director(), password, 409);
        assertThat(body(mvc.perform(get(url).with(event.director())), 200).path("finalRound")).isEqualTo(scored.path("finalRound"));
    }

    @Test
    void manuallySavedFinalWinnerBlocksCancellationEvenWithoutGameScores() throws Exception {
        Fixture event = tournament();
        String url = cardPath(seedFinal(event));
        var locked = send(post(url + "/final/start"), event.director(), null, 200);
        var slot = locked.path("finalRound").path("slots").get(1);
        var decided = send(put(url + "/final/1/winner"), event.staff(), Map.of(
            "winnerId", slot.path("playerOneId").asText(), "winnerWins", 1, "winnerLosses", 0, "totalDiff", 0,
            "pairingId", slot.path("pairingId").asText()), 200);
        send(post(url + "/final/cancel").header("If-Match", versionTag(decided)), event.director(), Map.of("password", PASSWORD), 409);
        assertThat(body(mvc.perform(get(url).with(event.director())), 200).path("finalRound")).isEqualTo(decided.path("finalRound"));
    }

    /**
     * This class is {@code @Transactional}, so the test transaction never commits and the
     * transaction-aware public-cache evictions never fire. Invalidate (immediate, unlike evict)
     * so a public read sees the same rows the staff read does.
     */
    private JsonNode publicRead(String publicUrl) throws Exception {
        for (String name : List.of(TournamentCaches.PUBLIC_CARD_DETAILS, TournamentCaches.PUBLIC_CARD_CATALOG,
                TournamentCaches.PUBLIC_CARD_VERSIONS)) {
            var cache = caches.getCache(name);
            if (cache != null) cache.invalidate();
        }
        return body(mvc.perform(get(publicUrl)), 200);
    }

    private JsonNode seedFinal(Fixture event) throws Exception {
        var input = new HashMap<>(cardInput(event));
        input.put("finalType", "CHAMPION_AND_THIRD");
        input.put("finalGames", 2);
        String url = cardPath(send(post("/api/cards"), event.director(), input, 201));
        send(post(url + "/players/bulk"), event.director(), Map.of("players",
            List.of(player("กอ"), player("ขอ"), player("คอ"), player("งอ"))), 201);
        send(post(url + "/registration/finish"), event.director(), null, 200);
        publishRegularGame(event, url, 1);
        return publishRegularGame(event, url, 2);
    }

    private Fixture tournament() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 12);
        String slug = "flow-" + suffix;
        JsonNode tournament = send(post("/api/admin/tournaments"), ADMIN,
            Map.of("name", "สนามทดสอบ", "slug", slug), 201);
        String id = tournament.path("id").asText();
        String directorName = "director-" + suffix;
        String staffName = "staff-" + suffix;
        var director = user(directorName).roles("DIRECTOR");
        send(post("/api/admin/directors"), ADMIN,
            Map.of("username", directorName, "password", PASSWORD, "tournamentIds", List.of(id)), 201);
        send(post("/api/director/staff"), director, Map.of("username", staffName, "password", PASSWORD), 201);
        send(post("/api/director/staff/" + staffName + "/tournaments"), director, Map.of("tournamentId", id), 200);
        return new Fixture(id, slug, staffName, director, user(staffName).roles("STAFF"));
    }

    private JsonNode makeCard(Fixture event) throws Exception {
        return send(post("/api/cards"), event.director(), cardInput(event), 201);
    }

    private JsonNode publishRegularGame(Fixture event, String url, int game) throws Exception {
        send(post(url + "/pairings/preview"), event.director(), null, 200);
        send(post(url + "/pairings/confirm"), event.director(), null, 200);
        for (int pair = 1; pair <= 2; pair++)
            send(put(url + "/matches/g" + game + "t" + pair + "/result"), event.staff(), TIE, 200);
        send(post(url + "/results/review"), event.director(), null, 200);
        return send(post(url + "/results/publish"), event.director(), null, 200);
    }

    private Map<String, Object> cardInput(Fixture event) {
        return Map.of("tournamentId", event.id(), "name", "รุ่นทดสอบ", "division", "ประถม",
            "numberOfGames", 2, "rules", List.of("SWISS"), "gameMaxDiffs", List.of(250, 250));
    }

    private String cardPath(JsonNode card) {
        return "/api/cards/" + card.path("id").asText();
    }

    private String versionTag(JsonNode card) {
        return "\"" + card.path("version").asLong() + "\"";
    }

    private Map<String, String> player(String name) {
        return Map.of("firstName", name, "lastName", "ทดสอบ", "school", "โรงเรียน " + name);
    }

    private List<String> names(JsonNode card) {
        List<String> names = new ArrayList<>();
        card.path("players").forEach(player -> names.add(player.path("firstName").asText()));
        return names;
    }

    private JsonNode send(MockHttpServletRequestBuilder request, RequestPostProcessor actor, Object payload, int expected)
        throws Exception {
        request.with(actor).with(csrf());
        if (payload != null)
            request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(payload));
        return body(mvc.perform(request), expected);
    }

    private JsonNode body(ResultActions action, int expected) throws Exception {
        return json.readTree(action.andExpect(status().is(expected)).andReturn().getResponse().getContentAsByteArray());
    }

    private record Fixture(String id, String slug, String staffName, RequestPostProcessor director,
                           RequestPostProcessor staff) {}
}
