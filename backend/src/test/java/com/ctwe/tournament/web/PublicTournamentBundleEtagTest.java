package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Conditional-response correctness of {@code GET /api/public/tournaments/{token}/bundle}.
 *
 * <p>The defect: the validator was hashed from the catalog cache ({@code summaries()}) while the body
 * was assembled from the separate per-card detail cache ({@code get(id)}). When the two disagree, a
 * response can leave with the NEWER catalog's validator over an OLDER body; every later revalidation
 * then matches and answers 304, so the browser keeps the old body until the next public_version
 * bump. The fix derives the validator from the response actually assembled, under a new namespace so
 * browsers already holding such a poisoned association are forced to a fresh 200.
 *
 * <p>Real {@link PublicTournamentController} through standalone MockMvc (real Spring MVC dispatch and
 * Jackson). Only its collaborators are synthetic, so catalog/detail skew can be produced on demand.
 * Nothing here proves how production produced a skewed response — only what the controller does
 * with one.
 */
class PublicTournamentBundleEtagTest {
    private static final String TOKEN = "fixture-cup";
    private static final String LIVE_POLICY = "public, max-age=2, s-maxage=5, stale-while-revalidate=10";
    private static final UUID TOURNAMENT = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final UUID CARD_A = UUID.fromString("aaaaaaaa-0000-4000-8000-00000000000a");
    private static final UUID CARD_B = UUID.fromString("bbbbbbbb-0000-4000-8000-00000000000b");

    private final TenantService tenant = mock(TenantService.class);
    private final PublicCardQueryService cards = mock(PublicCardQueryService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(
        new PublicTournamentController(tenant, cards, mock(CardEventPublisher.class))).build();

    /** What the authoritative manifest currently says (id → public_version), in public order. */
    private final Map<UUID, Long> catalog = new java.util.LinkedHashMap<>();
    /** What the per-card detail cache currently returns (id → public_version of the body). */
    private final Map<UUID, Long> details = new HashMap<>();
    private TenantDtos.PublicTournamentResponse tournament =
        new TenantDtos.PublicTournamentResponse(TOURNAMENT, "Fixture Cup", TOKEN, 2, 0);

    @BeforeEach
    void wire() {
        when(tenant.resolveOpenTournament(TOKEN)).thenAnswer(call -> tournament);
        when(cards.manifest(TOURNAMENT)).thenAnswer(call -> catalog.entrySet().stream()
            .map(entry -> new PublicCardDtos.CardVersion(entry.getKey(), entry.getValue())).toList());
        // The detail "cache" answers from `details`; a reload re-reads it (here it does not change by
        // itself, which models a payload that stays behind the manifest even after one repair).
        when(cards.get(any(UUID.class))).thenAnswer(call -> {
            UUID id = call.getArgument(0);
            return card(id, details.get(id), (int) (details.get(id) % 5) + 1);
        });
        when(cards.reload(any(UUID.class), anyLong())).thenAnswer(call -> {
            UUID id = call.getArgument(0);
            return card(id, details.get(id), (int) (details.get(id) % 5) + 1);
        });
        catalog.put(CARD_A, 10L);
        catalog.put(CARD_B, 20L);
        details.put(CARD_A, 10L);
        details.put(CARD_B, 20L);
    }

    // ---- the defect: validator must describe the body actually sent ------------------------------

    @Test
    void catalogAheadOfDetailYieldsTheValidatorOfTheReturnedBody() throws Exception {
        String consistentAtN = fetch(null).etag();

        catalog.put(CARD_A, 11L); // manifest already at N+1, detail cache still serves body N
        Response skewed = fetch(null);

        assertThat(skewed.status()).isEqualTo(200);
        verify(cards, times(1)).reload(CARD_A, 11L); // one bounded, version-aware repair attempt
        assertThat(skewed.body()).contains("\"version\":10").doesNotContain("\"version\":11");
        assertThat(skewed.etag())
            .as("the validator must describe body N, not the manifest's N+1")
            .isEqualTo(consistentAtN);
    }

    @Test
    void onceDetailsCatchUpAValidatorForTheOldBodyGetsAFresh200() throws Exception {
        catalog.put(CARD_A, 11L);
        Response skewed = fetch(null);                 // body N under whatever validator the server chose

        details.put(CARD_A, 11L);                      // detail cache catches up
        Response revalidated = fetch(skewed.etag());

        assertThat(revalidated.status())
            .as("a browser holding body N must not be told 304 once the server holds N+1")
            .isEqualTo(200);
        assertThat(revalidated.body()).contains("\"version\":11");
    }

    @Test
    void legacyValidatorForTheCurrentVersionsIsNeverHonoured() throws Exception {
        catalog.put(CARD_A, 11L);
        details.put(CARD_A, 11L);
        // Exactly what the previous controller emitted for catalog N+1 — a browser may hold it over body N.
        String legacy = legacyEtag(TOURNAMENT, List.of(CARD_A + ":11", CARD_B + ":20"));

        Response response = fetch(legacy);

        assertThat(response.status())
            .as("an old-namespace validator can be poisoned; it must always force a full 200")
            .isEqualTo(200);
        assertThat(response.body()).contains("\"version\":11");
        assertThat(response.etag()).startsWith("\"bundle-v2-").isNotEqualTo(legacy);
    }

    @Test
    void repeatingTheCurrentValidatorStillAnswers304WithTheSameHeaders() throws Exception {
        Response first = fetch(null);
        Response second = fetch(first.etag());

        assertThat(second.status()).isEqualTo(304);
        assertThat(second.body()).isEmpty();
        assertThat(second.etag()).isEqualTo(first.etag());
        assertThat(first.cacheControl()).isEqualTo(LIVE_POLICY);
        assertThat(second.cacheControl()).isEqualTo(LIVE_POLICY);
    }

    // ---- what the validator covers ---------------------------------------------------------------

    @Test
    void representationRelevantChangesInvalidateTheValidator() throws Exception {
        String base = fetch(null).etag();

        tournament = new TenantDtos.PublicTournamentResponse(TOURNAMENT, "Renamed Cup", TOKEN, 2, 0);
        String renamed = fetch(null).etag();
        tournament = new TenantDtos.PublicTournamentResponse(TOURNAMENT, "Fixture Cup", TOKEN, 2, 1);
        String publishedCount = fetch(null).etag();
        tournament = new TenantDtos.PublicTournamentResponse(TOURNAMENT, "Fixture Cup", TOKEN, 3, 0);
        String cardCount = fetch(null).etag();
        tournament = new TenantDtos.PublicTournamentResponse(TOURNAMENT, "Fixture Cup", TOKEN, 2, 0);
        details.put(CARD_B, 21L);
        String cardVersion = fetch(null).etag();
        details.put(CARD_B, 20L);
        catalog.clear();
        catalog.put(CARD_B, 20L);
        catalog.put(CARD_A, 10L);
        String reordered = fetch(null).etag();
        catalog.remove(CARD_A);
        String removed = fetch(null).etag();

        assertThat(List.of(base, renamed, publishedCount, cardCount, cardVersion, reordered, removed))
            .doesNotHaveDuplicates();
        assertThat(fetch(base).status()).as("none of those changes may 304 against the original").isEqualTo(200);
    }

    @Test
    void emptyTournamentStillValidates() throws Exception {
        catalog.clear();
        tournament = new TenantDtos.PublicTournamentResponse(TOURNAMENT, "Fixture Cup", TOKEN, 0, 0);

        Response first = fetch(null);
        assertThat(first.status()).isEqualTo(200);
        assertThat(first.body()).contains("\"cards\":[]");
        assertThat(first.etag()).startsWith("\"bundle-v2-");
        assertThat(fetch(first.etag()).status()).isEqualTo(304);
    }

    @Test
    void closedOrUnknownLinkStill404sWithoutReadingAnyCard() throws Exception {
        when(tenant.resolveOpenTournament("closed-cup"))
            .thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament not found or not open"));

        MvcResult result = mvc.perform(get("/api/public/tournaments/closed-cup/bundle")).andReturn();

        assertThat(result.getResponse().getStatus()).isEqualTo(404);
        verify(cards, never()).manifest(any(UUID.class));
        verify(cards, never()).get(any(UUID.class));
    }

    // ---- replay of the owner's flow with controller-generated validators --------------------------

    /**
     * A minimal RFC 9111 private cache for one URL: stores the last 200, revalidates with its ETag,
     * and on 304 keeps the stored body. This is the browser behaviour the earlier harness observed.
     */
    private final class BrowserCache {
        String etag;
        String body;

        String load() throws Exception {
            Response response = fetch(etag);
            if (response.status() == 200) { etag = response.etag(); body = response.body(); }
            return body;
        }
    }

    @Test
    void replayOfTheOwnerFlowRecoversInsteadOfFreezing() throws Exception {
        BrowserCache browser = new BrowserCache();
        assertThat(browser.load()).contains("\"version\":10");            // 1. list at game 3

        catalog.put(CARD_A, 11L);                                          // 3. game 4 published; detail
        assertThat(browser.load()).contains("\"version\":10");            // 4. resume during skew: old body

        details.put(CARD_A, 11L);                                          // skew resolves
        // 7. every refresh afterwards must now converge on the current body, not 304 forever
        assertThat(browser.load()).contains("\"version\":11");
        assertThat(browser.load()).contains("\"version\":11");
        assertThat(fetch(browser.etag).status()).as("steady state is a cheap 304 again").isEqualTo(304);
    }

    @Test
    void browserHoldingALegacyPoisonedAssociationRecoversOnFirstRefresh() throws Exception {
        catalog.put(CARD_A, 11L);
        details.put(CARD_A, 11L);
        BrowserCache browser = new BrowserCache();
        // State left behind by the old controller: the N+1 legacy validator over body N.
        browser.etag = legacyEtag(TOURNAMENT, List.of(CARD_A + ":11", CARD_B + ":20"));
        browser.body = "{\"cards\":[{\"id\":\"" + CARD_A + "\",\"version\":10}]}";

        assertThat(browser.load()).contains("\"version\":11");
        assertThat(browser.etag).startsWith("\"bundle-v2-");
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private record Response(int status, String etag, String cacheControl, String body) {}

    private Response fetch(String ifNoneMatch) throws Exception {
        var request = get("/api/public/tournaments/" + TOKEN + "/bundle");
        if (ifNoneMatch != null) request.header(HttpHeaders.IF_NONE_MATCH, ifNoneMatch);
        var response = mvc.perform(request).andReturn().getResponse();
        return new Response(response.getStatus(), response.getHeader(HttpHeaders.ETAG),
            response.getHeader(HttpHeaders.CACHE_CONTROL), response.getContentAsString(StandardCharsets.UTF_8));
    }

    /** The validator format the previous controller emitted (catalog-derived, unversioned namespace). */
    private static String legacyEtag(UUID tournamentId, List<String> idVersions) {
        String value = "bundle|" + tournamentId + "|" + String.join("|", idVersions);
        return "\"bundle-" + UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)) + "\"";
    }

    private static CardDtos.CardResponse card(UUID id, long version, int currentGame) {
        return new CardDtos.CardResponse(id, TOURNAMENT, "Fixture", "Div", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, currentGame, version, List.of(), PairingRuleType.RANDOM, List.of(),
            List.of(), List.of(), List.of(), List.of(), "NONE", 0, null, false, Instant.EPOCH, "A", "PAIR", List.of());
    }
}
