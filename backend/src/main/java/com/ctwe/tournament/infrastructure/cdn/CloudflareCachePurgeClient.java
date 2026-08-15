package com.ctwe.tournament.infrastructure.cdn;

import com.ctwe.tournament.infrastructure.storage.SnapshotStorageProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** Cloudflare purge-by-URL, scoped to one zone. */
public class CloudflareCachePurgeClient implements CachePurgeClient {
    private static final Logger log = LoggerFactory.getLogger(CloudflareCachePurgeClient.class);
    private static final Duration TIMEOUT = Duration.ofSeconds(10);

    private final HttpClient http;
    private final SnapshotStorageProperties properties;

    public CloudflareCachePurgeClient(SnapshotStorageProperties properties) {
        this(properties, HttpClient.newBuilder().connectTimeout(TIMEOUT).build());
    }

    CloudflareCachePurgeClient(SnapshotStorageProperties properties, HttpClient http) {
        this.properties = properties;
        this.http = http;
    }

    @Override
    public boolean available() {
        return properties.purgeConfigured();
    }

    @Override
    public boolean purge(String url) {
        if (!available()) return false;
        try {
            HttpResponse<String> response = http.send(HttpRequest
                .newBuilder(URI.create("https://api.cloudflare.com/client/v4/zones/"
                    + properties.cloudflareZoneId() + "/purge_cache"))
                .header("Authorization", "Bearer " + properties.cloudflarePurgeToken())
                .header("Content-Type", "application/json")
                .timeout(TIMEOUT)
                .POST(HttpRequest.BodyPublishers.ofString("{\"files\":[\"" + url + "\"]}"))
                .build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 200) return true;
            log.warn("Cache purge for {} refused with HTTP {}", url, response.statusCode());
            return false;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception error) {
            // Deliberately swallowed: staleness is bounded by max-age=300 and a correct publication
            // must not be reported as a failure because a cache hint could not be delivered.
            log.warn("Cache purge for {} failed: {}", url, error.toString());
            return false;
        }
    }
}
