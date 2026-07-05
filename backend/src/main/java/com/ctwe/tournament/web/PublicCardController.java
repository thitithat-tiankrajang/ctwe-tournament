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
import java.util.List;
import java.util.UUID;

/**
 * Anonymous-only read model. These responses are identical for every viewer and are the only API
 * responses that may be shared-cached (browser today; any CDN placed in front honors s-maxage).
 */
@RestController
@RequestMapping("/api/public")
public class PublicCardController {
    /** Unversioned reads stay near-live; SSE (not cache expiry) is what drives refreshes. */
    private static final String LIVE_POLICY = "public, max-age=2, s-maxage=5, stale-while-revalidate=10";
    /** A public_version-qualified card URL is one immutable representation: cache it forever. */
    private static final String IMMUTABLE_POLICY = "public, max-age=31536000, immutable";
    /** Sync strategy knobs may lag a minute for new page loads; saves one request per reload. */
    private static final String CONFIG_POLICY = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

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
            .map(card -> card.id() + ":" + card.version()).toList()), LIVE_POLICY);
    }

    @GetMapping("/cards/versions")
    public ResponseEntity<List<PublicCardDtos.CardVersion>> versions(HttpServletRequest request) {
        List<PublicCardDtos.CardVersion> body = cards.versions();
        return cached(request, body, etag("versions", body.stream()
            .map(card -> card.id() + ":" + card.version()).toList()), LIVE_POLICY);
    }

    @GetMapping("/cards/{cardId}")
    public ResponseEntity<CardDtos.CardResponse> card(@PathVariable UUID cardId, HttpServletRequest request) {
        CardDtos.CardResponse body = cards.get(cardId);
        boolean versioned = Long.toString(body.version()).equals(request.getParameter("v"));
        return cached(request, body, "\"card-" + cardId + "-v" + body.version() + "\"",
            versioned ? IMMUTABLE_POLICY : LIVE_POLICY);
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
            body.pollingIntervalMs() + "", body.reconnectDelayMs() + "")), CONFIG_POLICY);
    }

    private <T> ResponseEntity<T> cached(
        HttpServletRequest request, T body, String etag, String cachePolicy
    ) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.CACHE_CONTROL, cachePolicy);
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
