package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.LongSupplier;

@Service
public class CardEventPublisher {
    private static final long STREAM_TIMEOUT_MS = 6 * 60 * 60 * 1000L;

    private final Map<UUID, CopyOnWriteArrayList<SseEmitter>> emitters = new ConcurrentHashMap<>();
    private final Map<UUID, CopyOnWriteArrayList<SseEmitter>> publicEmitters = new ConcurrentHashMap<>();

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
        SseEmitter emitter = createEmitter();
        subscribers.computeIfAbsent(cardId, ignored -> new CopyOnWriteArrayList<>()).add(emitter);

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

    private void send(
        Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers,
        UUID cardId,
        SseEmitter emitter,
        String name,
        long version,
        Object event
    ) {
        try {
            emitter.send(SseEmitter.event()
                .name(name)
                .id(Long.toString(version))
                .reconnectTime(2_000)
                .data(event));
        } catch (IOException | IllegalStateException error) {
            remove(subscribers, cardId, emitter);
        }
    }

    private void remove(
        Map<UUID, CopyOnWriteArrayList<SseEmitter>> subscribers,
        UUID cardId,
        SseEmitter emitter
    ) {
        CopyOnWriteArrayList<SseEmitter> cardEmitters = subscribers.get(cardId);
        if (cardEmitters == null) return;
        cardEmitters.remove(emitter);
        if (cardEmitters.isEmpty()) subscribers.remove(cardId, cardEmitters);
    }

    public record CardChangeEvent(UUID cardId, long version, Instant updatedAt) {}
    public record CardStateEvent(UUID cardId, long version, Instant updatedAt, CardDtos.CardResponse card) {}
    public record ResultChangeEvent(UUID cardId, long version, Instant updatedAt,
                                    List<CardDtos.PairingResponse> changedPairings) {}
}
