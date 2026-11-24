package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.PublicCardReadCache;
import com.ctwe.tournament.application.TenantService;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.cache.CacheConfiguration;
import com.ctwe.tournament.infrastructure.cache.TournamentCaches;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.PublicCardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.CacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Bundle revalidation against the REAL cache stack: the production {@link CacheConfiguration}
 * (Caffeine behind {@code TransactionAwareCacheManagerProxy}, detail capacity 8), the real
 * {@link PublicCardReadCache} / {@link PublicCardQueryService} proxies, and the real
 * {@link PublicTournamentController}. Only the database is synthetic ({@link FakeDb}), which counts
 * FULL card loads (a public payload build) separately from LIGHTWEIGHT manifest reads.
 *
 * <p>A fake-loader count is a count of work items, not SQL latency, and capacity here is the default
 * 8 only. Nothing here measures production throughput.
 */
@SpringJUnitConfig(PublicTournamentBundleRevalidationTest.Config.class)
@TestPropertySource(properties = {
    "app.cache.public-card-details.ttl-seconds=300",
    "app.cache.public-card-details.maximum-weight-bytes=20512768",
    "app.cache.public-card-catalog.ttl-seconds=300",
    "app.cache.public-card-versions.ttl-seconds=3",
    "app.cache.runtime-settings.ttl-seconds=60",
})
class PublicTournamentBundleRevalidationTest {

    // ---- synthetic database ----------------------------------------------------------------------

    record Card(UUID id, UUID tournamentId, long createdOrder) {}
    record Tournament(UUID id, String token, String name, int publishedCardCount) {}

    static final class FakeDb {
        final Map<UUID, Tournament> tournaments = new ConcurrentHashMap<>();
        final Map<UUID, Card> cards = new ConcurrentHashMap<>();
        final Map<UUID, AtomicLong> versions = new ConcurrentHashMap<>();
        /** Cards whose payload read returns this (older) version while the manifest says newer. */
        final Map<UUID, Long> payloadLag = new ConcurrentHashMap<>();
        final AtomicInteger manifestReads = new AtomicInteger();
        final AtomicInteger fullLoads = new AtomicInteger();
        final AtomicLong order = new AtomicLong();
        /** Runs once, right after the next manifest read (publication between manifest and payloads). */
        volatile Runnable afterNextManifest;
        /** When set, the next full build of {@code blockCard} signals {@code blockEntered} and waits. */
        volatile UUID blockCard;
        volatile CountDownLatch blockEntered;
        volatile CountDownLatch blockRelease;
        /** When true, the blocked build throws after release (a failed repair). */
        volatile boolean failBlockedBuild;

        void reset() {
            tournaments.clear(); cards.clear(); versions.clear(); payloadLag.clear();
            manifestReads.set(0); fullLoads.set(0); afterNextManifest = null;
            blockCard = null; blockEntered = null; blockRelease = null; failBlockedBuild = false;
        }
        List<UUID> addTournament(UUID id, String token, int cardCount) {
            tournaments.put(id, new Tournament(id, token, "Cup " + token, 0));
            List<UUID> ids = new ArrayList<>();
            for (int i = 0; i < cardCount; i++) ids.add(addCard(id));
            return ids;
        }
        UUID addCard(UUID tournamentId) {
            UUID id = UUID.randomUUID();
            cards.put(id, new Card(id, tournamentId, order.incrementAndGet()));
            versions.put(id, new AtomicLong(1));
            return id;
        }
        long version(UUID card) { return versions.get(card).get(); }
        TenantDtos.PublicTournamentResponse resolve(String token) {
            Tournament t = tournaments.values().stream().filter(x -> x.token().equals(token)).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Tournament not found or not open"));
            int count = (int) cards.values().stream().filter(c -> c.tournamentId().equals(t.id())).count();
            return new TenantDtos.PublicTournamentResponse(t.id(), t.name(), t.token(), count, t.publishedCardCount());
        }
    }

    /** Answers exactly the two statements the read cache issues; anything else fails loudly. */
    static final class FakeJdbc extends JdbcTemplate {
        private final FakeDb db;
        FakeJdbc(FakeDb db) { this.db = db; }
        @Override public void afterPropertiesSet() { }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (!sql.contains("FROM tournament_cards WHERE tournament_id = ?"))
                throw new AssertionError("unexpected query: " + sql);
            db.manifestReads.incrementAndGet();
            UUID tournamentId = (UUID) args[0];
            List<Card> rows = db.cards.values().stream().filter(c -> c.tournamentId().equals(tournamentId))
                .sorted(Comparator.comparingLong(Card::createdOrder).reversed()).toList();
            List<T> out = new ArrayList<>();
            try {
                for (int i = 0; i < rows.size(); i++) {
                    Card card = rows.get(i);
                    long version = db.version(card.id());
                    out.add(mapper.mapRow(resultSet(card.id(), version), i));
                }
            } catch (java.sql.SQLException error) { throw new AssertionError(error); }
            Runnable hook = db.afterNextManifest;
            if (hook != null) { db.afterNextManifest = null; hook.run(); }
            return out;
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> List<T> queryForList(String sql, Class<T> type, Object... args) {
            if (!sql.startsWith("SELECT public_version FROM tournament_cards WHERE id = ?"))
                throw new AssertionError("unexpected queryForList: " + sql);
            UUID id = (UUID) args[0];
            if (!db.versions.containsKey(id)) return List.of();
            Long lagged = db.payloadLag.get(id);
            return (List<T>) List.of(lagged != null ? lagged : db.version(id));
        }

        private static ResultSet resultSet(UUID id, long version) {
            return (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[]{ResultSet.class},
                (proxy, method, a) -> switch (method.getName()) {
                    case "getObject" -> id;
                    case "getLong" -> version;
                    default -> throw new AssertionError("unexpected ResultSet." + method.getName());
                });
        }
    }

    @Configuration(proxyBeanMethods = false)
    @Import(CacheConfiguration.class)
    static class Config {
        @Bean FakeDb fakeDb() { return new FakeDb(); }
        @Bean JdbcTemplate jdbcTemplate(FakeDb db) { return new FakeJdbc(db); }
        @Bean TournamentCardService tournamentCardService(FakeDb db) {
            TournamentCardService service = mock(TournamentCardService.class);
            when(service.get(any(UUID.class), eq(false))).thenAnswer(call -> {
                db.fullLoads.incrementAndGet(); // one full public payload build
                UUID id = call.getArgument(0);
                if (id.equals(db.blockCard)) {
                    db.blockCard = null;               // one-shot
                    db.blockEntered.countDown();
                    if (!db.blockRelease.await(30, TimeUnit.SECONDS)) throw new AssertionError("never released");
                    if (db.failBlockedBuild) throw new IllegalStateException("synthetic build failure");
                }
                return payload(id, db.cards.get(id).tournamentId());
            });
            return service;
        }
        @Bean PublicCardReadCache publicCardReadCache(JdbcTemplate jdbc, TournamentCardService cards) {
            return new PublicCardReadCache(jdbc, cards);
        }
        @Bean PublicCardQueryService publicCardQueryService(PublicCardReadCache cache) {
            return new PublicCardQueryService(cache);
        }
    }

    @Autowired FakeDb db;
    @Autowired PublicCardQueryService query;
    @Autowired CacheManager cacheManager;
    private MockMvc mvc;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> REPORT = new ArrayList<>();

    @BeforeEach
    void fresh() {
        db.reset();
        cacheManager.getCacheNames().forEach(name -> cacheManager.getCache(name).clear());
        TenantService tenant = mock(TenantService.class);
        when(tenant.resolveOpenTournament(anyString())).thenAnswer(call -> db.resolve(call.getArgument(0)));
        mvc = MockMvcBuilders.standaloneSetup(new PublicTournamentController(tenant, query, mock(CardEventPublisher.class))).build();
    }

    @AfterAll
    static void printReport() {
        System.out.println("[revalidation] ---- load counts (full = public payload builds; manifest = lightweight reads) ----");
        REPORT.forEach(line -> System.out.println("[revalidation] " + line));
    }

    // ---- unchanged revalidation is cheap at every size ---------------------------------------------

    @Test
    void unchangedRevalidationNeverRebuildsCardsAtAnySize() throws Exception {
        for (int size : new int[]{0, 1, 4, 8, 12, 40}) {
            db.reset();
            clearDetails();
            db.addTournament(UUID.randomUUID(), "t" + size, size);
            String token = "t" + size;

            Response cold = fetch(token, null);
            int coldFull = db.fullLoads.getAndSet(0);
            Response warm = fetch(token, null);
            int warmFull = db.fullLoads.getAndSet(0);
            db.manifestReads.set(0);
            for (int i = 0; i < 20; i++) assertThat(fetch(token, cold.etag()).status()).isEqualTo(304);
            int conditionalFull = db.fullLoads.get();
            int conditionalManifest = db.manifestReads.get();

            assertThat(cold.status()).isEqualTo(200);
            assertThat(warm.etag()).isEqualTo(cold.etag());
            assertThat(coldFull).isEqualTo(size);
            assertThat(conditionalFull).as(size + " cards: 304s must not rebuild cards").isZero();
            assertThat(conditionalManifest).isEqualTo(20);
            REPORT.add(String.format("%2d cards | cold 200: %2d full | warm 200: %2d full | 20 x 304: %d full, %d manifest",
                size, coldFull, warmFull, conditionalFull, conditionalManifest));
        }
    }

    @Test
    void interleavedTournamentsCompetingForASmallCacheStayCheap() throws Exception {
        List<String> tokens = List.of("alpha", "bravo", "charlie");
        Map<String, String> tags = new LinkedHashMap<>();
        for (String token : tokens) { db.addTournament(UUID.randomUUID(), token, 12); tags.put(token, fetch(token, null).etag()); }
        db.fullLoads.set(0);
        db.manifestReads.set(0);

        for (int round = 0; round < 20; round++)
            for (String token : tokens) assertThat(fetch(token, tags.get(token)).status()).isEqualTo(304);

        assertThat(db.fullLoads.get()).isZero();
        assertThat(db.manifestReads.get()).isEqualTo(60);
        REPORT.add("3 tournaments x 12 cards, capacity 8, 60 interleaved 304s: " + db.fullLoads.get() + " full, "
            + db.manifestReads.get() + " manifest");
    }

    @Test
    void evictedDetailsWithUnchangedDataStill304WithoutLoads() throws Exception {
        db.addTournament(UUID.randomUUID(), "evicted", 12);
        String tag = fetch("evicted", null).etag();
        clearDetails();
        db.fullLoads.set(0);

        assertThat(fetch("evicted", tag).status()).isEqualTo(304);
        assertThat(db.fullLoads.get()).isZero();
        REPORT.add("12 cards, detail cache cleared, data unchanged: 304 with " + db.fullLoads.get() + " full loads");
    }

    // ---- both directions of catalog/detail skew ---------------------------------------------------

    @Test
    void cachedPayloadOlderThanManifestIsRepairedOnce() throws Exception {
        List<UUID> ids = db.addTournament(UUID.randomUUID(), "skew-old", 4);
        String before = fetch("skew-old", null).etag();
        db.versions.get(ids.get(0)).incrementAndGet();   // committed, eviction not yet run
        db.fullLoads.set(0);

        Response response = fetch("skew-old", before);

        assertThat(response.status()).isEqualTo(200);
        assertThat(versionIn(response, ids.get(0))).isEqualTo(2);
        assertThat(db.fullLoads.get()).as("only the stale card is rebuilt, once").isEqualTo(1);
        assertTagDescribesBody(response);
        assertThat(fetch("skew-old", response.etag()).status()).isEqualTo(304);
        REPORT.add("payload older than manifest (commit before eviction): 200 with " + db.fullLoads.get()
            + " full load (single repair), next request 304");
    }

    @Test
    void payloadNewerThanManifestIsTaggedFromThePayload() throws Exception {
        List<UUID> ids = db.addTournament(UUID.randomUUID(), "skew-new", 4);
        fetch("skew-new", null);
        UUID moved = ids.get(1);
        db.afterNextManifest = () -> {                   // publication lands between manifest and payloads
            db.versions.get(moved).incrementAndGet();
            commitEviction(moved);                       // its after-commit eviction (+ refill)
        };

        Response response = fetch("skew-new", null);

        assertThat(versionIn(response, moved)).isEqualTo(2);
        assertTagDescribesBody(response);
        assertThat(fetch("skew-new", response.etag()).status()).as("manifest has caught up").isEqualTo(304);
    }

    @Test
    void persistentlyLaggingPayloadIsBoundedAndNeverPinnedBy304() throws Exception {
        List<UUID> ids = db.addTournament(UUID.randomUUID(), "lag", 4);
        fetch("lag", null);
        UUID lagging = ids.get(2);
        db.versions.get(lagging).set(5);
        db.payloadLag.put(lagging, 1L);                  // payload reads keep returning version 1
        clearDetails();
        fetch("lag", null);
        db.fullLoads.set(0);

        Response first = fetch("lag", null);
        assertThat(first.status()).isEqualTo(200);
        assertThat(versionIn(first, lagging)).isEqualTo(1);
        assertTagDescribesBody(first);
        String tag = first.etag();
        for (int i = 0; i < 2; i++) {
            // The server rebuilds the SAME lagging body, so Spring MVC answers 304 against its own
            // body-derived tag: correct HTTP (identical representation), never a confirmation of a
            // body the server would not send right now.
            assertThat(fetch("lag", tag).status()).isEqualTo(304);
        }
        assertThat(db.fullLoads.get()).as("exactly one repair per request, no retry loop").isEqualTo(3);
        db.payloadLag.clear();
        Response healed = fetch("lag", tag);
        assertThat(healed.status()).isEqualTo(200);
        assertThat(versionIn(healed, lagging)).isEqualTo(5);
        assertThat(fetch("lag", healed.etag()).status()).isEqualTo(304);
        REPORT.add("persistently lagging payload: 3 requests -> 1 repair each (3 full total, no loop); identical body"
            + " re-validated by its own tag; 200 with the current body as soon as the lag clears");
    }

    // ---- duplicate stale-repair race (latch-controlled, no sleeps) --------------------------------

    /** The controller's repair step for a card it saw older than {@code required}. */
    private CardDtos.CardResponse repair(UUID card, long required) {
        return query.reload(card, required);
    }

    /** What @EvictPublicCard does after a commit, followed by a reader refilling the entry. */
    private void commitEviction(UUID card) {
        cacheManager.getCache(TournamentCaches.PUBLIC_CARD_DETAILS).evict(card);
        query.get(card);
    }

    /** Primes one card at version 1, then commits version 2 without the eviction having run yet. */
    private UUID staleCard() {
        UUID card = db.addTournament(UUID.randomUUID(), "race", 1).get(0);
        assertThat(query.get(card).version()).isEqualTo(1);
        db.versions.get(card).set(2);
        db.fullLoads.set(0);
        return card;
    }

    @Test
    void lateRepairersReuseACompletedRepairInsteadOfRebuilding() throws Exception {
        UUID card = staleCard();
        int late = 3;
        CountDownLatch allObserved = new CountDownLatch(1 + late);
        CountDownLatch firstRepaired = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(1 + late);
        List<Future<long[]>> results = new ArrayList<>();
        // A: observes N, waits until every late caller has also observed N, then repairs.
        results.add(pool.submit(() -> {
            long seen = query.get(card).version();
            allObserved.countDown();
            allObserved.await();
            long repaired = repair(card, 2).version();
            firstRepaired.countDown();
            return new long[]{seen, repaired};
        }));
        // B..D: observe N (before A repairs), then repair only after A's repair has completed.
        for (int i = 0; i < late; i++) results.add(pool.submit(() -> {
            long seen = query.get(card).version();
            allObserved.countDown();
            firstRepaired.await();
            return new long[]{seen, repair(card, 2).version()};
        }));
        for (Future<long[]> result : results) {
            long[] outcome = result.get(30, TimeUnit.SECONDS);
            assertThat(outcome[0]).as("every caller observed the stale N").isEqualTo(1);
            assertThat(outcome[1]).as("every caller ends with N+1").isEqualTo(2);
        }
        pool.shutdownNow();
        int builds = db.fullLoads.get();
        REPORT.add("late repairers after a completed repair (1 + " + late + " callers saw N): " + builds + " full builds");
        assertThat(builds).as("late callers must reuse the repaired card").isEqualTo(1);
    }

    @Test
    void overlappingRepairersShareOneInFlightRepair() throws Exception {
        UUID card = staleCard();
        db.blockEntered = new CountDownLatch(1);
        db.blockRelease = new CountDownLatch(1);
        db.blockCard = card;
        ExecutorService pool = Executors.newFixedThreadPool(3);
        Future<CardDtos.CardResponse> first = pool.submit(() -> repair(card, 2));
        assertThat(db.blockEntered.await(30, TimeUnit.SECONDS)).isTrue();   // A's rebuild is in flight
        List<Thread> parked = java.util.Collections.synchronizedList(new ArrayList<>());
        List<Future<CardDtos.CardResponse>> late = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            CountDownLatch started = new CountDownLatch(1);
            late.add(pool.submit(() -> { parked.add(Thread.currentThread()); started.countDown(); return repair(card, 2); }));
            started.await();
        }
        awaitParked(parked);                                                 // both are now blocked behind A
        db.blockRelease.countDown();
        assertThat(first.get(30, TimeUnit.SECONDS).version()).isEqualTo(2);
        for (Future<CardDtos.CardResponse> f : late) assertThat(f.get(30, TimeUnit.SECONDS).version()).isEqualTo(2);
        pool.shutdownNow();
        int builds = db.fullLoads.get();
        REPORT.add("2 repairers arriving while a repair is in flight: " + builds + " full builds");
        assertThat(builds).as("overlapping repairs of the same card/version coalesce").isEqualTo(1);
    }

    /** Waits until every thread is parked (BLOCKED/WAITING) — state-based, not a timed guess. */
    private static void awaitParked(List<Thread> threads) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (true) {
            boolean all = threads.size() == 2 && threads.stream().allMatch(t ->
                t.getState() == Thread.State.BLOCKED || t.getState() == Thread.State.WAITING
                    || t.getState() == Thread.State.TIMED_WAITING);
            if (all) return;
            if (System.nanoTime() > deadline) throw new AssertionError("callers never parked: " + threads);
            Thread.onSpinWait();
        }
    }

    // ---- concurrency -----------------------------------------------------------------------------

    @Test
    void concurrentConditionalRequestsDoNoCardWork() throws Exception {
        db.addTournament(UUID.randomUUID(), "busy", 12);
        String tag = fetch("busy", null).etag();
        db.fullLoads.set(0);
        db.manifestReads.set(0);

        int[] statuses = runConcurrently(32, 20, () -> fetch("busy", tag).status());

        assertThat(statuses).containsOnly(304);
        assertThat(db.fullLoads.get()).isZero();
        REPORT.add("32 threads x 20 conditional, 12 cards: " + db.fullLoads.get() + " full, " + db.manifestReads.get() + " manifest");
    }

    @Test
    void concurrentColdLoadsCoalescePerCard() throws Exception {
        db.addTournament(UUID.randomUUID(), "cold4", 4);
        db.addTournament(UUID.randomUUID(), "cold12", 12);
        int[] fits = runConcurrently(32, 1, () -> fetch("cold4", null).status());
        int coldFits = db.fullLoads.getAndSet(0);
        int[] over = runConcurrently(32, 1, () -> fetch("cold12", null).status());
        int coldOver = db.fullLoads.get();

        assertThat(fits).containsOnly(200);
        assertThat(over).containsOnly(200);
        assertThat(coldFits).as("4 cards fit: one build per card despite 32 concurrent misses").isEqualTo(4);
        assertThat(coldOver).isBetween(12, 32 * 12);
        REPORT.add("32 concurrent cold 200s: 4 cards -> " + coldFits + " full; 12 cards (capacity 8) -> " + coldOver
            + " full (vs " + 32 * 12 + " uncoalesced)");
    }

    @Test
    void publicationDuringConcurrentReadsNeverDetachesATagFromItsBody() throws Exception {
        List<UUID> ids = db.addTournament(UUID.randomUUID(), "live", 6);
        AtomicBoolean writing = new AtomicBoolean(true);
        Thread writer = new Thread(() -> {
            java.util.Random random = new java.util.Random(7);
            while (writing.get()) {
                UUID card = ids.get(random.nextInt(ids.size()));
                db.versions.get(card).incrementAndGet();        // commit
                java.util.concurrent.locks.LockSupport.parkNanos(200_000); // commit→eviction window
                commitEviction(card);                            // after-commit eviction (+ refill)
            }
        });
        writer.start();
        ConcurrentHashMap<String, String> mismatches = new ConcurrentHashMap<>();
        AtomicInteger twoHundreds = new AtomicInteger();
        AtomicInteger notModified = new AtomicInteger();
        try {
            runConcurrently(8, 60, () -> {
                Response first = fetch("live", null);
                if (!tagMatches(first)) mismatches.put(first.etag(), first.body());
                Response again = fetch("live", first.etag());
                if (again.status() == 200) {
                    twoHundreds.incrementAndGet();
                    if (!tagMatches(again)) mismatches.put(again.etag(), again.body());
                } else notModified.incrementAndGet();
                return again.status();
            });
        } finally {
            writing.set(false);
            writer.join();
        }
        assertThat(mismatches).as("every 200 must carry the validator of its own body").isEmpty();
        Response settled = fetch("live", null);
        for (UUID id : ids) assertThat(versionIn(settled, id)).isEqualTo(db.version(id));
        assertThat(fetch("live", settled.etag()).status()).isEqualTo(304);
        REPORT.add("publication during 8x60 concurrent read pairs: 0 tag/body mismatches; revalidations "
            + twoHundreds.get() + " x 200, " + notModified.get() + " x 304; converged to DB after writes stopped");
    }

    // ---- validator coverage and recovery -----------------------------------------------------------

    @Test
    void legacyAndMetadataAndMembershipChangesForceA200() throws Exception {
        UUID tid = UUID.randomUUID();
        List<UUID> ids = db.addTournament(tid, "meta", 3);
        Response base = fetch("meta", null);
        List<String> newestFirst = new ArrayList<>(ids.stream().map(id -> id + ":1").toList());
        java.util.Collections.reverse(newestFirst);   // the old catalog order was created_at DESC
        String legacy = "\"bundle-" + UUID.nameUUIDFromBytes(("bundle|" + tid + "|" + String.join("|", newestFirst))
            .getBytes(StandardCharsets.UTF_8)) + "\"";
        assertThat(fetch("meta", legacy).status()).as("legacy validator").isEqualTo(200);

        db.tournaments.put(tid, new Tournament(tid, "meta", "Renamed", 0));
        assertThat(fetch("meta", base.etag()).status()).as("rename").isEqualTo(200);
        db.tournaments.put(tid, new Tournament(tid, "meta", "Cup meta", 1));
        assertThat(fetch("meta", base.etag()).status()).as("published count").isEqualTo(200);
        db.tournaments.put(tid, new Tournament(tid, "meta", "Cup meta", 0));
        assertThat(fetch("meta", base.etag()).status()).as("restored metadata").isEqualTo(304);
        UUID added = db.addCard(tid);
        assertThat(fetch("meta", base.etag()).status()).as("card added").isEqualTo(200);
        db.cards.remove(added);
        db.versions.remove(added);
        assertThat(fetch("meta", base.etag()).status()).as("membership restored").isEqualTo(304);
        db.cards.remove(ids.get(0));
        assertThat(fetch("meta", base.etag()).status()).as("card removed").isEqualTo(200);
    }

    @Test
    void closedOrUnknownLinkStill404sWithoutAnyRead() throws Exception {
        assertThat(fetch("nope", null).status()).isEqualTo(404);
        assertThat(db.manifestReads.get()).isZero();
        assertThat(db.fullLoads.get()).isZero();
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private record Response(int status, String etag, String body) {}

    private Response fetch(String token, String ifNoneMatch) throws Exception {
        var request = get("/api/public/tournaments/" + token + "/bundle");
        if (ifNoneMatch != null) request.header(HttpHeaders.IF_NONE_MATCH, ifNoneMatch);
        var response = mvc.perform(request).andReturn().getResponse();
        return new Response(response.getStatus(), response.getHeader(HttpHeaders.ETAG),
            response.getContentAsString(StandardCharsets.UTF_8));
    }

    private void clearDetails() { cacheManager.getCache(TournamentCaches.PUBLIC_CARD_DETAILS).clear(); }

    private static long versionIn(Response response, UUID card) throws Exception {
        for (JsonNode node : JSON.readTree(response.body()).get("cards"))
            if (node.get("id").asText().equals(card.toString())) return node.get("version").asLong();
        throw new AssertionError("card " + card + " missing from body");
    }

    /** Recomputes the validator from the response body alone, with the production function. */
    private static boolean tagMatches(Response response) throws Exception {
        JsonNode body = JSON.readTree(response.body());
        List<PublicCardDtos.CardVersion> cards = new ArrayList<>();
        for (JsonNode node : body.get("cards"))
            cards.add(new PublicCardDtos.CardVersion(UUID.fromString(node.get("id").asText()), node.get("version").asLong()));
        String expected = PublicTournamentController.etag(new TenantDtos.PublicTournamentResponse(
            UUID.fromString(body.get("id").asText()), body.get("name").asText(), body.get("accessToken").asText(),
            body.get("cardCount").asInt(), body.get("publishedCardCount").asInt()), cards);
        return expected.equals(response.etag());
    }

    private static void assertTagDescribesBody(Response response) throws Exception {
        assertThat(tagMatches(response)).as("validator must be derived from the body it travels with").isTrue();
    }

    private interface Call { int run() throws Exception; }

    private static int[] runConcurrently(int threads, int perThread, Call call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<int[]>> futures = new ArrayList<>();
        for (int t = 0; t < threads; t++) futures.add(pool.submit(() -> {
            start.await();
            int[] out = new int[perThread];
            for (int i = 0; i < perThread; i++) out[i] = call.run();
            return out;
        }));
        start.countDown();
        List<Integer> all = new ArrayList<>();
        for (Future<int[]> future : futures) for (int status : future.get(60, TimeUnit.SECONDS)) all.add(status);
        pool.shutdownNow();
        return all.stream().mapToInt(Integer::intValue).toArray();
    }

    private static CardDtos.CardResponse payload(UUID id, UUID tournamentId) {
        return new CardDtos.CardResponse(id, tournamentId, "Fixture", "Div", CardStatus.RUNNING,
            RuntimeStage.RESULT_COLLECTION, 3, 0, List.of(), PairingRuleType.RANDOM, List.of(), List.of(),
            List.of(), List.of(), List.of(), "NONE", 0, null, false, Instant.EPOCH, "A", "PAIR", List.of());
    }
}
