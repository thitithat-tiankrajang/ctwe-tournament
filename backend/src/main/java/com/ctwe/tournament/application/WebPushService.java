package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.PushDtos;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import nl.martijndwars.webpush.Notification;
import nl.martijndwars.webpush.PushService;
import nl.martijndwars.webpush.Urgency;
import nl.martijndwars.webpush.Utils;
import org.apache.http.HttpResponse;
import org.apache.http.util.EntityUtils;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Security;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Standards-based Web Push fan-out. A browser endpoint is an opaque delivery credential: the
 * application stores no viewer identity, sends only publication events, and removes dead endpoints.
 */
@Service
public class WebPushService {
    private static final Logger log = LoggerFactory.getLogger(WebPushService.class);
    private static final int TTL_SECONDS = 6 * 60 * 60;
    private static final List<String> DEFAULT_ALLOWED_HOSTS = List.of(
        "fcm.googleapis.com",
        "push.services.mozilla.com",
        "updates.push.services.mozilla.com",
        "push.apple.com",
        "notify.windows.com"
    );

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private volatile String publicKey;
    private volatile PushService sender;
    private final String configuredPrivateKey;
    private final String subject;
    private final List<String> allowedHostSuffixes;
    private final ThreadPoolExecutor executor;

    public WebPushService(
        JdbcTemplate jdbc,
        ObjectMapper objectMapper,
        @Value("${app.push.vapid-public-key:}") String publicKey,
        @Value("${app.push.vapid-private-key:}") String privateKey,
        @Value("${app.push.vapid-subject:}") String subject,
        @Value("${app.push.allowed-host-suffixes:}") String configuredHosts
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.publicKey = publicKey.trim();
        this.configuredPrivateKey = privateKey.trim();
        this.subject = subject.isBlank() ? "mailto:admin@localhost" : subject.trim();
        this.allowedHostSuffixes = configuredHosts.isBlank()
            ? DEFAULT_ALLOWED_HOSTS
            : java.util.Arrays.stream(configuredHosts.split(","))
                .map(value -> value.trim().toLowerCase(Locale.ROOT))
                .filter(value -> !value.isBlank())
                .toList();
        this.executor = new ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(10_000), runnable -> {
                Thread thread = new Thread(runnable, "web-push-send");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.DiscardOldestPolicy());
        this.executor.allowCoreThreadTimeOut(true);

        if (this.publicKey.isBlank() != this.configuredPrivateKey.isBlank())
            throw new IllegalStateException("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together");
    }

    public PushDtos.ConfigResponse config() {
        boolean enabled = ensureSender();
        return new PushDtos.ConfigResponse(enabled, enabled ? publicKey : null);
    }

    @Transactional
    public void subscribe(PushDtos.SubscribeRequest request) {
        requireEnabled();
        validateEndpoint(request.subscription().endpoint());
        requireOpenScope(request.scopeType(), request.scopeId());
        String hash = endpointHash(request.subscription().endpoint());
        ensureScopeLimit(hash, request.scopeType(), request.scopeId());

        // A browser may rotate its encryption keys without changing its endpoint. Keep all scopes
        // for that endpoint usable, then upsert the scope selected on this page.
        jdbc.update("""
            UPDATE web_push_subscriptions
            SET endpoint = ?, p256dh = ?, auth_secret = ?, expiration_time = ?, last_seen_at = now()
            WHERE endpoint_hash = ?
            """, request.subscription().endpoint(), request.subscription().keys().p256dh(),
            request.subscription().keys().auth(), request.subscription().expirationTime(), hash);
        insertScope(hash, request.subscription(), request.scopeType(), request.scopeId());
    }

    @Transactional
    public void unsubscribe(PushDtos.UnsubscribeRequest request) {
        String hash = endpointHash(request.endpoint());
        if (request.scopeType() == PushDtos.ScopeType.CARD)
            jdbc.update("DELETE FROM web_push_subscriptions WHERE endpoint_hash = ? AND card_id = ?", hash, request.scopeId());
        else
            jdbc.update("DELETE FROM web_push_subscriptions WHERE endpoint_hash = ? AND tournament_id = ?", hash, request.scopeId());
    }

    @Transactional
    public void refresh(PushDtos.RefreshRequest request) {
        requireEnabled();
        validateEndpoint(request.subscription().endpoint());
        String oldHash = endpointHash(request.oldEndpoint());
        List<Scope> scopes = jdbc.query("""
            SELECT card_id, tournament_id FROM web_push_subscriptions WHERE endpoint_hash = ?
            """, (rs, row) -> new Scope(
                rs.getObject("card_id", UUID.class),
                rs.getObject("tournament_id", UUID.class)
            ), oldHash);
        if (scopes.isEmpty()) return;

        jdbc.update("DELETE FROM web_push_subscriptions WHERE endpoint_hash = ?", oldHash);
        String newHash = endpointHash(request.subscription().endpoint());
        for (Scope scope : scopes) {
            PushDtos.ScopeType type = scope.cardId() != null ? PushDtos.ScopeType.CARD : PushDtos.ScopeType.TOURNAMENT;
            insertScope(newHash, request.subscription(), type, scope.cardId() != null ? scope.cardId() : scope.tournamentId());
        }
    }

    public void pairingPublished(UUID cardId, int game) {
        publish(cardId, "PAIRING", game,
            "Pairing เกม " + game + " พร้อมแล้ว",
            card -> card.label() + " — เปิดดูคู่แข่งขัน");
    }

    public void rankingPublished(UUID cardId, int gameFrom, int gameTo) {
        String games = gameFrom == gameTo ? Integer.toString(gameTo) : gameFrom + "–" + gameTo;
        publish(cardId, "RANKING", gameTo,
            "Ranking เกม " + games + " เผยแพร่แล้ว",
            card -> card.label() + " — เปิดดูอันดับล่าสุด");
    }

    public void finalStarted(UUID cardId) {
        publish(cardId, "FINAL_STARTED", 0,
            "รอบชิงเริ่มแล้ว",
            card -> card.label() + " — เปิดดูการแข่งขันรอบชิง");
    }

    public void competitionCompleted(UUID cardId) {
        publish(cardId, "COMPLETED", 0,
            "ยินดีกับผู้ชนะ 🏆",
            card -> {
                String winner = winnerName(card.id());
                return winner == null
                    ? card.label() + " จบการแข่งขันและประกาศผลครบแล้ว"
                    : winner + " คว้าอันดับ 1 · " + card.label();
            });
    }

    private void publish(UUID cardId, String eventType, int game, String title,
                         java.util.function.Function<CardInfo, String> body) {
        if (!ensureSender()) return;
        try {
            executor.execute(() -> deliver(cardId, eventType, game, title, body));
        } catch (RejectedExecutionException ignored) {
            // Publication itself must never fail because a push queue is saturated.
        }
    }

    private void deliver(UUID cardId, String eventType, int game, String title,
                         java.util.function.Function<CardInfo, String> bodyFactory) {
        CardInfo card;
        try {
            card = jdbc.queryForObject("""
                SELECT c.id, c.tournament_id, c.name, c.division
                FROM tournament_cards c
                JOIN tournaments t ON t.id = c.tournament_id
                WHERE c.id = ? AND t.status = 'OPEN'
                """, (rs, row) -> new CardInfo(
                rs.getObject("id", UUID.class), rs.getObject("tournament_id", UUID.class),
                rs.getString("name"), rs.getString("division")), cardId);
        } catch (EmptyResultDataAccessException missing) {
            return;
        }
        List<Target> targets = jdbc.query("""
            SELECT DISTINCT ON (s.endpoint_hash)
                   s.endpoint_hash, s.endpoint, s.p256dh, s.auth_secret
            FROM web_push_subscriptions s
            WHERE s.card_id = ? OR s.tournament_id = ?
            ORDER BY s.endpoint_hash, s.last_seen_at DESC
            """, (rs, row) -> new Target(
            rs.getString("endpoint_hash"), rs.getString("endpoint"),
            rs.getString("p256dh"), rs.getString("auth_secret")), cardId, card.tournamentId());
        if (targets.isEmpty()) return;

        String payload;
        try {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("title", title);
            data.put("body", bodyFactory.apply(card));
            data.put("tag", "ctwe-" + cardId + "-" + eventType.toLowerCase(Locale.ROOT) + (game > 0 ? "-" + game : ""));
            data.put("url", "/cards/" + cardId);
            data.put("eventType", eventType);
            payload = objectMapper.writeValueAsString(data);
        } catch (JsonProcessingException impossible) {
            return;
        }
        for (Target target : targets) {
            try {
                executor.execute(() -> send(target, payload));
            } catch (RejectedExecutionException ignored) {
                // The publication remains authoritative; push delivery is best effort under overload.
            }
        }
    }

    private void send(Target target, String payload) {
        try {
            validateEndpoint(target.endpoint());
            Notification notification = Notification.builder()
                .endpoint(target.endpoint())
                .userPublicKey(target.p256dh())
                .userAuth(target.auth())
                .payload(payload)
                .ttl(TTL_SECONDS)
                .urgency(Urgency.NORMAL)
                .build();
            HttpResponse response = sender.send(notification);
            try {
                int status = response.getStatusLine().getStatusCode();
                if (status == 404 || status == 410)
                    jdbc.update("DELETE FROM web_push_subscriptions WHERE endpoint_hash = ?", target.hash());
                else if (status < 200 || status >= 300)
                    log.warn("Web Push delivery rejected with status {}", status);
            } finally {
                EntityUtils.consumeQuietly(response.getEntity());
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            // Endpoint and keys are deliberately never logged.
            log.warn("Web Push delivery failed: {}", error.getClass().getSimpleName());
        }
    }

    private String winnerName(UUID cardId) {
        List<String> finalWinner = jdbc.queryForList("""
            SELECT trim(p.first_name || ' ' || p.last_name)
            FROM final_pairings fp
            JOIN players p ON p.card_id = fp.card_id AND p.code = fp.winner
            WHERE fp.card_id = ? AND fp.slot = 0 AND fp.winner IS NOT NULL
            """, String.class, cardId);
        if (!finalWinner.isEmpty()) return finalWinner.get(0);
        List<String> rankingWinner = jdbc.queryForList("""
            SELECT trim(p.first_name || ' ' || p.last_name)
            FROM standings s
            JOIN players p ON p.card_id = s.card_id AND p.code = s.player_code
            WHERE s.card_id = ?
            ORDER BY s.rank NULLS LAST, s.win_points DESC, s.diff DESC, p.code
            LIMIT 1
            """, String.class, cardId);
        return rankingWinner.isEmpty() ? null : rankingWinner.get(0);
    }

    private void insertScope(String hash, PushDtos.Subscription subscription,
                             PushDtos.ScopeType type, UUID scopeId) {
        if (type == PushDtos.ScopeType.CARD) {
            jdbc.update("""
                INSERT INTO web_push_subscriptions
                  (endpoint_hash, endpoint, p256dh, auth_secret, expiration_time, card_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (endpoint_hash, card_id) WHERE card_id IS NOT NULL
                DO UPDATE SET endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh,
                  auth_secret = EXCLUDED.auth_secret, expiration_time = EXCLUDED.expiration_time,
                  last_seen_at = now()
                """, hash, subscription.endpoint(), subscription.keys().p256dh(),
                subscription.keys().auth(), subscription.expirationTime(), scopeId);
        } else {
            jdbc.update("""
                INSERT INTO web_push_subscriptions
                  (endpoint_hash, endpoint, p256dh, auth_secret, expiration_time, tournament_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (endpoint_hash, tournament_id) WHERE tournament_id IS NOT NULL
                DO UPDATE SET endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh,
                  auth_secret = EXCLUDED.auth_secret, expiration_time = EXCLUDED.expiration_time,
                  last_seen_at = now()
                """, hash, subscription.endpoint(), subscription.keys().p256dh(),
                subscription.keys().auth(), subscription.expirationTime(), scopeId);
        }
    }

    private void requireOpenScope(PushDtos.ScopeType type, UUID id) {
        Long count = type == PushDtos.ScopeType.CARD
            ? jdbc.queryForObject("""
                SELECT count(*) FROM tournament_cards c
                JOIN tournaments t ON t.id = c.tournament_id
                WHERE c.id = ? AND t.status = 'OPEN'
                """, Long.class, id)
            : jdbc.queryForObject(
                "SELECT count(*) FROM tournaments WHERE id = ? AND status = 'OPEN'", Long.class, id);
        if (count == null || count == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Notification scope not found");
    }

    private void ensureScopeLimit(String endpointHash, PushDtos.ScopeType type, UUID scopeId) {
        Long existing = type == PushDtos.ScopeType.CARD
            ? jdbc.queryForObject("""
                SELECT count(*) FROM web_push_subscriptions
                WHERE endpoint_hash = ? AND card_id = ?
                """, Long.class, endpointHash, scopeId)
            : jdbc.queryForObject("""
                SELECT count(*) FROM web_push_subscriptions
                WHERE endpoint_hash = ? AND tournament_id = ?
                """, Long.class, endpointHash, scopeId);
        if (existing != null && existing > 0) return;
        Long count = jdbc.queryForObject(
            "SELECT count(*) FROM web_push_subscriptions WHERE endpoint_hash = ?", Long.class, endpointHash);
        if (count != null && count >= 100)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Too many notification scopes");
    }

    private void requireEnabled() {
        if (!ensureSender())
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Web Push is not configured");
    }

    /**
     * Lazily initializes after Flyway has created the fallback table. Environment keys win; when
     * absent, one database-stored pair is generated atomically and shared across app restarts.
     */
    private synchronized boolean ensureSender() {
        if (sender != null) return true;
        try {
            if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null)
                Security.addProvider(new BouncyCastleProvider());
            String privateKey = configuredPrivateKey;
            if (publicKey.isBlank()) {
                List<Map<String, Object>> stored = jdbc.queryForList(
                    "SELECT public_key, private_key FROM web_push_server_keys WHERE singleton = true");
                if (stored.isEmpty()) {
                    KeyPairGenerator generator = KeyPairGenerator.getInstance("ECDH", BouncyCastleProvider.PROVIDER_NAME);
                    generator.initialize(new ECGenParameterSpec("secp256r1"));
                    KeyPair pair = generator.generateKeyPair();
                    String generatedPublic = Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(Utils.encode((org.bouncycastle.jce.interfaces.ECPublicKey) pair.getPublic()));
                    String generatedPrivate = Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(Utils.encode((org.bouncycastle.jce.interfaces.ECPrivateKey) pair.getPrivate()));
                    jdbc.update("""
                        INSERT INTO web_push_server_keys (singleton, public_key, private_key)
                        VALUES (true, ?, ?) ON CONFLICT (singleton) DO NOTHING
                        """, generatedPublic, generatedPrivate);
                    stored = jdbc.queryForList(
                        "SELECT public_key, private_key FROM web_push_server_keys WHERE singleton = true");
                }
                publicKey = String.valueOf(stored.get(0).get("public_key"));
                privateKey = String.valueOf(stored.get(0).get("private_key"));
            }
            sender = new PushService(publicKey, privateKey, subject);
            return true;
        } catch (Exception error) {
            log.error("Web Push initialization failed: {}", error.getClass().getSimpleName());
            return false;
        }
    }

    private void validateEndpoint(String endpoint) {
        URI uri;
        try {
            uri = URI.create(endpoint);
        } catch (IllegalArgumentException invalid) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid push endpoint");
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        boolean allowed = "https".equalsIgnoreCase(uri.getScheme())
            && uri.getUserInfo() == null
            && uri.getPort() == -1
            && allowedHostSuffixes.stream().anyMatch(suffix ->
                host.equals(suffix) || host.endsWith("." + suffix));
        if (!allowed)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported push service");
    }

    private String endpointHash(String endpoint) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(endpoint.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (GeneralSecurityException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** Remove subscriptions whose browser supplied an explicit expiry time. */
    @Scheduled(fixedDelay = 24 * 60 * 60 * 1000L)
    public void deleteExpired() {
        jdbc.update("""
            DELETE FROM web_push_subscriptions
            WHERE expiration_time IS NOT NULL AND expiration_time < extract(epoch FROM now()) * 1000
            """);
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }

    private record Scope(UUID cardId, UUID tournamentId) {}
    private record Target(String hash, String endpoint, String p256dh, String auth) {}
    private record CardInfo(UUID id, UUID tournamentId, String name, String division) {
        String label() {
            return division == null || division.isBlank() ? name : name + " · " + division;
        }
    }
}
