package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.web.dto.CardDtos;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Coordination of {@link PublicCardQueryService#reload} in the window the real cache stack cannot
 * pause deterministically: a second caller reaching the repair slot while the first holds it. The
 * cache is stubbed with per-thread scripts and latches (no sleeps); the coordination code is real.
 * The end-to-end duplicate-build race itself is reproduced against real Caffeine in
 * {@code PublicTournamentBundleRevalidationTest}.
 */
class PublicCardQueryServiceRepairTest {
    private static final UUID CARD = UUID.fromString("cccccccc-0000-4000-8000-00000000000c");

    private final PublicCardReadCache cache = mock(PublicCardReadCache.class);
    private final PublicCardQueryService service = new PublicCardQueryService(cache);
    /** Per-thread scripted answers for cache.card(CARD), consumed in order. */
    private final Map<String, java.util.Deque<Script>> scripts = new ConcurrentHashMap<>();

    private interface Script { CardDtos.CardResponse run() throws Exception; }

    private void script(String thread, Script... steps) {
        scripts.put(thread, new java.util.ArrayDeque<>(List.of(steps)));
    }

    private void wire() {
        when(cache.card(any(UUID.class))).thenAnswer(call -> {
            Script next = scripts.get(Thread.currentThread().getName()).poll();
            if (next == null) throw new AssertionError("unscripted cache read on " + Thread.currentThread().getName());
            return next.run();
        });
    }

    @Test
    void failedRepairReleasesWaitersAndLeavesNoEntry() throws Exception {
        String p = UUID.randomUUID() + "-";
        CountDownLatch ownerBuilding = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        script(p + "owner",
            () -> card(1),                                     // first check: stale
            () -> card(1),                                     // recheck in slot: still stale → evict
            () -> { ownerBuilding.countDown(); release.await(); throw new IllegalStateException("db down"); });
        script(p + "waiter",
            () -> card(1),                                     // first check: stale → finds owner's slot
            () -> card(2));                                    // fallback after the owner failed
        wire();

        ExecutorService pool = Executors.newFixedThreadPool(2, named(p));
        Future<CardDtos.CardResponse> owner = pool.submit(() -> service.reload(CARD, 2));
        assertThat(ownerBuilding.await(30, TimeUnit.SECONDS)).isTrue();
        Future<CardDtos.CardResponse> waiter = pool.submit(() -> service.reload(CARD, 2));
        awaitWaiting(p + "waiter");
        release.countDown();

        assertThatThrownBy(() -> owner.get(30, TimeUnit.SECONDS))
            .isInstanceOf(ExecutionException.class).hasCauseInstanceOf(IllegalStateException.class);
        assertThat(waiter.get(30, TimeUnit.SECONDS).version()).as("waiter released, not stranded").isEqualTo(2);
        assertThat(service.repairsInFlight()).as("no permanent failed entry").isZero();
        verify(cache, times(1)).evictCard(CARD);
        pool.shutdownNow();
    }

    @Test
    void waiterReusesTheSharedRepairEvenIfPublicationMovedOnNoRetryLoop() throws Exception {
        String p = UUID.randomUUID() + "-";
        CountDownLatch ownerBuilding = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        script(p + "owner",
            () -> card(1),
            () -> card(1),
            () -> { ownerBuilding.countDown(); release.await(); return card(2); });
        script(p + "waiter",
            () -> card(1));                                    // requires 3; gets the shared v2, no own repair
        wire();

        ExecutorService pool = Executors.newFixedThreadPool(2, named(p));
        Future<CardDtos.CardResponse> owner = pool.submit(() -> service.reload(CARD, 2));
        assertThat(ownerBuilding.await(30, TimeUnit.SECONDS)).isTrue();
        Future<CardDtos.CardResponse> waiter = pool.submit(() -> service.reload(CARD, 3));
        awaitWaiting(p + "waiter");
        release.countDown();

        assertThat(owner.get(30, TimeUnit.SECONDS).version()).isEqualTo(2);
        assertThat(waiter.get(30, TimeUnit.SECONDS).version())
            .as("bounded: the waiter reports what was repaired instead of repairing again").isEqualTo(2);
        verify(cache, times(1)).evictCard(CARD);
        assertThat(service.repairsInFlight()).isZero();
        pool.shutdownNow();
    }

    @Test
    void alreadyRepairedCardIsReturnedWithoutEvicting() {
        script(Thread.currentThread().getName(), () -> card(2));
        wire();

        assertThat(service.reload(CARD, 2).version()).isEqualTo(2);
        verify(cache, times(0)).evictCard(CARD);
    }

    @Test
    void differentCardsRepairIndependently() throws Exception {
        String p = UUID.randomUUID() + "-";
        UUID other = UUID.fromString("dddddddd-0000-4000-8000-00000000000d");
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch building = new CountDownLatch(1);
        AtomicInteger otherReads = new AtomicInteger();
        when(cache.card(any(UUID.class))).thenAnswer(call -> {
            UUID id = call.getArgument(0);
            if (id.equals(other)) { otherReads.incrementAndGet(); return card(other, 2); }
            Script next = scripts.get(Thread.currentThread().getName()).poll();
            return next.run();
        });
        script(p + "owner", () -> card(1), () -> card(1), () -> { building.countDown(); release.await(); return card(2); });

        ExecutorService pool = Executors.newFixedThreadPool(2, named(p));
        Future<CardDtos.CardResponse> slow = pool.submit(() -> service.reload(CARD, 2));
        assertThat(building.await(30, TimeUnit.SECONDS)).isTrue();
        assertThat(service.reload(other, 2).version()).as("an unrelated card is not serialized behind CARD").isEqualTo(2);
        release.countDown();
        assertThat(slow.get(30, TimeUnit.SECONDS).version()).isEqualTo(2);
        pool.shutdownNow();
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private static java.util.concurrent.ThreadFactory named(String prefix) {
        AtomicInteger n = new AtomicInteger();
        return runnable -> new Thread(runnable, prefix + (n.getAndIncrement() == 0 ? "owner" : "waiter"));
    }

    /** State-based wait for the named thread to park on the shared repair. */
    private static void awaitWaiting(String name) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (true) {
            boolean parked = Thread.getAllStackTraces().keySet().stream().anyMatch(t -> t.getName().equals(name)
                && (t.getState() == Thread.State.WAITING || t.getState() == Thread.State.TIMED_WAITING));
            if (parked) return;
            if (System.nanoTime() > deadline) throw new AssertionError(name + " never parked");
            Thread.onSpinWait();
        }
    }

    private static CardDtos.CardResponse card(long version) { return card(CARD, version); }

    private static CardDtos.CardResponse card(UUID id, long version) {
        return new CardDtos.CardResponse(id, UUID.randomUUID(), "Fixture", "Div", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 3, version, List.of(), PairingRuleType.RANDOM, List.of(), List.of(),
            List.of(), List.of(), List.of(), "NONE", 0, null, false, Instant.EPOCH, "A", "PAIR", List.of());
    }
}
