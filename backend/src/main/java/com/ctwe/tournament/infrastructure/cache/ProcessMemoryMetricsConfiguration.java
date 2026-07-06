package com.ctwe.tournament.infrastructure.cache;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Linux process resident-set size for production capacity tests.
 *
 * JVM heap/non-heap meters do not include thread stacks, native buffers, loaded libraries, or
 * other native allocations, while Render enforces a limit on the whole process. Render runs Linux,
 * where /proc/self/status exposes the kernel's real resident set. On non-Linux development hosts
 * the gauge reports NaN and the runbook clearly falls back to JVM-used memory instead of inventing
 * a RAM number.
 */
@Configuration(proxyBeanMethods = false)
public class ProcessMemoryMetricsConfiguration {
    private static final Path PROC_STATUS = Path.of("/proc/self/status");

    @Bean
    Gauge processResidentMemoryGauge(MeterRegistry registry) {
        return Gauge.builder("process.memory.rss", ProcessMemoryMetricsConfiguration::residentBytes)
            .description("Resident set size of this backend process")
            .baseUnit("bytes")
            .register(registry);
    }

    private static double residentBytes() {
        if (!Files.isReadable(PROC_STATUS)) return Double.NaN;
        try {
            for (String line : Files.readAllLines(PROC_STATUS)) {
                if (!line.startsWith("VmRSS:")) continue;
                String digits = line.substring("VmRSS:".length()).trim().split("\\s+")[0];
                return Long.parseLong(digits) * 1024.0; // /proc reports KiB
            }
        } catch (IOException | NumberFormatException ignored) {
            // A missing sample must stay missing; reporting zero would be a fabricated metric.
        }
        return Double.NaN;
    }
}
