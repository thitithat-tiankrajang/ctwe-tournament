package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class CardEventPublisherTest {
    @Test
    void registersSubscriberBeforeReadingAuthoritativeVersion() {
        UUID cardId = UUID.randomUUID();
        CapturingEmitter emitter = new CapturingEmitter();
        CardEventPublisher publisher = new CardEventPublisher() {
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
        CardEventPublisher publisher = new CardEventPublisher() {
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
        CardEventPublisher publisher = new CardEventPublisher() {
            @Override SseEmitter createEmitter() { return emitter; }
        };
        publisher.subscribe(cardId, () -> 4);
        var changed = List.of(new CardDtos.PairingResponse(
            UUID.randomUUID().toString(), 2, 7, "P0001", "P0002",
            "P0001", 100, 70, "WIN", 30));

        publisher.publishResult(cardId, new CardDtos.ResultPatch(5, changed));

        assertThat(emitter.resultEvents()).singleElement().satisfies(event -> {
            assertThat(event.cardId()).isEqualTo(cardId);
            assertThat(event.version()).isEqualTo(5);
            assertThat(event.changedPairings()).isSameAs(changed);
        });
    }

    private static CardDtos.CardResponse card(UUID id, long version) {
        return new CardDtos.CardResponse(
            id, UUID.randomUUID(), "Card", "Division", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 1, version,
            List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
            "NONE", 0, null, false, Instant.EPOCH);
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
