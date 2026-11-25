"use client";

import { useParams } from "next/navigation";
import { useDerivedTournamentScope } from "@/application/tournament/use-derived-scope";
import { CardOverview } from "@/ui/components/card-overview";

export default function CardOverviewPage() {
  const { id } = useParams<{ id: string }>();
  // Deliberately here and not inside CardOverview: that component is shared with /tour/[token], and
  // setting the scope on the viewer path would null publicScopeToken and reopen SSE on a published
  // tournament (04_BLOCKERS.md B5).
  useDerivedTournamentScope(id);
  return <CardOverview cardId={id} />;
}
