import type { Metadata } from "next";
import "./globals.css";
import { AppProviders } from "@/infrastructure/query/provider";
import { AppShell } from "@/ui/layout/app-shell";

export const metadata: Metadata = {
  title: "Tournament Control",
  description: "ระบบจัดการแข่งขันเกมกระดาน",
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
