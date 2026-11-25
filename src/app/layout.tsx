import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProviders } from "@/infrastructure/query/provider";
import { AppShell } from "@/ui/layout/app-shell";

export const metadata: Metadata = {
  title: "Tournament Control",
  description: "ระบบจัดการแข่งขันเกมกระดาน",
  // Next serves the manifest at /manifest.webmanifest from app/manifest.ts; link it explicitly.
  manifest: "/manifest.webmanifest",
  applicationName: "Tournament Control",
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // Required for iOS: the site must run as an installed web app before Safari delivers Web Push.
  appleWebApp: {
    capable: true,
    title: "Tournament",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#1677ff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <body>
        <AppProviders><AppShell>{children}</AppShell></AppProviders>
      </body>
    </html>
  );
}
