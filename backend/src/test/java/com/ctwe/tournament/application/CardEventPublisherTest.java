package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CardEventPublisherTest {
    @Test
    void registersSubscriberBeforeReadingAuthoritativeVersion() {
        UUID cardId = UUID.randomUUID();
        CapturingEmitter emitter = new CapturingEmitter();
        CardEventPublisher publisher = new CardEventPublisher(8, 8, Runnable::run) {
            @Override SseEmitter createEmitter() { return emitter; }
        };

        publisher.subscribe(cardId, () -> {
            publisher.publish(cardId, 11);
            return 12;
        });

        assertThat(emitter.changeEvents()).extracting(CardEventPublisher.CardChangeEvent::version)
            .containsExactly(11L, 12L);
    }

    @Test
    void publishesAuthoritativeCardStateForWorkflowChanges() {
        UUID cardId = UUID.randomUUID();
        CapturingEmitter emitter = new CapturingEmitter();
        CardEventPublisher publisher = new CardEventPublisher(8, 8, Runnable::run) {
            @Override SseEmitter createEmitter() { return emitter; }
        };
        publisher.subscribe(cardId, () -> 4);
        CardDtos.CardResponse card = card(cardId, 5);

        publisher.publish(card);

        assertThat(emitter.stateEvents()).singleElement().satisfies(event -> {
            assertThat(event.cardId()).isEqualTo(cardId);
            assertThat(event.version()).isEqualTo(5);
            assertThat(event.card()).isSameAs(card);
        });
    }

    @Test
    void publishesOnlyTheChangedResultRows() {
        UUID cardId = UUID.randomUUID();
        CapturingEmitter emitter = new CapturingEmitter();
        CardEventPublisher publisher = new CardEventPublisher(8, 8, Runnable::run) {
            @Override SseEmitter createEmitter() { return emitter; }
        };
        publisher.subscribe(cardId, () -> 4);
        var changed = List.of(new CardDtos.PairingResponse(
            UUID.randomUUID().toString(), 2, 7, "P0001", "P0002",
            "P0001", 100, 70, "WIN", 30, false, false, true));

        publisher.publishResult(cardId, new CardDtos.ResultPatch(5, changed));

        assertThat(emitter.resultEvents()).singleElement().satisfies(event -> {
            assertThat(event.cardId()).isEqualTo(cardId);
            assertThat(event.version()).isEqualTo(5);
            assertThat(event.changedPairings()).isSameAs(changed);
        });
    }

    @Test
    void publicSubscribersReceiveOnlyPublicSafeEvents() {
        UUID cardId = UUID.randomUUID();
        CapturingEmitter staffEmitter = new CapturingEmitter();
        CapturingEmitter publicEmitter = new CapturingEmitter();
        AtomicInteger subscriptions = new AtomicInteger();
        CardEventPublisher publisher = new CardEventPublisher(8, 8, Runnable::run) {
            @Override SseEmitter createEmitter() {
                return subscriptions.getAndIncrement() == 0 ? staffEmitter : publicEmitter;
            }
        };
        publisher.subscribe(cardId, () -> 4);
        publisher.subscribePublic(cardId, () -> 4);
        var changed = List.of(new CardDtos.PairingResponse(
            UUID.randomUUID().toString(), 1, 1, "P0001", "P0002",
            "P0001", 100, 70, "WIN", 30, false, false, true));

        publisher.publish(card(cardId, 5));
        publisher.publishResult(cardId, new CardDtos.ResultPatch(5, changed));

        assertThat(publicEmitter.stateEvents()).isEmpty();
        assertThat(publicEmitter.resultEvents()).isEmpty();
        publisher.publishPublicResult(cardId, 6, changed);
        publisher.publishPublic(cardId, 7);

        assertThat(publicEmitter.resultEvents()).singleElement().satisfies(event -> {
            assertThat(event.version()).isEqualTo(6);
            assertThat(event.changedPairings()).isSameAs(changed);
        });
        assertThat(publicEmitter.changeEvents())
            .extracting(CardEventPublisher.CardChangeEvent::version)
            .containsExactly(4L, 7L);
        assertThat(staffEmitter.stateEvents()).hasSize(1);
        assertThat(staffEmitter.resultEvents()).hasSize(1);
    }

    @Test
    void rejectsSubscribersBeyondCapacityAndFreesSlotsWhenAConnectionDies() {
        UUID cardId = UUID.randomUUID();
        FailingEmitter first = new FailingEmitter();
        CardEventPublisher publisher = new CardEventPublisher(8, 1, Runnable::run) {
            @Override SseEmitter createEmitter() { return first; }
        };

        publisher.subscribePublic(cardId, () -> 1);
        assertThatThrownBy(() -> publisher.subscribePublic(cardId, () -> 1))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));

        // The dead connection is pruned on the next send, releasing its capacity slot.
        first.fail = true;
        publisher.publishPublic(cardId, 2);
        publisher.subscribePublic(cardId, () -> 3);
    }

    @Test
    void staffAndPublicCapacityAreIndependent() {
        UUID cardId = UUID.randomUUID();
        CardEventPublisher publisher = new CardEventPublisher(1, 1, Runnable::run) {
            @Override SseEmitter createEmitter() { return new CapturingEmitter(); }
        };

        publisher.subscribe(cardId, () -> 1);
        publisher.subscribePublic(cardId, () -> 1);
        assertThatThrownBy(() -> publisher.subscribe(cardId, () -> 1)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> publisher.subscribePublic(cardId, () -> 1)).isInstanceOf(ResponseStatusException.class);
    }

    private static CardDtos.CardResponse card(UUID id, long version) {
        return new CardDtos.CardResponse(
            id, UUID.randomUUID(), "Card", "Division", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 1, version,
            List.of(), com.ctwe.tournament.domain.model.PairingRuleType.RANDOM,
            List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH, "A");
    }

    private static final class FailingEmitter extends SseEmitter {
        volatile boolean fail = false;

        @Override
        public synchronized void send(SseEventBuilder builder) throws IOException {
            if (fail) throw new IOException("connection dead");
        }
    }

    private static final class CapturingEmitter extends SseEmitter {
        private final List<SseEventBuilder> events = new ArrayList<>();

        @Override
        public synchronized void send(SseEventBuilder builder) throws IOException {
            events.add(builder);
        }

        List<CardEventPublisher.CardChangeEvent> changeEvents() {
            return events.stream()
                .flatMap(event -> event.build().stream())
                .map(ResponseBodyEmitter.DataWithMediaType::getData)
                .filter(CardEventPublisher.CardChangeEvent.class::isInstance)
                .map(CardEventPublisher.CardChangeEvent.class::cast)
                .toList();
        }

        List<CardEventPublisher.CardStateEvent> stateEvents() {
            return events.stream()
                .flatMap(event -> event.build().stream())
                .map(ResponseBodyEmitter.DataWithMediaType::getData)
                .filter(CardEventPublisher.CardStateEvent.class::isInstance)
                .map(CardEventPublisher.CardStateEvent.class::cast)
                .toList();
        }

        List<CardEventPublisher.ResultChangeEvent> resultEvents() {
            return events.stream()
                .flatMap(event -> event.build().stream())
                .map(ResponseBodyEmitter.DataWithMediaType::getData)
                .filter(CardEventPublisher.ResultChangeEvent.class::isInstance)
                .map(CardEventPublisher.ResultChangeEvent.class::cast)
                .toList();
        }
    }
}
