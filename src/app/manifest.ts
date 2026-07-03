import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tournament Control",
    short_name: "Tournament",
    description: "ติดตาม Pairing, Ranking และผลการแข่งขัน",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f9fc",
    theme_color: "#1677ff",
    lang: "th",
  };
}
