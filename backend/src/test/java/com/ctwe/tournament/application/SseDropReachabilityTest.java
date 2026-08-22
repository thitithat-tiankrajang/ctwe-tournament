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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * P4 SSE PROOF GATE — overflow behaviour of the staff stream, before and after fix B.
 *
 * <p>{@link CardEventPublisher} writes every event from ONE bounded writer thread. The original
 * {@code DiscardOldestPolicy} was sound for change HINTS, where a newer event supersedes an older
 * one — but {@code result} events carry {@code changedPairings} DELTAS, and a discarded delta is
 * data. Worse, the discard was silent: the stream stayed open, so EventSource never reconnected, and
 * the server never reads {@code Last-Event-ID}, so nothing replayed the hole.
 *
 * <p>These tests use the REAL executor factory ({@link CardEventPublisher#newSendExecutor(int)}) at
 * a small queue depth, so they exercise production's actual rejection policy rather than a
 * look-alike. Production ships a depth of 4096, but the trigger is not volume — one stalled socket
 * holds the single writer thread, and everything queued behind it belongs to every other subscriber.
 *
 * <p>Fix B does not stop the drop; it stops the SILENCE. An overflowed delta is downgraded to a
 * supersedable card-level hint carrying the authoritative version, which is exactly what the clients
 * already know how to act on. Frontend counterpart: {@code sse-gap-recovery.test.ts}.
 */
class SseDropReachabilityTest {

    private static final int QUEUE_DEPTH = 2;
    private static final int PUBLISHED = 8;
    private static final long KNOWN_AT_SUBSCRIBE = 10L;

    /** A publisher whose writer thread can be stalled on demand, plus the stream it feeds. */
    private record Rig(CardEventPublisher publisher, RecordingEmitter emitter, ExecutorService executor,
                       AtomicLong authoritativeVersion, CountDownLatch release) {}

    private Rig stalledRig(UUID cardId) throws Exception {
        ExecutorService executor = CardEventPublisher.newSendExecutor(QUEUE_DEPTH);
        RecordingEmitter emitter = new RecordingEmitter();
        AtomicLong version = new AtomicLong(KNOWN_AT_SUBSCRIBE);
        CardEventPublisher publisher = new CardEventPublisher(8, 8, executor) {
            @Override SseEmitter createEmitter() { return emitter; }
        };
        publisher.subscribe(cardId, version::get);
        waitUntil(() -> emitter.versions().size() == 1);

        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch occupied = new CountDownLatch(1);
        executor.execute(() -> {
            occupied.countDown();
            try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        });
        assertThat(occupied.await(5, TimeUnit.SECONDS)).isTrue();
        return new Rig(publisher, emitter, executor, version, release);
    }

    /** Persist PUBLISHED results while the writer is stalled, then let the queue drain. */
    private void publishBurstAndDrain(Rig rig, UUID cardId) throws Exception {
        for (int i = 0; i < PUBLISHED; i++) {
            long version = rig.authoritativeVersion().incrementAndGet();
            rig.publisher().publishResult(cardId, new CardDtos.ResultPatch(version, List.of()), "writer", List.of("ROLE_DIRECTOR"));
        }
        rig.release().countDown();
        waitUntil(() -> ((java.util.concurrent.ThreadPoolExecutor) rig.executor()).getQueue().isEmpty());
        Thread.sleep(100);
    }

    @Test
    @DisplayName("a stalled writer still drops result events — the delta itself is not recoverable")
    void stalledWriterDropsResultEvents() throws Exception {
        UUID cardId = UUID.randomUUID();
        Rig rig = stalledRig(cardId);
        try {
            publishBurstAndDrain(rig, cardId);

            List<Long> delivered = rig.emitter().resultVersions();
            assertThat(delivered).as("the stall must drop something, or there is nothing to prove")
                .hasSizeLessThan(PUBLISHED);

            List<Long> lost = new ArrayList<>();
            for (long v = KNOWN_AT_SUBSCRIBE + 1; v <= KNOWN_AT_SUBSCRIBE + PUBLISHED; v++)
                if (!delivered.contains(v)) lost.add(v);
            assertThat(lost).as("persisted result versions never delivered").isNotEmpty();

            assertThat(rig.emitter().completed)
                .as("the stream stays open — so EventSource does not reconnect on its own").isFalse();
            assertThat(rig.emitter().failed).as("and no error reaches the client").isFalse();
        } finally {
            rig.executor().shutdownNow();
        }
    }

    @Test
    @DisplayName("FIX B: every dropped delta leaves the stream owed a resync hint")
    void droppedDeltaRecordsResyncDebt() throws Exception {
        UUID cardId = UUID.randomUUID();
        Rig rig = stalledRig(cardId);
        try {
            publishBurstAndDrain(rig, cardId);

            assertThat(rig.publisher().owedResyncCount())
                .as("a stream that missed a persisted result must be owed exactly one hint")
                .isEqualTo(1);
        } finally {
            rig.executor().shutdownNow();
        }
    }

    @Test
    @DisplayName("FIX B: the hint carries the authoritative version, so the client cannot stay stale")
    void resyncHintCarriesAuthoritativeVersionAndClearsTheDebt() throws Exception {
        UUID cardId = UUID.randomUUID();
        Rig rig = stalledRig(cardId);
        try {
            publishBurstAndDrain(rig, cardId);
            assertThat(rig.publisher().owedResyncCount()).isEqualTo(1);

            rig.publisher().flushResyncDebt();
            waitUntil(() -> rig.publisher().owedResyncCount() == 0);

            assertThat(rig.publisher().owedResyncCount())
                .as("the debt clears only once the hint has actually been written").isZero();

            List<String> names = rig.emitter().names();
            assertThat(names).as("the downgrade is a card-level hint, not another delta")
                .contains("card");

            long authoritative = rig.authoritativeVersion().get();
            assertThat(rig.emitter().versionOfLast("card"))
                .as("the hint must carry the CURRENT version so the client can compare it with its own")
                .isEqualTo(authoritative);
            assertThat(authoritative).isGreaterThan(KNOWN_AT_SUBSCRIBE);

            // This is what makes the client safe: use-card-sync.ts's `card` handler refetches
            // whenever the hint's version exceeds what it holds, and the client's version could not
            // have advanced past the last delta it actually received.
            long highestDelivered = rig.emitter().resultVersions().stream().mapToLong(Long::longValue)
                .max().orElse(KNOWN_AT_SUBSCRIBE);
            assertThat(rig.emitter().versionOfLast("card"))
                .as("hint %s must exceed the client's best-case version %s, or it would be ignored",
                    rig.emitter().versionOfLast("card"), highestDelivered)
                .isGreaterThanOrEqualTo(highestDelivered);
        } finally {
            rig.executor().shutdownNow();
        }
    }

    @Test
    @DisplayName("FIX B: a healthy stream is never owed anything — no hint traffic in normal operation")
    void healthyStreamAccruesNoDebt() throws Exception {
        UUID cardId = UUID.randomUUID();
        ExecutorService executor = CardEventPublisher.newSendExecutor(QUEUE_DEPTH);
        RecordingEmitter emitter = new RecordingEmitter();
        AtomicLong version = new AtomicLong(KNOWN_AT_SUBSCRIBE);
        CardEventPublisher publisher = new CardEventPublisher(8, 8, executor) {
            @Override SseEmitter createEmitter() { return emitter; }
        };
        try {
            publisher.subscribe(cardId, version::get);
            for (int i = 0; i < PUBLISHED; i++) {
                publisher.publishResult(cardId, new CardDtos.ResultPatch(version.incrementAndGet(), List.of()), "writer", List.of("ROLE_DIRECTOR"));
                Thread.sleep(5); // no stall: the writer keeps up
            }
            waitUntil(() -> emitter.resultVersions().size() == PUBLISHED);

            assertThat(emitter.resultVersions()).as("nothing dropped on the healthy path")
                .hasSize(PUBLISHED);
            assertThat(publisher.owedResyncCount()).as("and therefore nothing owed").isZero();

            publisher.flushResyncDebt();
            assertThat(emitter.names()).as("no hint is sent when nothing was missed")
                .doesNotContain("card");
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("FIX B: a stream that has gone away owes nothing — reconnect is the stronger recovery")
    void deadStreamDropsItsDebt() throws Exception {
        UUID cardId = UUID.randomUUID();
        Rig rig = stalledRig(cardId);
        try {
            publishBurstAndDrain(rig, cardId);
            assertThat(rig.publisher().owedResyncCount()).isEqualTo(1);

            rig.emitter().dead = true;      // the socket dies before the hint goes out
            rig.publisher().flushResyncDebt();
            waitUntil(() -> rig.publisher().owedResyncCount() == 0);

            assertThat(rig.publisher().owedResyncCount())
                .as("remove() drops the debt: the browser reconnects and `connected` resyncs it")
                .isZero();
        } finally {
            rig.executor().shutdownNow();
        }
    }

    private static void waitUntil(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(10);
    }

    private static final class RecordingEmitter extends SseEmitter {
        private final List<Long> versions = new ArrayList<>();
        private final List<String> names = new ArrayList<>();
        volatile boolean completed = false;
        volatile boolean failed = false;
        volatile boolean dead = false;

        @Override
        public synchronized void send(SseEventBuilder builder) throws IOException {
            if (dead) throw new IOException("connection dead");
            String name = null;
            Long version = null;
            for (ResponseBodyEmitter.DataWithMediaType part : builder.build()) {
                Object data = part.getData();
                if (data instanceof CardEventPublisher.StaffResultChangeEvent event) { name = "result"; version = event.version(); }
                else if (data instanceof CardEventPublisher.CardChangeEvent event) { version = event.version(); }
                // The builder emits its metadata as one String: "event:<name>\nid:<n>\nretry:<ms>\ndata:".
                else if (data instanceof String text && text.startsWith("event:"))
                    name = text.substring(6).split("\n", 2)[0].trim();
            }
            if (version == null) return;
            names.add(name == null ? "card" : name);
            versions.add(version);
        }

        @Override public void complete() { completed = true; super.complete(); }
        @Override public void completeWithError(Throwable error) { failed = true; super.completeWithError(error); }

        synchronized List<Long> versions() { return List.copyOf(versions); }
        synchronized List<String> names() { return List.copyOf(names); }

        synchronized List<Long> resultVersions() {
            List<Long> out = new ArrayList<>();
            for (int i = 0; i < names.size(); i++) if ("result".equals(names.get(i))) out.add(versions.get(i));
            return out;
        }

        synchronized Long versionOfLast(String name) {
            for (int i = names.size() - 1; i >= 0; i--) if (name.equals(names.get(i))) return versions.get(i);
            return null;
        }
    }
}
