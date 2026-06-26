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

@Service
public class CardEventPublisher {
    private static final long STREAM_TIMEOUT_MS = 30 * 60 * 1000L;

    private final Map<UUID, CopyOnWriteArrayList<SseEmitter>> emitters = new ConcurrentHashMap<>();

    public SseEmitter subscribe(UUID cardId) {
        SseEmitter emitter = new SseEmitter(STREAM_TIMEOUT_MS);
        emitters.computeIfAbsent(cardId, ignored -> new CopyOnWriteArrayList<>()).add(emitter);

        Runnable remove = () -> remove(cardId, emitter);
        emitter.onCompletion(remove);
        emitter.onTimeout(() -> {
            remove.run();
            emitter.complete();
        });
        emitter.onError(error -> remove.run());

        send(cardId, emitter, "connected", new CardChangeEvent(cardId, 0, Instant.now()));
        return emitter;
    }

    public void publish(CardDtos.CardResponse card) {
        publish(card.id(), card.version());
    }

    public void publish(UUID cardId, long version) {
        List<SseEmitter> cardEmitters = emitters.get(cardId);
        if (cardEmitters == null || cardEmitters.isEmpty()) return;

        CardChangeEvent event = new CardChangeEvent(cardId, version, Instant.now());
        for (SseEmitter emitter : cardEmitters) send(cardId, emitter, "card", event);
    }

    private void send(UUID cardId, SseEmitter emitter, String name, CardChangeEvent event) {
        try {
            emitter.send(SseEmitter.event()
                .name(name)
                .id(Long.toString(event.version()))
                .reconnectTime(2_000)
                .data(event));
        } catch (IOException | IllegalStateException error) {
            remove(cardId, emitter);
        }
    }

    private void remove(UUID cardId, SseEmitter emitter) {
        CopyOnWriteArrayList<SseEmitter> cardEmitters = emitters.get(cardId);
        if (cardEmitters == null) return;
        cardEmitters.remove(emitter);
        if (cardEmitters.isEmpty()) emitters.remove(cardId, cardEmitters);
    }

    public record CardChangeEvent(UUID cardId, long version, Instant updatedAt) {}
}
