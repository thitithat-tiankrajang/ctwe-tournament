package com.ctwe.tournament.infrastructure.security;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Guards {@code POST /login} before any BCrypt work happens.
 *
 * <p>Two independent protections:
 * <ol>
 *   <li><b>Per (username, client address) failure limit.</b> After {@link #MAX_FAILURES} failures
 *       from one address for one username, that pair is refused for {@link #WINDOW} without touching
 *       the database or the password encoder. Keying on the PAIR, not the username alone, means one
 *       attacker can no longer lock a director out of their own account on event day; the
 *       account-wide database lock (see {@code StaffAuthenticationEvents}) still stops a brute force
 *       spread across several addresses. If production ever resolves every client to one address,
 *       this degrades to a per-username limit — the old behaviour, never something stricter.</li>
 *   <li><b>A global cap on concurrent password checks.</b> Each check is a cost-12 BCrypt hash, and
 *       an unknown username is hashed too (Spring's timing-attack mitigation), so a flood of login
 *       requests used to be a cheap way to pin the instance's CPU. Excess requests wait briefly and
 *       then get a 429 instead of queueing behind each other.</li>
 * </ol>
 *
 * <p>State is in memory and per instance; the service runs as a single instance.
 */
@Component
public class LoginThrottle {
    static final int MAX_FAILURES = 5;
    static final Duration WINDOW = Duration.ofMinutes(15);
    /** Retry hint when the verification cap, not a failure limit, refused the request. */
    static final Duration BUSY_RETRY = Duration.ofSeconds(5);
    private static final long BUSY_WAIT_MILLIS = 3_000;
    private static final int MAX_KEY_PART = 128;

    private record Failures(int count, Instant last) {}

    private final Cache<String, Failures> failures = Caffeine.newBuilder()
        .expireAfterWrite(WINDOW)
        .maximumSize(20_000)
        .build();
    private final Semaphore verifying;
    private final Clock clock;

    @Autowired
    public LoginThrottle(@Value("${app.login.max-concurrent-verifications:2}") int maxConcurrentVerifications) {
        this(maxConcurrentVerifications, Clock.systemUTC());
    }

    LoginThrottle(int maxConcurrentVerifications, Clock clock) {
        if (maxConcurrentVerifications < 1) throw new IllegalArgumentException("maxConcurrentVerifications must be >= 1");
        this.verifying = new Semaphore(maxConcurrentVerifications, true);
        this.clock = clock;
    }

    /** How long this pair must still wait, or empty when it may attempt a login now. */
    public Optional<Duration> blockedFor(String username, String clientAddress) {
        Failures current = live(key(username, clientAddress));
        if (current == null || current.count() < MAX_FAILURES) return Optional.empty();
        return Optional.of(Duration.between(clock.instant(), current.last().plus(WINDOW)));
    }

    public void recordFailure(String username, String clientAddress) {
        Instant now = clock.instant();
        failures.asMap().compute(key(username, clientAddress), (key, previous) -> {
            boolean stale = previous == null || !previous.last().plus(WINDOW).isAfter(now);
            return new Failures(stale ? 1 : previous.count() + 1, now);
        });
    }

    public void recordSuccess(String username, String clientAddress) {
        failures.invalidate(key(username, clientAddress));
    }

    /** Claims a password-check slot, waiting a few seconds at most. False means "too busy". */
    public boolean tryBeginVerification() {
        try {
            return verifying.tryAcquire(BUSY_WAIT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public void endVerification() {
        verifying.release();
    }

    private Failures live(String key) {
        Failures current = failures.getIfPresent(key);
        if (current == null || !current.last().plus(WINDOW).isAfter(clock.instant())) return null;
        return current;
    }

    private static String key(String username, String clientAddress) {
        return clip(username) + "\n" + clip(clientAddress);
    }

    private static String clip(String value) {
        if (value == null) return "";
        return value.length() > MAX_KEY_PART ? value.substring(0, MAX_KEY_PART) : value;
    }
}
