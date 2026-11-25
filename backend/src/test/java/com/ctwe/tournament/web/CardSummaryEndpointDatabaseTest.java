package com.ctwe.tournament.web;

import com.ctwe.tournament.web.dto.PublicCardDtos;
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

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code GET /api/card-summaries} end to end: the five-way caller matrix B3 requires, and the value
 * contract that is the whole reason this endpoint exists rather than reusing the public one.
 *
 * <p>Real servlet container and real security filter chain — an authorization test that stubs the
 * filter chain proves nothing about the matcher ordering that actually decides access. Throwaway
 * accounts and tournaments with generated passwords; everything is deleted afterwards.
 *
 * <p>Gated on {@code DATABASE_PASSWORD}, like the other database tests, so CI skips it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class CardSummaryEndpointDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
        registry.add("server.servlet.session.cookie.secure", () -> "false");
    }

    private static final String SUFFIX = UUID.randomUUID().toString().substring(0, 8);
    private static final String ADMIN = "p1b-admin-" + SUFFIX;
    private static final String DIRECTOR = "p1b-director-" + SUFFIX;
    private static final String STAFF = "p1b-staff-" + SUFFIX;
    private static final String LONELY = "p1b-lonely-" + SUFFIX;
    private static final String PASSWORD = "probe-" + UUID.randomUUID();
    private static final int ROSTER = 3;

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired PasswordEncoder passwordEncoder;
    @Autowired com.ctwe.tournament.application.PublicCardQueryService publicCards;
    @Autowired org.springframework.cache.CacheManager caches;

    private UUID mineTournament, theirsTournament, mineCard, theirsCard;

    @BeforeEach
    void seed() {
        mineTournament = UUID.randomUUID();
        theirsTournament = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            mineTournament, "P1B mine " + SUFFIX, "p1b-mine-" + SUFFIX);
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            theirsTournament, "P1B theirs " + SUFFIX, "p1b-theirs-" + SUFFIX);

        mineCard = card(mineTournament, "P1B Mine", "MI");
        theirsCard = card(theirsTournament, "P1B Theirs", "TH");

        // The decisive fixture: a card still in PLAYER_REGISTRATION that HAS a roster. The public
        // projection reports 0 players here by design; staff need the real number.
        for (int code = 1; code <= ROSTER; code++)
            jdbc.update("INSERT INTO players (card_id, code, first_name, last_name, school) VALUES (?, ?, ?, ?, ?)",
                mineCard, code, "ผู้เล่น" + code, "ทดสอบ", "โรงเรียนทดสอบ");

        account(ADMIN, "ROLE_ADMIN");
        account(DIRECTOR, "ROLE_DIRECTOR");
        account(STAFF, "ROLE_STAFF");
        account(LONELY, "ROLE_DIRECTOR");
        jdbc.update("INSERT INTO tournament_members (tournament_id, username) VALUES (?, ?)", mineTournament, DIRECTOR);
        jdbc.update("INSERT INTO staff_tournament_access (username, tournament_id) VALUES (?, ?)", STAFF, mineTournament);
    }

    @AfterEach
    void cleanup() {
        for (String user : List.of(ADMIN, DIRECTOR, STAFF, LONELY)) {
            jdbc.update("DELETE FROM tournament_members WHERE username = ?", user);
            jdbc.update("DELETE FROM staff_tournament_access WHERE username = ?", user);
            jdbc.update("DELETE FROM staff_authorities WHERE username = ?", user);
            jdbc.update("DELETE FROM staff_accounts WHERE username = ?", user);
        }
        for (UUID card : List.of(mineCard, theirsCard)) {
            jdbc.update("DELETE FROM players WHERE card_id = ?", card);
            jdbc.update("DELETE FROM games WHERE card_id = ?", card);
            jdbc.update("DELETE FROM tournament_cards WHERE id = ?", card);
        }
        jdbc.update("DELETE FROM tournaments WHERE id IN (?, ?)", mineTournament, theirsTournament);
    }

    private UUID card(UUID tournament, String name, String prefix) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO tournament_cards (id, tournament_id, name, division, number_of_games,
                                          status, runtime_stage, code_prefix)
            VALUES (?, ?, ?, ?, 4, 'DRAFT', 'PLAYER_REGISTRATION', ?)
            """, id, tournament, name + " " + SUFFIX, "ทดสอบ", prefix);
        return id;
    }

    private void account(String username, String authority) {
        jdbc.update("INSERT INTO staff_accounts (username, password_hash, enabled) VALUES (?, ?, true)",
            username, passwordEncoder.encode(PASSWORD));
        jdbc.update("INSERT INTO staff_authorities (username, authority) VALUES (?, ?)", username, authority);
    }

    // ------------------------------------------------------------------ the matrix

    @Test
    @DisplayName("anonymous gets 401 — never the public projection that GET /api/cards hands back")
    void anonymousIsRefused() throws Exception {
        Browser anonymous = new Browser();
        HttpResponse<String> response = anonymous.get("/api/card-summaries");

        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(response.body()).doesNotContain("P1B Mine");

        // The contrast that motivates this endpoint: the same anonymous caller DOES get card data
        // from GET /api/cards, which is B7 / SECURITY-01 and is deliberately left untouched.
        assertThat(anonymous.get("/api/cards").statusCode()).isEqualTo(200);
    }

    @Test
    @DisplayName("a director sees only their own tournament's cards")
    void directorIsScoped() throws Exception {
        String body = loggedIn(DIRECTOR).get("/api/card-summaries").body();
        assertThat(body).contains(mineCard.toString());
        assertThat(body).doesNotContain(theirsCard.toString());
    }

    @Test
    @DisplayName("staff see only the tournament they were granted")
    void staffIsScoped() throws Exception {
        String body = loggedIn(STAFF).get("/api/card-summaries").body();
        assertThat(body).contains(mineCard.toString());
        assertThat(body).doesNotContain(theirsCard.toString());
    }

    @Test
    @DisplayName("an admin sees both tournaments — today's contract preserved; D3 narrowing is P2/P3")
    void adminIsUnrestricted() throws Exception {
        String body = loggedIn(ADMIN).get("/api/card-summaries").body();
        assertThat(body).contains(mineCard.toString()).contains(theirsCard.toString());
    }

    @Test
    @DisplayName("a director with no assignments gets 200 and an empty list, not 403 and not everything")
    void directorWithoutAssignmentsGetsEmptyList() throws Exception {
        HttpResponse<String> response = loggedIn(LONELY).get("/api/card-summaries");

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body().strip()).isEqualTo("[]");
    }

    @Test
    @DisplayName("a session evicted by maximumSessions(2) gets 401, not a plausible wrong card list")
    void evictedSessionIsRefusedRatherThanDowngraded() throws Exception {
        Browser idle = loggedIn(DIRECTOR);
        assertThat(idle.get("/api/card-summaries").body()).contains(mineCard.toString());

        loggedIn(DIRECTOR);   // 2nd
        loggedIn(DIRECTOR);   // 3rd -> evicts the least-recently-used session, which is `idle`

        // ConcurrentSessionFilter logs the session out ON this request and writes its own message;
        // the follow-up request is plain anonymous. Neither may contain card data.
        String first = idle.get("/api/card-summaries").body();
        HttpResponse<String> second = idle.get("/api/card-summaries");

        assertThat(first).doesNotContain(mineCard.toString());
        assertThat(second.statusCode()).isEqualTo(401);
        assertThat(second.body()).doesNotContain(mineCard.toString());
    }

    // ------------------------------------------------------------------ the value contract

    @Test
    @DisplayName("the staff summary reports the REAL roster size during registration, where the public one reports 0")
    void staffSummaryCarriesStaffValuesNotPublicOnes() throws Exception {
        String body = loggedIn(DIRECTOR).get("/api/card-summaries").body();

        Map<String, String> mine = fieldsOf(body, mineCard.toString());
        assertThat(mine.get("playerCount"))
            .as("staff need the roster size during registration; the public projection forces 0")
            .isEqualTo(String.valueOf(ROSTER));
        assertThat(mine.get("runtimeStage"))
            .as("the card's real stage, not a derived public stage")
            .isEqualTo("\"PLAYER_REGISTRATION\"");

        long staffVersion = jdbc.queryForObject(
            "SELECT version FROM tournament_cards WHERE id = ?", Long.class, mineCard);
        assertThat(mine.get("version"))
            .as("tournament_cards.version, never public_version")
            .isEqualTo(String.valueOf(staffVersion));

        // And the proof that reusing the public summary would have been wrong: same card, 0 players.
        // The catalog is @Cacheable(key='all') and this test seeded via raw SQL, which evicts nothing
        // (R11: even addPlayersBulk does not evict), so clear it before comparing.
        caches.getCache(com.ctwe.tournament.infrastructure.cache.TournamentCaches.PUBLIC_CARD_CATALOG).clear();
        PublicCardDtos.CardSummary publicView = publicCards.summaries().stream()
            .filter(summary -> summary.id().equals(mineCard)).findFirst().orElseThrow();
        assertThat(publicView.playerCount())
            .as("the public projection deliberately hides the roster during registration")
            .isZero();
    }

    @Test
    @DisplayName("the endpoint costs ONE statement, replacing the 1 + 7N full-card fan-out")
    void summariesDoNotFanOutPerCard() throws Exception {
        // A structural proxy for the query count: the response must carry no nested card payload.
        String body = loggedIn(ADMIN).get("/api/card-summaries").body();
        assertThat(body)
            .doesNotContain("\"players\"")
            .doesNotContain("\"matches\"")
            .doesNotContain("\"rules\"")
            .doesNotContain("\"tables\"")
            .doesNotContain("\"audit\"")
            .doesNotContain("\"snapshots\"");
    }

    /** Crude field reader for the object whose id matches, avoiding a JSON dependency in the test. */
    private static Map<String, String> fieldsOf(String jsonArray, String id) {
        int at = jsonArray.indexOf(id);
        assertThat(at).as("card " + id + " present in response").isGreaterThan(-1);
        int start = jsonArray.lastIndexOf('{', at);
        int end = jsonArray.indexOf('}', at);
        Map<String, String> fields = new LinkedHashMap<>();
        for (String part : jsonArray.substring(start + 1, end).split(",(?=\")")) {
            String[] kv = part.split(":", 2);
            if (kv.length == 2) fields.put(kv[0].replace("\"", "").strip(), kv[1].strip());
        }
        return fields;
    }

    // ------------------------------------------------------------------ minimal cookie-jar browser

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

        int login(String username) throws Exception {
            String body = get("/api/auth/me").body();
            int i = body.indexOf("\"csrfToken\":\"");
            String token = body.substring(i + 13, body.indexOf('"', i + 13));
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
    }
}
