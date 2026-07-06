import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Every page is a client shell whose data lives in the zustand store + SSE, so a cached RSC
    // payload can never be stale in any user-visible way. The Next 15 default (dynamic: 0)
    // refetches ?_rsc= on EVERY navigation to a dynamic route — for the staff console that was
    // one Worker invocation + one full SSR per sidebar hop. Five minutes of router cache makes
    // repeat navigation free.
    staleTimes: {
      dynamic: 300,
      static: 300,
    },
  },
  // Keep the development compiler away from production build artifacts.
  // Running `next build` while `next dev` is active must not corrupt its chunks.
  distDir: process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === "development" ? ".next-dev" : ".next"),
  outputFileTracingRoot: process.cwd(),
  async headers() {
    const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
    // High-volume anonymous reads (and the public SSE stream) bypass the Worker proxy and hit
    // this origin directly, so the CSP must allow it. Same-origin staff traffic is unaffected.
    const publicApiOrigin = (process.env.NEXT_PUBLIC_PUBLIC_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
    const connectSrc = `'self'${publicApiOrigin ? ` ${publicApiOrigin}` : ""}`;
    return [
      // Opt in only the representation-stable public reads. The SSE route must always stream
      // directly from the origin and must never share a CDN cache entry.
      {
        source: "/api/public/cards/:cardId/events",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Accel-Buffering", value: "no" },
        ],
      },
      // Viewer page documents are identical data-free client shells (all data arrives via the
      // public API + SSE), so the browser may reuse them briefly instead of re-invoking the
      // Worker on every visit/refresh. Kept short: after a deploy a stale shell could reference
      // replaced chunk files, and five minutes bounds that exposure.
      {
        source: "/tour/:token",
        headers: [{ key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=600" }],
      },
      {
        source: "/t/:token",
        headers: [{ key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=600" }],
      },
      // The PWA manifest changes only on deploys; the prerendered default is max-age=0.
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'${devEval}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connectSrc}; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` },
        ],
      },
    ];
  },
};

export default nextConfig;
