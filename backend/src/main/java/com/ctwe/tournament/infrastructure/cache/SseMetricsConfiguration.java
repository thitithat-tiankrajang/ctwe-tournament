package com.ctwe.tournament.infrastructure.cache;

import com.ctwe.tournament.application.CardEventPublisher;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Exposes live SSE stream occupancy at /actuator/metrics/sse.streams.* so operators (and the
 * load-test monitor) can watch capacity against the runtime-configured caps in real time.
 */
@Configuration(proxyBeanMethods = false)
public class SseMetricsConfiguration {
    @Bean
    Gauge publicSseStreamsGauge(MeterRegistry registry, CardEventPublisher events) {
        return Gauge.builder("sse.streams.public", events, CardEventPublisher::activePublicStreams)
            .description("Open public viewer SSE streams")
            .register(registry);
    }

    @Bean
    Gauge staffSseStreamsGauge(MeterRegistry registry, CardEventPublisher events) {
        return Gauge.builder("sse.streams.staff", events, CardEventPublisher::activeStaffStreams)
            .description("Open staff SSE streams")
            .register(registry);
    }
}
