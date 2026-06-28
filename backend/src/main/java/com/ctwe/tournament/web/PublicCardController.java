package com.ctwe.tournament.web;

import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TournamentArchiveService;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

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
    private final TournamentArchiveService archives;

    public PublicCardController(PublicCardQueryService cards, TournamentArchiveService archives) {
        this.cards = cards;
        this.archives = archives;
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

    @GetMapping("/archives")
    public ResponseEntity<List<TenantDtos.ArchiveSummary>> archives(HttpServletRequest request) {
        List<TenantDtos.ArchiveSummary> body = archives.list();
        return cached(request, body, etag("archives", body.stream()
            .map(archive -> archive.id() + ":" + archive.archivedAt()).toList()), "public-archives");
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
