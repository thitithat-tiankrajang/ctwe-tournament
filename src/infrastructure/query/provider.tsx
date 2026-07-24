"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { useBackOfficeSessionGuard } from "@/application/tournament/use-session-guard";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }));
  const load = useTournamentStore((state) => state.load);
  useBackOfficeSessionGuard();
  useEffect(() => { void load(); }, [load]);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
