import type { MetadataRoute } from "next";

// Installing to the home screen is what unlocks Web Push on iOS (Safari only delivers push to an
// installed PWA), so the manifest must carry real icons. Android/desktop use these too.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tournament Control",
    short_name: "Tournament",
    description: "ติดตาม Pairing, Ranking และผลการแข่งขัน",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f9fc",
    theme_color: "#1677ff",
    lang: "th",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
