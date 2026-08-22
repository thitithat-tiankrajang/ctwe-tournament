package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * P4 SSE PROOF GATE — end to end, with two genuinely independent authenticated sessions.
 *
 * <p>User B holds a real EventSource-shaped stream against the real servlet container while user A
 * submits results over real HTTP. Every claim is checked against PostgreSQL through {@link
 * JdbcTemplate} rather than against the UI, per the gate: persisted state, emitted event, received
 * event, card identity, version correctness, monotonicity, and payload agreement.
 *
 * <p>This is the HEALTHY-PATH characterization. It answers "does delivery work when nothing is
 * stalled?", which decides the SEVERITY of the defects proven elsewhere — {@code
 * SseDropReachabilityTest} (server discards silently) and {@code sse-gap-recovery.test.ts} (the
 * staff client does not notice). Throwaway tournament, card and accounts; all deleted afterwards.
 *
 * <p>Gated on {@code DATABASE_PASSWORD} like every other database test here.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class SseDeliveryProofDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
        registry.add("server.servlet.session.cookie.secure", () -> "false");
    }

    private static final String SUFFIX = UUID.randomUUID().toString().substring(0, 8);
    private static final String WRITER = "p4-a-" + SUFFIX;      // user A
    private static final String OBSERVER = "p4-b-" + SUFFIX;    // user B
    private static final String PASSWORD = "probe-" + UUID.randomUUID();
    private static final int PLAYERS = 8;

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired PasswordEncoder passwordEncoder;
    @Autowired TournamentCardService service;

    private UUID tournamentId;
    private UUID cardId;

    @BeforeEach
    void seed() {
        tournamentId = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, "P4 SSE gate " + SUFFIX, "p4-sse-" + SUFFIX);

        account(WRITER, "ROLE_DIRECTOR");
        account(OBSERVER, "ROLE_DIRECTOR");
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?)", tournamentId, WRITER);
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?)", tournamentId, OBSERVER);

        List<Integer> maxDiffs = new ArrayList<>();
        for (int i = 0; i < 3; i++) maxDiffs.add(500);
        cardId = service.create(new CardDtos.CreateCardRequest(tournamentId, "P4-SSE-" + SUFFIX, "GATE",
            3, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS), maxDiffs,
            "NONE", 0, false, PairingRuleType.RANDOM), WRITER).id();

        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < PLAYERS; i++)
            players.add(new CardDtos.BulkPlayerEntry("P4First" + i, "P4Last" + i, "School" + (i % 2)));
        service.addPlayersBulk(cardId, players, WRITER);
        service.finishRegistration(cardId, WRITER);
        service.generatePairingPreview(cardId, WRITER);
        service.confirmPairingPreview(cardId, WRITER);
    }

    @AfterEach
    void cleanup() {
        if (cardId != null) {
            jdbc.update("DELETE FROM final_game_results WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM final_pairings WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM standings WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM matches WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM table_seats WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM pairing_snapshots WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM pairing_rules WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM games WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM players WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM audit_logs WHERE card_id = ?", cardId);
            jdbc.update("DELETE FROM tournament_cards WHERE id = ?", cardId);
        }
        for (String user : List.of(WRITER, OBSERVER)) {
            jdbc.update("DELETE FROM tournament_members WHERE username = ?", user);
            jdbc.update("DELETE FROM staff_tournament_access WHERE username = ?", user);
            jdbc.update("DELETE FROM staff_authorities WHERE username = ?", user);
            jdbc.update("DELETE FROM staff_accounts WHERE username = ?", user);
        }
        if (tournamentId != null) jdbc.update("DELETE FROM tournaments WHERE id = ?", tournamentId);
    }

    private void account(String username, String authority) {
        jdbc.update("INSERT INTO staff_accounts (username, password_hash, enabled) VALUES (?, ?, true)",
            username, passwordEncoder.encode(PASSWORD));
        jdbc.update("INSERT INTO staff_authorities (username, authority) VALUES (?, ?)", username, authority);
    }

    private long dbVersion() {
        return jdbc.queryForObject("SELECT version FROM tournament_cards WHERE id = ?", Long.class, cardId);
    }

    /**
     * Match ids of the confirmed game-1 snapshot, in table order — A's write targets.
     * `matches` is keyed by (card_id, game_number, table_number); the API id is `g{game}t{table}`.
     */
    private List<String> matchIds() {
        return jdbc.queryForList(
            "SELECT table_number FROM matches WHERE card_id = ? AND game_number = 1 "
                + "AND player_one IS NOT NULL AND player_two IS NOT NULL ORDER BY table_number",
            Integer.class, cardId).stream().map(table -> "g1t" + table).toList();
    }

    private Integer dbScoreOne(int tableNumber) {
        return jdbc.queryForObject(
            "SELECT score_one FROM matches WHERE card_id = ? AND game_number = 1 AND table_number = ?",
            Integer.class, cardId, tableNumber);
    }

    // ---------------------------------------------------------------- the gate

    @Test
    @DisplayName("every persisted result reaches B, with the right card, a correct and monotonic version")
    void bReceivesEveryPersistedResult() throws Exception {
        Browser b = loggedIn(OBSERVER);
        Stream stream = b.openStream("/api/cards/" + cardId + "/events");
        try {
            assertThat(stream.awaitEvents(1, 10)).as("B's stream must open with `connected`").isTrue();
            assertThat(stream.names()).containsExactly("connected");

            Browser a = loggedIn(WRITER);
            List<String> matches = matchIds();
            assertThat(matches).as("the confirmed snapshot must contain matches").isNotEmpty();

            List<Long> persisted = new ArrayList<>();
            int expected = Math.min(4, matches.size());
            for (int i = 0; i < expected; i++) {
                HttpResponse<String> saved = a.put(
                    "/api/cards/" + cardId + "/matches/" + matches.get(i) + "/result",
                    "{\"scoreOne\":%d,\"scoreTwo\":%d,\"editExisting\":false}".formatted(400 + i, 300 + i));
                assertThat(saved.statusCode()).as("A's result save").isEqualTo(200);
                persisted.add(dbVersion());
            }

            assertThat(stream.awaitEvents(1 + expected, 15))
                .as("B received %s of %d expected events: %s",
                    stream.names().size() - 1, expected, stream.versions())
                .isTrue();

            List<Long> received = stream.resultVersions();
            assertThat(received).as("one result event per persisted save").hasSize(expected);
            assertThat(stream.cardIds()).as("every event names the card under edit")
                .allMatch(id -> id.equals(cardId.toString()));
            assertThat(received).as("versions agree with what PostgreSQL persisted")
                .containsExactlyElementsOf(persisted);
            assertThat(received).as("versions are strictly increasing").isSorted();
            assertThat(received.get(received.size() - 1))
                .as("B's final version equals the DB's final version")
                .isEqualTo(dbVersion());
            assertThat(received).doesNotHaveDuplicates();

            // Contiguity: the property the staff client does NOT check but depends on.
            for (int i = 1; i < received.size(); i++)
                assertThat(received.get(i) - received.get(i - 1))
                    .as("gap between consecutive delivered versions %s", received).isEqualTo(1L);
        } finally {
            stream.close();
        }
    }

    @Test
    @DisplayName("rapid consecutive saves: the healthy path loses nothing and stays ordered")
    void rapidConsecutiveSavesArriveCompleteAndOrdered() throws Exception {
        Browser b = loggedIn(OBSERVER);
        Stream stream = b.openStream("/api/cards/" + cardId + "/events");
        try {
            assertThat(stream.awaitEvents(1, 10)).isTrue();
            Browser a = loggedIn(WRITER);
            List<String> matches = matchIds();
            int burst = Math.min(4, matches.size());

            // Back to back with no pause — the "A submits while B is typing" shape.
            for (int i = 0; i < burst; i++)
                assertThat(a.put("/api/cards/" + cardId + "/matches/" + matches.get(i) + "/result",
                    "{\"scoreOne\":%d,\"scoreTwo\":%d,\"editExisting\":false}".formatted(500 + i, 200 + i))
                    .statusCode()).isEqualTo(200);

            assertThat(stream.awaitEvents(1 + burst, 15))
                .as("B received %s of %d: %s", stream.names().size() - 1, burst, stream.versions()).isTrue();

            List<Long> received = stream.resultVersions();
            assertThat(received).hasSize(burst).isSorted().doesNotHaveDuplicates();
            assertThat(received.get(received.size() - 1)).isEqualTo(dbVersion());

            // Payload agreement: the last event's scores must equal what the DB holds for that match.
            String lastMatch = matches.get(burst - 1);
            int lastTable = Integer.parseInt(lastMatch.substring(lastMatch.indexOf('t') + 1));
            Integer persistedScore = dbScoreOne(lastTable);
            assertThat(persistedScore).as("the DB must hold A's last save").isNotNull();
            assertThat(stream.rawFor(lastMatch))
                .as("the delivered payload for %s must carry the persisted score %d", lastMatch, persistedScore)
                .contains("\"scoreOne\":" + persistedScore);
        } finally {
            stream.close();
        }
    }

    // ---------------------------------------------------------------- cookie-jar browser + SSE reader

    private Browser loggedIn(String username) throws Exception {
        Browser browser = new Browser();
        assertThat(browser.login(username)).as("login " + username).isEqualTo(204);
        return browser;
    }

    private final class Browser {
        final Map<String, String> cookies = new LinkedHashMap<>();
        final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

        private String cookieHeader() {
            StringBuilder sb = new StringBuilder();
            cookies.forEach((k, v) -> { if (sb.length() > 0) sb.append("; "); sb.append(k).append('=').append(v); });
            return sb.toString();
        }

        private void absorb(HttpResponse<?> response) {
            for (String header : response.headers().allValues("set-cookie")) {
                String pair = header.split(";", 2)[0];
                int eq = pair.indexOf('=');
                if (eq <= 0) continue;
                String key = pair.substring(0, eq).trim();
                String value = pair.substring(eq + 1).trim();
                if (value.isEmpty()) cookies.remove(key); else cookies.put(key, value);
            }
        }

        HttpResponse<String> get(String path) throws Exception {
            HttpResponse<String> response = http.send(HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + path))
                .header("Cookie", cookieHeader()).GET().build(),
                HttpResponse.BodyHandlers.ofString());
            absorb(response);
            return response;
        }

        HttpResponse<String> put(String path, String json) throws Exception {
            String csrf = csrfToken();
            HttpResponse<String> response = http.send(HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + path))
                .header("Cookie", cookieHeader())
                .header("Content-Type", "application/json")
                .header("X-XSRF-TOKEN", csrf)
                .PUT(HttpRequest.BodyPublishers.ofString(json)).build(),
                HttpResponse.BodyHandlers.ofString());
            absorb(response);
            return response;
        }

        private String csrfToken() throws Exception {
            String body = get("/api/auth/me").body();
            int i = body.indexOf("\"csrfToken\":\"");
            return body.substring(i + 13, body.indexOf('"', i + 13));
        }

        int login(String username) throws Exception {
            String token = csrfToken();
            String form = "username=" + URLEncoder.encode(username, StandardCharsets.UTF_8)
                + "&password=" + URLEncoder.encode(PASSWORD, StandardCharsets.UTF_8)
                + "&_csrf=" + URLEncoder.encode(token, StandardCharsets.UTF_8);
            HttpResponse<String> response = http.send(HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/login"))
                .header("Cookie", cookieHeader())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build(),
                HttpResponse.BodyHandlers.ofString());
            absorb(response);
            return response.statusCode();
        }

        /** Opens a real SSE stream on a background thread, exactly as EventSource would. */
        Stream openStream(String path) throws Exception {
            HttpResponse<java.io.InputStream> response = http.send(HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + path))
                .header("Cookie", cookieHeader())
                .header("Accept", "text/event-stream").GET().build(),
                HttpResponse.BodyHandlers.ofInputStream());
            assertThat(response.statusCode()).as("SSE subscribe").isEqualTo(200);
            return new Stream(response.body());
        }
    }

    /** Minimal SSE frame parser: collects `event:`/`id:`/`data:` triples off the wire. */
    private static final class Stream implements AutoCloseable {
        private final java.io.InputStream body;
        private final List<String> names = new CopyOnWriteArrayList<>();
        private final List<String> data = new CopyOnWriteArrayList<>();
        private final Thread reader;
        private volatile CountDownLatch arrival = new CountDownLatch(1);

        Stream(java.io.InputStream body) {
            this.body = body;
            this.reader = new Thread(this::pump, "p4-sse-reader");
            this.reader.setDaemon(true);
            this.reader.start();
        }

        private void pump() {
            try (BufferedReader in = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8))) {
                String name = null;
                for (String line; (line = in.readLine()) != null; ) {
                    if (line.startsWith("event:")) name = line.substring(6).trim();
                    else if (line.startsWith("data:")) {
                        names.add(name == null ? "message" : name);
                        data.add(line.substring(5).trim());
                        name = null;
                        arrival.countDown();
                    }
                }
            } catch (Exception ignored) { /* closed at teardown */ }
        }

        boolean awaitEvents(int count, int seconds) throws InterruptedException {
            long deadline = System.currentTimeMillis() + seconds * 1000L;
            while (names.size() < count && System.currentTimeMillis() < deadline) {
                arrival = new CountDownLatch(1);
                if (names.size() >= count) break;
                arrival.await(200, TimeUnit.MILLISECONDS);
            }
            return names.size() >= count;
        }

        List<String> names() { return List.copyOf(names); }

        List<Long> versions() {
            List<Long> out = new ArrayList<>();
            for (String payload : data) out.add(versionOf(payload));
            return out;
        }

        List<Long> resultVersions() {
            List<Long> out = new ArrayList<>();
            for (int i = 0; i < names.size(); i++)
                if ("result".equals(names.get(i))) out.add(versionOf(data.get(i)));
            return out;
        }

        List<String> cardIds() {
            List<String> out = new ArrayList<>();
            for (String payload : data) out.add(field(payload, "cardId"));
            return out;
        }

        /** The raw frame that mentions this match id, for payload-vs-DB comparison. */
        String rawFor(String matchId) {
            String needle = "\"id\":\"" + matchId + "\"";
            for (int i = data.size() - 1; i >= 0; i--) if (data.get(i).contains(needle)) return data.get(i);
            return "";
        }

        private static long versionOf(String payload) {
            int i = payload.indexOf("\"version\":");
            if (i < 0) return -1;
            int j = i + 10;
            int k = j;
            while (k < payload.length() && (Character.isDigit(payload.charAt(k)) || payload.charAt(k) == '-')) k++;
            return Long.parseLong(payload.substring(j, k));
        }

        private static String field(String payload, String name) {
            int i = payload.indexOf("\"" + name + "\":\"");
            if (i < 0) return "";
            int j = i + name.length() + 4;
            return payload.substring(j, payload.indexOf('"', j));
        }

        @Override public void close() {
            try { body.close(); } catch (Exception ignored) { /* already closed */ }
            reader.interrupt();
        }
    }
}
