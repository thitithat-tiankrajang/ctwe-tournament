/**
 * Anonymous viewer traffic is the high-volume path. When NEXT_PUBLIC_PUBLIC_API_ORIGIN is set,
 * /api/public reads and the public SSE stream go straight to that origin (Render, or a CDN
 * hostname in front of it) instead of through the Cloudflare Worker proxy — every bypassed call
 * is one less request against the Workers free-tier daily quota. Public endpoints are
 * anonymous-only (credentials: "omit"), so cross-origin CORS GETs are safe.
 *
 * Unset (local dev, or staff traffic which must stay same-origin for session cookies): paths are
 * returned unchanged and everything flows through the same-origin proxy as before.
 */
const configured = (process.env.NEXT_PUBLIC_PUBLIC_API_ORIGIN ?? "").trim().replace(/\/+$/, "");

if (configured && !configured.startsWith("https://") && process.env.NODE_ENV === "production") {
  throw new Error("NEXT_PUBLIC_PUBLIC_API_ORIGIN must be an https origin");
}

export const PUBLIC_API_ORIGIN = configured;

export function publicApiUrl(path: string): string {
  if (!path.startsWith("/api/public/")) throw new Error(`Not a public API path: ${path}`);
  return `${PUBLIC_API_ORIGIN}${path}`;
}
