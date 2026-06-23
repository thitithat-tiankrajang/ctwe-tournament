import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'${devEval}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` },
      ],
    }];
  },
};

export default nextConfig;
