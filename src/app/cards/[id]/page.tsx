"use client";

import { useParams } from "next/navigation";
import { useDerivedTournamentScope } from "@/application/tournament/use-derived-scope";
import { AdminCardInspection } from "@/ui/components/admin-card-inspection";
import { CardOverview } from "@/ui/components/card-overview";

export default function CardOverviewPage() {
  const { id } = useParams<{ id: string }>();
  // Deliberately here and not inside CardOverview: that component is shared with /tour/[token], and
  // setting the scope on the viewer path would null publicScopeToken and reopen SSE on a published
  // tournament (04_BLOCKERS.md B5).
  useDerivedTournamentScope(id);
  // ADMIN-only read-only inspection. Also route-level for the same reason: CardOverview is shared
  // with the public viewer, which must never render it.
  return (
    <>
      <CardOverview cardId={id} />
      <AdminCardInspection cardId={id} />
    </>
  );
}
