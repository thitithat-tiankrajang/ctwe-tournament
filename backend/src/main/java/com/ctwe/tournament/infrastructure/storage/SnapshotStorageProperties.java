package com.ctwe.tournament.infrastructure.storage;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

/**
 * R2 and CDN configuration for Public Snapshot publication.
 *
 * <h2>Configuration policy (normative)</h2>
 * <table>
 *   <caption>The three — and only three — states this configuration may be in</caption>
 *   <tr><th>State</th><th>Meaning</th><th>Behaviour</th></tr>
 *   <tr><td><b>ABSENT</b></td><td>no {@code app.snapshot-storage.*} value is set</td>
 *       <td>publication is <b>disabled</b>; Spring Boot starts normally; every live feature is
 *           unchanged; local development and CI need no R2 credentials</td></tr>
 *   <tr><td><b>PARTIAL</b></td><td>some values are set, but a required one is missing or invalid</td>
 *       <td><b>invalid — startup fails</b> with a message naming exactly what is wrong. Never
 *           silently disabled</td></tr>
 *   <tr><td><b>COMPLETE</b></td><td>every required value is set and valid</td>
 *       <td>publication is <b>enabled</b></td></tr>
 * </table>
 *
 * <p>PARTIAL is a hard failure rather than a fallback because the alternative is worse in exactly
 * the situation that matters: a half-set credential set would boot happily, look healthy, and then
 * fail at publish time — the one moment when an operator is committing to a permanent public
 * artifact. A configuration that cannot be honoured should stop the deployment, not the publication.
 *
 * <p>Required: {@code endpoint}, {@code access-key-id}, {@code secret-access-key},
 * {@code private-bucket}, {@code public-bucket}, {@code public-origin}. The public origin is
 * required, not optional, because the pipeline verifies every candidate through that hostname before
 * promoting it — without it the safety property the design rests on cannot hold.
 *
 * <p>Optional: {@code cloudflare-zone-id} + {@code cloudflare-purge-token}, which must be supplied
 * together or not at all. Purging is a latency optimisation (staleness is bounded by
 * {@code max-age=300} regardless), so its absence is legitimate — but half of a credential pair is
 * drift, not a choice.
 */
@ConfigurationProperties(prefix = "app.snapshot-storage")
public record SnapshotStorageProperties(
    /** S3-compatible endpoint for the R2 account, e.g. https://{accountId}.r2.cloudflarestorage.com */
    String endpoint,
    String accessKeyId,
    String secretAccessKey,
    /** Private bucket holding the full version history. Never publicly reachable. */
    String privateBucket,
    /** Public bucket behind the custom domain. */
    String publicBucket,
    /** Public hostname the bucket is served on, e.g. https://snapshot.ct-we.com */
    String publicOrigin,
    /** Cloudflare zone id + API token for purge-by-URL. Optional, but all-or-nothing. */
    String cloudflareZoneId,
    String cloudflarePurgeToken
) {
    /** Cache policy for the promoted object. max-age bounds how long a withdrawal can go unseen. */
    public static final String PUBLISHED_CACHE_CONTROL =
        "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";

    /** Staging objects are transient verification artifacts and must never be cached anywhere. */
    public static final String STAGING_CACHE_CONTROL = "no-store";

    /** The two legitimate outcomes. PARTIAL is not a mode — it is a startup failure. */
    public enum Mode { ABSENT, COMPLETE }

    /**
     * Classifies the configuration, rejecting anything in between.
     *
     * @return {@link Mode#ABSENT} or {@link Mode#COMPLETE}
     * @throws IllegalStateException when the configuration is PARTIAL or invalid, listing every
     *         problem at once so an operator fixes them in one pass rather than one redeploy each
     */
    public Mode validate() {
        if (!anyValuePresent()) return Mode.ABSENT;

        List<String> problems = new ArrayList<>();
        requirePresent(problems, "endpoint", endpoint);
        requirePresent(problems, "access-key-id", accessKeyId);
        requirePresent(problems, "secret-access-key", secretAccessKey);
        requirePresent(problems, "private-bucket", privateBucket);
        requirePresent(problems, "public-bucket", publicBucket);
        requirePresent(problems, "public-origin", publicOrigin);

        if (present(endpoint)) requireAbsoluteUrl(problems, "endpoint", endpoint, false);
        // https only: the viewer fetches this origin from an https page, so an http hostname would
        // be blocked as mixed content and every published tournament would silently fail to load.
        if (present(publicOrigin)) requireAbsoluteUrl(problems, "public-origin", publicOrigin, true);

        if (present(cloudflareZoneId) != present(cloudflarePurgeToken))
            problems.add("cloudflare-zone-id and cloudflare-purge-token must be set together or not at all");

        if (!problems.isEmpty())
            throw new IllegalStateException(
                "Public Snapshot storage is configured but invalid. Set every required value, or none at all. "
                    + "Problems: " + String.join("; ", problems)
                    + ". Required: app.snapshot-storage.{endpoint,access-key-id,secret-access-key,"
                    + "private-bucket,public-bucket,public-origin}.");

        return Mode.COMPLETE;
    }

    public boolean enabled() {
        return validate() == Mode.COMPLETE;
    }

    /** True when purge-by-URL is available. Only meaningful once {@link #validate()} has passed. */
    public boolean purgeConfigured() {
        return present(cloudflareZoneId) && present(cloudflarePurgeToken);
    }

    /** The URL a browser would use for an object key. */
    public String publicUrl(String key) {
        return publicOrigin.replaceAll("/+$", "") + "/" + key;
    }

    /** Any snapshot value at all — including the optional ones, which are still snapshot settings. */
    private boolean anyValuePresent() {
        return present(endpoint) || present(accessKeyId) || present(secretAccessKey)
            || present(privateBucket) || present(publicBucket) || present(publicOrigin)
            || present(cloudflareZoneId) || present(cloudflarePurgeToken);
    }

    private static void requirePresent(List<String> problems, String name, String value) {
        if (!present(value)) problems.add(name + " is missing");
    }

    private static void requireAbsoluteUrl(List<String> problems, String name, String value, boolean httpsOnly) {
        try {
            URI uri = URI.create(value.trim());
            String scheme = uri.getScheme();
            if (scheme == null || uri.getHost() == null) {
                problems.add(name + " must be an absolute URL including the scheme (got '" + value + "')");
                return;
            }
            if (httpsOnly && !"https".equalsIgnoreCase(scheme))
                problems.add(name + " must be https (got '" + value + "')");
            else if (!httpsOnly && !("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)))
                problems.add(name + " must be an http(s) URL (got '" + value + "')");
        } catch (IllegalArgumentException malformed) {
            problems.add(name + " is not a valid URL (got '" + value + "')");
        }
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }
}
