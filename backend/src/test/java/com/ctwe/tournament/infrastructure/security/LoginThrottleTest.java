package com.ctwe.tournament.infrastructure.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class LoginThrottleTest {
    /** A clock the test moves by hand. */
    static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-11-11T10:00:00Z");
        void advance(Duration by) { now = now.plus(by); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    private final MutableClock clock = new MutableClock();
    private final LoginThrottle throttle = new LoginThrottle(1, clock);

    private void fail(String user, String address, int times) {
        for (int i = 0; i < times; i++) throttle.recordFailure(user, address);
    }

    @Test
    void blocksThePairOnlyAfterTheLimit() {
        fail("director", "1.1.1.1", LoginThrottle.MAX_FAILURES - 1);
        assertThat(throttle.blockedFor("director", "1.1.1.1")).isEmpty();

        throttle.recordFailure("director", "1.1.1.1");
        assertThat(throttle.blockedFor("director", "1.1.1.1")).contains(LoginThrottle.WINDOW);
    }

    @Test
    void anAttackerAddressDoesNotBlockTheRealUserElsewhere() {
        fail("director", "6.6.6.6", LoginThrottle.MAX_FAILURES);

        assertThat(throttle.blockedFor("director", "6.6.6.6")).isPresent();
        assertThat(throttle.blockedFor("director", "1.1.1.1")).isEmpty();
        assertThat(throttle.blockedFor("staff", "6.6.6.6")).isEmpty();
    }

    @Test
    void theBlockCountsDownAndThenLifts() {
        fail("director", "1.1.1.1", LoginThrottle.MAX_FAILURES);
        clock.advance(Duration.ofMinutes(10));
        assertThat(throttle.blockedFor("director", "1.1.1.1")).contains(Duration.ofMinutes(5));

        clock.advance(Duration.ofMinutes(5));
        assertThat(throttle.blockedFor("director", "1.1.1.1")).isEmpty();
    }

    @Test
    void aFailureAfterTheWindowStartsANewCount() {
        fail("director", "1.1.1.1", LoginThrottle.MAX_FAILURES);
        clock.advance(LoginThrottle.WINDOW);

        throttle.recordFailure("director", "1.1.1.1");
        assertThat(throttle.blockedFor("director", "1.1.1.1")).isEmpty();
    }

    @Test
    void successClearsThePair() {
        fail("director", "1.1.1.1", LoginThrottle.MAX_FAILURES - 1);
        throttle.recordSuccess("director", "1.1.1.1");
        throttle.recordFailure("director", "1.1.1.1");

        assertThat(throttle.blockedFor("director", "1.1.1.1")).isEmpty();
    }

    @Test
    void verificationSlotsAreBoundedAndReturned() {
        assertThat(throttle.tryBeginVerification()).isTrue();
        long started = System.nanoTime();
        assertThat(throttle.tryBeginVerification()).isFalse();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(10));

        throttle.endVerification();
        assertThat(throttle.tryBeginVerification()).isTrue();
        throttle.endVerification();
    }
}
