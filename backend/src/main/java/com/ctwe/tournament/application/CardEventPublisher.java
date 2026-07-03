package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * SSE fan-out with event-day safety rails:
 * <ul>
 *   <li><b>Runtime-tunable caps</b> — every live stream holds a Tomcat connection, so unbounded
 *       subscribers would exhaust the connector and freeze mutations for everyone. The caps (and
 *       the SSE on/off switch) come from admin-managed {@link RuntimeSettings} and are evaluated
 *       only when a NEW stream subscribes: lowering a cap never disconnects existing streams.
 *       Over-cap subscribers get 503; both frontends fall back to version polling.</li>
 *   <li><b>Async sends</b> — a single bounded writer thread does all socket writes, so a stalled
 *       viewer connection can never block a staff result-save request thread. Dropped events are
 *       safe: events are invalidation hints and clients reconcile via version checks/polling.</li>
 *   <li><b>Heartbeat</b> — silently dead connections (mobile drops without FIN) are detected and
 *       pruned within one heartbeat interval instead of leaking until the stream timeout.</li>
 * </ul>
 */
@Service
public class CardEventPublisher {
    /** Kept short: the heartbeat prunes dead sockets and healthy clients reconnect transparently. */
    private static final long STREAM_TIMEOUT_MS = 45 * 60 * 1000L;
    /** Fast fixed tick; the actual beat cadence is the runtime-configured heartbeat interval. */
    private static final long HEARTBEAT_TICK_MS = 5_000L;

    private final Map<UUID, CopyOnWriteArrayList<SseEmitter>> emitters = new ConcurrentHashMap<>();
    private final Map<UUID, CopyOnWriteArrayList<SseEmitter>> publicEmitters = new ConcurrentHashMap<>();
    private final AtomicInteger staffStreams = new AtomicInteger();
    private final AtomicInteger publicStreams = new AtomicInteger();
    private final Supplier<RuntimeSettings> settings;
    private final Executor sendExecutor;
    private final ExecutorService ownedExecutor;
    private volatile long lastHeartbeatAt = 0L;

    @Autowired
    public CardEventPublisher(RuntimeSettingsService runtimeSettings) {
        this(runtimeSettings::current, newSendExecutor());
    }

    /** Test convenience: fixed caps, everything else at defaults. */
    CardEventPublisher(int maxStaffStreams, int maxPublicStreams, Executor sendExecutor) {
        this(() -> new RuntimeSettings(true, true, true, maxPublicStreams, maxStaffStreams,
            60_000, 25_000, 2_000, null), sendExecutor);
    }

    CardEventPublisher(Supplier<RuntimeSettings> settings, Executor sendExecutor) {
        this.settings = settings;
        this.sendExecutor = sendExecutor;
        this.ownedExecutor = sendExecutor instanceof ExecutorService service ? service : null;
    }

    private static ExecutorService newSendExecutor() {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(4096),
            runnable -> {
                Thread thread = new Thread(runnable, "sse-send");
                thread.setDaemon(true);
                return thread;
            },
            // Under overload keep the newest events flowing; stale hints are superseded anyway.
            new ThreadPoolExecutor.DiscardOldestPolicy());
        executor.allowCoreThreadTimeOut(true);
        return executor;
    }

    public SseEmitter subscribe(UUID cardId, LongSupplier currentVersion) {
        return subscribe(emitters, cardId, currentVersion);
    }

    /** Public stream carries only public-safe invalidation signals and changed result rows. */
    public SseEmitter subscribePublic(UUID cardId, LongSupplier currentVersion) {
        return subscribe(publicEmitters, cardId, currentVersion);
    }

    private SseEmitter subscribe(
        Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers,
        UUID cardId,
        LongSupplier currentVersion
    ) {
        RuntimeSettings config = settings.get();
        // Both refusals below reject NEW subscribers only — established streams are never touched.
        // A non-200 response permanently stops the browser's EventSource (no retry storm); the
        // client's version polling keeps it up to date without a live stream.
        if (!config.realtimeEnabled() || !config.sseEnabled())
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Live streams are disabled");
        AtomicInteger streams = counterOf(subscribers);
        int max = subscribers == emitters ? config.maxStaffSseConnections() : config.maxPublicSseConnections();
        if (streams.incrementAndGet() > max) {
            streams.decrementAndGet();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Live stream capacity reached");
        }

        SseEmitter emitter;
        try {
            emitter = createEmitter();
            subscribers.computeIfAbsent(cardId, ignored -> new CopyOnWriteArrayList<>()).add(emitter);
        } catch (RuntimeException error) {
            streams.decrementAndGet();
            throw error;
        }

        Runnable remove = () -> remove(subscribers, cardId, emitter);
        emitter.onCompletion(remove);
        emitter.onTimeout(() -> {
            remove.run();
            emitter.complete();
        });
        emitter.onError(error -> remove.run());

        try {
            long version = currentVersion.getAsLong();
            send(subscribers, cardId, emitter, "connected", version, new CardChangeEvent(cardId, version, Instant.now()));
        } catch (RuntimeException error) {
            remove(subscribers, cardId, emitter);
            throw error;
        }
        return emitter;
    }

    SseEmitter createEmitter() {
        return new SseEmitter(STREAM_TIMEOUT_MS);
    }

    public void publish(CardDtos.CardResponse card) {
        List<SseEmitter> cardEmitters = emitters.get(card.id());
        if (cardEmitters == null || cardEmitters.isEmpty()) return;

        CardStateEvent event = new CardStateEvent(card.id(), card.version(), Instant.now(), card);
        for (SseEmitter emitter : cardEmitters) send(emitters, card.id(), emitter, "state", card.version(), event);
    }

    public void publish(UUID cardId, long version) {
        List<SseEmitter> cardEmitters = emitters.get(cardId);
        if (cardEmitters == null || cardEmitters.isEmpty()) return;

        CardChangeEvent event = new CardChangeEvent(cardId, version, Instant.now());
        for (SseEmitter emitter : cardEmitters) send(emitters, cardId, emitter, "card", version, event);
    }

    public void publishResult(UUID cardId, CardDtos.ResultPatch patch) {
        List<SseEmitter> cardEmitters = emitters.get(cardId);
        if (cardEmitters == null || cardEmitters.isEmpty()) return;

        ResultChangeEvent event = new ResultChangeEvent(cardId, patch.version(), Instant.now(), patch.changedPairings());
        for (SseEmitter emitter : cardEmitters) send(emitters, cardId, emitter, "result", patch.version(), event);
    }

    public void publishPublic(UUID cardId, long version) {
        List<SseEmitter> cardEmitters = publicEmitters.get(cardId);
        if (cardEmitters == null || cardEmitters.isEmpty()) return;

        CardChangeEvent event = new CardChangeEvent(cardId, version, Instant.now());
        for (SseEmitter emitter : cardEmitters)
            send(publicEmitters, cardId, emitter, "message", version, event);
    }

    public void publishPublicResult(
        UUID cardId,
        long publicVersion,
        List<CardDtos.PairingResponse> changedPairings
    ) {
        List<SseEmitter> cardEmitters = publicEmitters.get(cardId);
        if (cardEmitters == null || cardEmitters.isEmpty()) return;

        ResultChangeEvent event = new ResultChangeEvent(
            cardId, publicVersion, Instant.now(), changedPairings);
        for (SseEmitter emitter : cardEmitters)
            send(publicEmitters, cardId, emitter, "result", publicVersion, event);
    }

    /**
     * Detects and prunes dead connections; comments are invisible to EventSource handlers.
     * The scheduler ticks fast so the runtime-configured interval applies without a restart.
     */
    @Scheduled(fixedDelay = HEARTBEAT_TICK_MS)
    public void heartbeat() {
        long now = System.currentTimeMillis();
        if (now - lastHeartbeatAt < settings.get().heartbeatIntervalMs()) return;
        lastHeartbeatAt = now;
        heartbeat(emitters);
        heartbeat(publicEmitters);
    }

    public int activeStaffStreams() { return staffStreams.get(); }
    public int activePublicStreams() { return publicStreams.get(); }

    private void heartbeat(Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers) {
        subscribers.forEach((cardId, cardEmitters) -> {
            for (SseEmitter emitter : cardEmitters) {
                enqueue(() -> {
                    try {
                        emitter.send(SseEmitter.event().comment("hb"));
                    } catch (IOException | RuntimeException error) {
                        remove(subscribers, cardId, emitter);
                    }
                });
            }
        });
    }

    private void send(
        Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers,
        UUID cardId,
        SseEmitter emitter,
        String name,
        long version,
        Object event
    ) {
        long reconnectDelay = settings.get().reconnectDelayMs();
        enqueue(() -> {
            try {
                emitter.send(SseEmitter.event()
                    .name(name)
                    .id(Long.toString(version))
                    .reconnectTime(reconnectDelay)
                    .data(event));
            } catch (IOException | RuntimeException error) {
                remove(subscribers, cardId, emitter);
            }
        });
    }

    private void enqueue(Runnable task) {
        try {
            sendExecutor.execute(task);
        } catch (RejectedExecutionException rejected) {
            // Shutting down or saturated: events are hints, clients reconcile via polling.
        }
    }

    private void remove(
        Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers,
        UUID cardId,
        SseEmitter emitter
    ) {
        CopyOnWriteArrayList<SseEmitter> cardEmitters = subscribers.get(cardId);
        if (cardEmitters == null || !cardEmitters.remove(emitter)) return;
        counterOf(subscribers).decrementAndGet();
        if (cardEmitters.isEmpty()) subscribers.remove(cardId, cardEmitters);
    }

    private AtomicInteger counterOf(Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers) {
        return subscribers == emitters ? staffStreams : publicStreams;
    }

    @PreDestroy
    void shutdown() {
        // Close streams first so browsers reconnect promptly to the replacement instance.
        completeAll(emitters);
        completeAll(publicEmitters);
        if (ownedExecutor != null) ownedExecutor.shutdownNow();
    }

    private void completeAll(Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers) {
        subscribers.values().forEach(cardEmitters -> cardEmitters.forEach(emitter -> {
            try { emitter.complete(); } catch (RuntimeException ignored) { /* already closed */ }
        }));
        subscribers.clear();
    }

    public record CardChangeEvent(UUID cardId, long version, Instant updatedAt) {}
    public record CardStateEvent(UUID cardId, long version, Instant updatedAt, CardDtos.CardResponse card) {}
    public record ResultChangeEvent(UUID cardId, long version, Instant updatedAt,
                                    List<CardDtos.PairingResponse> changedPairings) {}
}
