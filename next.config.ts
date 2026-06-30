import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep the development compiler away from production build artifacts.
  // Running `next build` while `next dev` is active must not corrupt its chunks.
  distDir: process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === "development" ? ".next-dev" : ".next"),
  outputFileTracingRoot: process.cwd(),
  async rewrites() {
    const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:8080";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      { source: "/login", destination: `${backend}/login` },
      { source: "/logout", destination: `${backend}/logout` },
    ];
  },
  async headers() {
    const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
    return [
      // Opt in only the representation-stable public reads. The SSE route must always stream
      // directly from the origin and must never share a CDN cache entry.
      ...["/api/public/cards", "/api/public/cards/versions", "/api/public/cards/:cardId"].map((source) => ({
        source,
        headers: [{ key: "x-vercel-enable-rewrite-caching", value: "1" }],
      })),
      {
        source: "/api/public/cards/:cardId/events",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Accel-Buffering", value: "no" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'${devEval}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` },
        ],
      },
    ];
  },
};

export default nextConfig;
