package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Anonymous, link-scoped entry point. The root landing lists OPEN tournaments; a shared access
 * token resolves to a single OPEN tournament and its published cards. A CLOSED (or unknown) token
 * 404s, which is how the admin OPEN/CLOSE toggle gates each private link.
 */
@RestController
@RequestMapping("/api/public/tournaments")
public class PublicTournamentController {
    /** Same near-live policy as the public card endpoints; SSE (not cache expiry) drives updates. */
    private static final String LIVE_POLICY = "public, max-age=2, s-maxage=5, stale-while-revalidate=10";

    private final TenantService tenant;
    private final PublicCardQueryService cards;
    private final CardEventPublisher events;

    public PublicTournamentController(TenantService tenant, PublicCardQueryService cards, CardEventPublisher events) {
        this.tenant = tenant;
        this.cards = cards;
        this.events = events;
    }

    @GetMapping
    public List<TenantDtos.PublicTournamentResponse> open() {
        return tenant.listOpenTournaments();
    }

    @GetMapping("/{token}")
    public TenantDtos.PublicTournamentResponse resolve(@PathVariable String token) {
        return tenant.resolveOpenTournament(token);
    }

    @GetMapping("/{token}/cards")
    public List<PublicCardDtos.CardSummary> cards(@PathVariable String token) {
        TenantDtos.PublicTournamentResponse tournament = tenant.resolveOpenTournament(token);
        return cards.summaries(tournament.id());
    }

    /**
     * Everything a viewer page needs in ONE request: the tournament plus the full public payload
     * of every card. Viewers switch between cards without any further request; a browser refresh
     * revalidates by ETag and usually costs a 304. Composed entirely from the Caffeine-backed
     * read cache, so refresh storms never amplify into database load.
     */
    @GetMapping("/{token}/bundle")
    public ResponseEntity<TenantDtos.PublicTournamentBundle> bundle(@PathVariable String token, HttpServletRequest request) {
        TenantDtos.PublicTournamentResponse tournament = tenant.resolveOpenTournament(token);
        List<PublicCardDtos.CardSummary> summaries = cards.summaries(tournament.id());
        String etag = etag(tournament.id(), summaries);

        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.CACHE_CONTROL, LIVE_POLICY);
        headers.setETag(etag);
        if (etag.equals(request.getHeader(HttpHeaders.IF_NONE_MATCH)))
            return new ResponseEntity<>(null, headers, HttpStatus.NOT_MODIFIED);

        List<CardDtos.CardResponse> details = summaries.stream()
            .map(summary -> cards.get(summary.id()))
            .toList();
        return new ResponseEntity<>(new TenantDtos.PublicTournamentBundle(
            tournament.id(), tournament.name(), tournament.accessToken(),
            tournament.cardCount(), tournament.publishedCardCount(), details), headers, HttpStatus.OK);
    }

    /**
     * The card LIST's live channel: pushes card-summary / card-removed facts the moment a card is
     * created, changes stage, or is deleted — so a viewer parked on the list (even one who arrived
     * before the first card existed) sees it appear without ever refreshing or polling.
     */
    @GetMapping(value = "/{token}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable String token, HttpServletResponse response) {
        TenantDtos.PublicTournamentResponse tournament = tenant.resolveOpenTournament(token);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        return events.subscribeTournament(tournament.id(), () -> cards.catalogFingerprint(tournament.id()));
    }

    private String etag(UUID tournamentId, List<PublicCardDtos.CardSummary> summaries) {
        String value = "bundle|" + tournamentId + "|" + summaries.stream()
            .map(card -> card.id() + ":" + card.version())
            .collect(Collectors.joining("|"));
        return "\"bundle-" + UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)) + "\"";
    }
}
