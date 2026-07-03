package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.RuntimeSettings;
import com.ctwe.tournament.application.RuntimeSettingsService;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import com.ctwe.tournament.web.dto.SettingsDtos;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

/**
 * Anonymous-only read model. These responses are identical for every viewer and are the only API
 * responses that may be cached by Vercel's CDN.
 */
@RestController
@RequestMapping("/api/public")
public class PublicCardController {
    private static final String EDGE_POLICY = "max-age=5, stale-while-revalidate=10";
    private static final CacheControl BROWSER_POLICY =
        CacheControl.maxAge(Duration.ofSeconds(2)).cachePublic().mustRevalidate();

    private final PublicCardQueryService cards;
    private final CardEventPublisher events;
    private final RuntimeSettingsService settings;

    public PublicCardController(PublicCardQueryService cards, CardEventPublisher events, RuntimeSettingsService settings) {
        this.cards = cards;
        this.events = events;
        this.settings = settings;
    }

    @GetMapping("/cards")
    public ResponseEntity<List<PublicCardDtos.CardSummary>> cards(HttpServletRequest request) {
        List<PublicCardDtos.CardSummary> body = cards.summaries();
        return cached(request, body, etag("catalog", body.stream()
            .map(card -> card.id() + ":" + card.version()).toList()), "public-cards");
    }

    @GetMapping("/cards/versions")
    public ResponseEntity<List<PublicCardDtos.CardVersion>> versions(HttpServletRequest request) {
        List<PublicCardDtos.CardVersion> body = cards.versions();
        return cached(request, body, etag("versions", body.stream()
            .map(card -> card.id() + ":" + card.version()).toList()), "public-card-versions");
    }

    @GetMapping("/cards/{cardId}")
    public ResponseEntity<CardDtos.CardResponse> card(@PathVariable UUID cardId, HttpServletRequest request) {
        CardDtos.CardResponse body = cards.get(cardId);
        boolean versioned = Long.toString(body.version()).equals(request.getParameter("v"));
        String edgePolicy = versioned ? "max-age=300, stale-while-revalidate=60" : EDGE_POLICY;
        return cached(request, body, "\"card-" + cardId + "-v" + body.version() + "\"",
            "public-cards,card-" + cardId, edgePolicy);
    }

    @GetMapping(value = "/cards/{cardId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable UUID cardId, HttpServletResponse response) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        return events.subscribePublic(cardId, () -> cards.get(cardId).version());
    }

    /** Browser sync strategy: whether to open SSE, whether/how fast to poll, and the reconnect delay. */
    @GetMapping("/realtime-config")
    public ResponseEntity<SettingsDtos.PublicRealtimeConfig> realtimeConfig(HttpServletRequest request) {
        RuntimeSettings current = settings.current();
        SettingsDtos.PublicRealtimeConfig body = new SettingsDtos.PublicRealtimeConfig(
            current.realtimeEnabled(), current.sseEnabled(), current.pollingEnabled(),
            current.pollingIntervalMs(), current.reconnectDelayMs());
        return cached(request, body, etag("realtime-config", List.of(
            body.realtimeEnabled() + "", body.sseEnabled() + "", body.pollingEnabled() + "",
            body.pollingIntervalMs() + "", body.reconnectDelayMs() + "")), "realtime-config");
    }

    private <T> ResponseEntity<T> cached(
        HttpServletRequest request, T body, String etag, String tags
    ) {
        return cached(request, body, etag, tags, EDGE_POLICY);
    }

    private <T> ResponseEntity<T> cached(
        HttpServletRequest request, T body, String etag, String tags, String edgePolicy
    ) {
        HttpHeaders headers = new HttpHeaders();
        headers.setCacheControl(BROWSER_POLICY);
        headers.set("CDN-Cache-Control", edgePolicy);
        headers.set("Vercel-CDN-Cache-Control", edgePolicy);
        headers.set("Vercel-Cache-Tag", tags);
        headers.setETag(etag);
        if (etag.equals(request.getHeader(HttpHeaders.IF_NONE_MATCH)))
            return new ResponseEntity<>(null, headers, HttpStatus.NOT_MODIFIED);
        return new ResponseEntity<>(body, headers, HttpStatus.OK);
    }

    private String etag(String namespace, List<String> versions) {
        String value = namespace + "|" + String.join("|", versions);
        UUID hash = UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8));
        return "\"" + namespace + "-" + hash + "\"";
    }
}
