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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

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
     * revalidates by ETag and usually costs a 304.
     *
     * <p><b>Validator contract.</b> A {@code bundle-v2} validator is a pure function of the
     * tournament metadata and the ordered {@code (card id, public_version)} list it describes, and a
     * 200 is always tagged from the card payloads it actually carries — never from a separately cached
     * catalog. (Tagging from the catalog let a response leave with a newer catalog's validator over an
     * older cached card body; every later revalidation then answered 304 and the browser kept the old
     * body until the next version bump.) A card's public payload is determined by its
     * {@code public_version}, which every publicly visible change bumps.
     *
     * <p><b>Cost.</b> The 304 decision reads the tournament row and the uncached version manifest —
     * one indexed query, no card payloads — so an unchanged refresh stays cheap however many cards
     * exist or compete for the detail cache. Only a 200 reads card payloads (through the cache).
     *
     * <p><b>Skew repair.</b> If a cached payload is older than the manifest (the instant between a
     * commit and its cache eviction), it is repaired once — sharing any repair another request has
     * already made or is making (see {@link PublicCardQueryService#reload}). Never more than once:
     * if it is still older, the response is tagged from what it carries. That validator always
     * describes the body actually sent; if a later request assembles the identical (still lagging)
     * body, Spring MVC may answer 304 against it — correct, because the representation is the same —
     * and the first request that assembles a newer body gets a 200.
     */
    @GetMapping("/{token}/bundle")
    public ResponseEntity<TenantDtos.PublicTournamentBundle> bundle(@PathVariable String token, HttpServletRequest request) {
        TenantDtos.PublicTournamentResponse tournament = tenant.resolveOpenTournament(token);
        List<PublicCardDtos.CardVersion> manifest = cards.manifest(tournament.id());

        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.CACHE_CONTROL, LIVE_POLICY);
        String current = etag(tournament, manifest);
        if (current.equals(request.getHeader(HttpHeaders.IF_NONE_MATCH))) {
            headers.setETag(current);
            return new ResponseEntity<>(null, headers, HttpStatus.NOT_MODIFIED);
        }

        List<CardDtos.CardResponse> details = new ArrayList<>(manifest.size());
        for (PublicCardDtos.CardVersion entry : manifest) {
            CardDtos.CardResponse card = cards.get(entry.id());
            if (card.version() < entry.version()) card = cards.reload(entry.id(), entry.version());
            details.add(card);
        }
        headers.setETag(etag(tournament, details.stream()
            .map(card -> new PublicCardDtos.CardVersion(card.id(), card.version()))
            .toList()));
        return new ResponseEntity<>(new TenantDtos.PublicTournamentBundle(
            tournament.id(), tournament.name(), tournament.accessToken(),
            tournament.cardCount(), tournament.publishedCardCount(), List.copyOf(details)), headers, HttpStatus.OK);
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

    /**
     * The {@code bundle-v2} validator: tournament metadata plus the ordered card identity/version
     * list. Strings are length-prefixed so no name can collide with a different field split.
     *
     * <p>The {@code bundle-v2-} namespace is deliberate. The previous catalog-derived {@code bundle-}
     * validators may already be cached by browsers over an older body; a new namespace guarantees
     * none of them can ever match again, so each such browser gets one full 200 and recovers.
     */
    static String etag(TenantDtos.PublicTournamentResponse tournament, List<PublicCardDtos.CardVersion> cards) {
        StringBuilder value = new StringBuilder("bundle-v2");
        for (String field : List.of(String.valueOf(tournament.id()), tournament.name(), tournament.accessToken(),
                Integer.toString(tournament.cardCount()), Integer.toString(tournament.publishedCardCount())))
            value.append('|').append(field.length()).append(':').append(field);
        for (PublicCardDtos.CardVersion card : cards)
            value.append('|').append(card.id()).append(':').append(card.version());
        return "\"bundle-v2-" + UUID.nameUUIDFromBytes(value.toString().getBytes(StandardCharsets.UTF_8)) + "\"";
    }
}
