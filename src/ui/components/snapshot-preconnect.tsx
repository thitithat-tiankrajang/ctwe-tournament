"use client";

import { SNAPSHOT_ORIGIN } from "@/infrastructure/http/snapshot-api";

/**
 * Warms the TLS connection to the snapshot CDN while the page is still hydrating.
 *
 * The snapshot probe is the first thing the viewer does, and on a cold page load it would otherwise
 * pay DNS + TCP + TLS before it can even ask. Preconnecting overlaps that handshake with chunk
 * download and hydration, which is most of what keeps the probe off the critical path for a LIVE
 * tournament — the case that must not get slower.
 *
 * Renders nothing when the feature is off, so with `NEXT_PUBLIC_SNAPSHOT_ORIGIN` unset the document
 * is byte-identical to today's.
 */
export function SnapshotPreconnect() {
  if (!SNAPSHOT_ORIGIN) return null;
  return <link rel="preconnect" href={SNAPSHOT_ORIGIN} crossOrigin="anonymous" />;
}
