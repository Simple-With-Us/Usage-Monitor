import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Usage Monitor",
    short_name: "Usage",
    description: "Monitor API usage, billing, subscriptions, and account health.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Light default UI (body bg-gray-50); dark scheme is class-based, so the
    // manifest stays aligned with the light palette.
    background_color: "#f9fafb",
    theme_color: "#f9fafb",
    categories: ["finance", "productivity", "utilities"],
    icons: [
      {
        src: "/pwa-icon/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa-icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa-icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
