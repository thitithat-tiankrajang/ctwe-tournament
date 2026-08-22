"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { useBackOfficeSessionGuard } from "@/application/tournament/use-session-guard";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        // D8 forbids refetch-on-focus for console data, and P3-D1/P3-D2 spent two commits getting
        // /admin and /director down to ONE request per window focus (the session guard's
        // /api/auth/me). TanStack's default for this option is ON, gated only on staleness — so the
        // first useQuery added here would silently put the focus storm back the moment its data
        // aged past staleTime above. Measured on a probe query: /director refocus went 1 -> 2
        // requests with the default, and back to 1 with this line. The console fetches deliberately
        // and explicitly; nothing may refetch merely because the operator alt-tabbed.
        refetchOnWindowFocus: false,
      },
    },
  }));
  const load = useTournamentStore((state) => state.load);
  useBackOfficeSessionGuard();
  useEffect(() => { void load(); }, [load]);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
