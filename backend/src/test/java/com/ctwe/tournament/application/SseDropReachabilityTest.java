package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * P4 SSE PROOF GATE — is a silently dropped staff event REACHABLE, or only theoretical?
 *
 * <p>{@link CardEventPublisher} writes every event from ONE bounded writer thread under
 * {@link ThreadPoolExecutor.DiscardOldestPolicy}. That policy is sound for change HINTS, where a
 * newer event supersedes an older one — but {@code result} events carry {@code changedPairings}
 * DELTAS, and a discarded delta is data, not a stale hint.
 *
 * <p>These tests reproduce the discard with production's exact policy (one thread, bounded queue,
 * DiscardOldestPolicy) at a miniature queue depth so the reproduction is deterministic. Production
 * ships a depth of 4096, so the scale differs; the FAILURE MODE does not. One stalled socket is
 * enough to hold the single writer thread, and everything queued behind it belongs to every other
 * subscriber too.
 *
 * <p>The decisive assertion is not merely that events are lost — it is that the surviving stream is
 * never told. No exception reaches the emitter, nothing completes it, so the browser's EventSource
 * never reconnects and never re-reads. See the frontend counterpart in
 * {@code sse-gap-recovery.test.ts}.
 */
class SseDropReachabilityTest {

    /** Miniature stand-in for production's 4096. Small enough to overflow deterministically. */
    private static final int QUEUE_DEPTH = 2;
    private static final int PUBLISHED = 8;

    @Test
    @DisplayName("a stalled writer silently discards result events while the stream stays healthy")
    void stalledWriterDiscardsResultEventsSilently() throws Exception {
        UUID cardId = UUID.randomUUID();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch occupied = new CountDownLatch(1);

        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(QUEUE_DEPTH),
            runnable -> {
                Thread thread = new Thread(runnable, "sse-send-test");
                thread.setDaemon(true);
                return thread;
            },
            new ThreadPoolExecutor.DiscardOldestPolicy());

        RecordingEmitter emitter = new RecordingEmitter();
        CardEventPublisher publisher = new CardEventPublisher(8, 8, executor) {
            @Override SseEmitter createEmitter() { return emitter; }
        };

        publisher.subscribe(cardId, () -> 10);
        // Let the "connected" event drain before the stall, so it cannot confuse the counts.
        waitUntil(() -> emitter.versions().size() == 1);

        // Stall the single writer thread — one slow socket is all production needs.
        executor.execute(() -> {
            occupied.countDown();
            try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        });
        assertThat(occupied.await(5, TimeUnit.SECONDS)).isTrue();

        // Every one of these is a PERSISTED result. The DB now holds all of them.
        for (int version = 11; version < 11 + PUBLISHED; version++)
            publisher.publishResult(cardId, new CardDtos.ResultPatch(version, List.of()));

        release.countDown();
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();

        List<Long> delivered = emitter.versions().stream().skip(1).toList();

        assertThat(delivered)
            .as("with a stalled writer the queue overflows and DiscardOldestPolicy drops events")
            .hasSizeLessThan(PUBLISHED);

        assertThat(emitter.completed)
            .as("THE DANGEROUS PART: the stream is never completed, so EventSource never reconnects")
            .isFalse();
        assertThat(emitter.failed)
            .as("and no error reaches the client either — the loss is entirely silent")
            .isFalse();

        // What B actually observes: a jump, not a sequence. Nothing in the payload marks the hole.
        long highest = delivered.get(delivered.size() - 1);
        assertThat(highest).isEqualTo(11 + PUBLISHED - 1);
        assertThat(delivered).doesNotContainSequence(11L, 12L, 13L, 14L, 15L, 16L, 17L, 18L);
    }

    /**
     * The first run of this test asserted a gap BETWEEN delivered events and failed: the writer
     * delivered {@code [17, 18]}, which is trivially contiguous. The measurement corrected the
     * assertion. Six of eight persisted results were discarded outright, so the hole is not inside
     * the delivered run — it is between what the subscriber already KNEW (version 10 at subscribe)
     * and the first event it is handed (17). That is exactly the predicate the viewer client guards
     * with ("apply exactly known + 1, otherwise resync") and exactly the predicate the staff client
     * does not check at all.
     */
    @Test
    @DisplayName("the first delivered version is not known+1 — the subscriber is handed a hole")
    void firstDeliveredVersionSkipsPastTheSubscribersKnownVersion() throws Exception {
        UUID cardId = UUID.randomUUID();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch occupied = new CountDownLatch(1);

        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(QUEUE_DEPTH),
            runnable -> { Thread t = new Thread(runnable, "sse-send-test"); t.setDaemon(true); return t; },
            new ThreadPoolExecutor.DiscardOldestPolicy());

        RecordingEmitter emitter = new RecordingEmitter();
        CardEventPublisher publisher = new CardEventPublisher(8, 8, executor) {
            @Override SseEmitter createEmitter() { return emitter; }
        };
        publisher.subscribe(cardId, () -> 10);
        waitUntil(() -> emitter.versions().size() == 1);

        executor.execute(() -> {
            occupied.countDown();
            try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        });
        assertThat(occupied.await(5, TimeUnit.SECONDS)).isTrue();

        for (int version = 11; version < 11 + PUBLISHED; version++)
            publisher.publishResult(cardId, new CardDtos.ResultPatch(version, List.of()));

        release.countDown();
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();

        List<Long> delivered = emitter.versions().stream().skip(1).toList();
        assertThat(delivered).as("the stall must drop something, or there is nothing to prove")
            .isNotEmpty().hasSizeLessThan(PUBLISHED);

        long knownAtSubscribe = 10L;
        assertThat(delivered.get(0))
            .as("subscriber knew %d; the next result it is handed is %s — versions %d..%d are gone "
                + "and nothing on the wire says so", knownAtSubscribe, delivered.get(0),
                knownAtSubscribe + 1, delivered.get(0) - 1)
            .isGreaterThan(knownAtSubscribe + 1);

        // Every version in the hole was PERSISTED. This is the set B never learns about.
        List<Long> lost = new ArrayList<>();
        for (long version = knownAtSubscribe + 1; version < 11 + PUBLISHED; version++)
            if (!delivered.contains(version)) lost.add(version);
        assertThat(lost).as("persisted result versions never delivered to a healthy stream")
            .isNotEmpty();
    }

    private static void waitUntil(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(10);
    }

    private static final class RecordingEmitter extends SseEmitter {
        private final List<Long> versions = new ArrayList<>();
        volatile boolean completed = false;
        volatile boolean failed = false;

        @Override
        public synchronized void send(SseEventBuilder builder) throws IOException {
            for (ResponseBodyEmitter.DataWithMediaType part : builder.build()) {
                Object data = part.getData();
                if (data instanceof CardEventPublisher.ResultChangeEvent event) versions.add(event.version());
                else if (data instanceof CardEventPublisher.CardChangeEvent event) versions.add(event.version());
            }
        }

        @Override public void complete() { completed = true; super.complete(); }
        @Override public void completeWithError(Throwable error) { failed = true; super.completeWithError(error); }

        synchronized List<Long> versions() { return List.copyOf(versions); }
    }
}
