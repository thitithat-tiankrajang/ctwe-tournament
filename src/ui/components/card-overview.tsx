"use client";

import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { canManageTournament, hasStaffAccess, isAdmin } from "@/domain/tournament/roles";
import { CardOverviewView } from "./card-overview-view";
export { nextOverviewViews } from "./card-overview-view";
export type { OverviewView } from "./card-overview-view";

/** Operational entry point. Public routes pass public data directly to the view. */
export function CardOverview({ cardId }: { cardId: string }) {
  const cards = useTournamentStore((state) => state.cards);
  const loading = useTournamentStore((state) => state.loading);
  const closeCard = useTournamentStore((state) => state.closeCard);
  const auth = useTournamentStore((state) => state.auth);
  return <CardOverviewView cardId={cardId} card={selectCard(cards, cardId)} loading={loading}
    canManage={canManageTournament(auth)} resizableColumns={hasStaffAccess(auth)}
    allowDownloads={isAdmin(auth) || canManageTournament(auth)} onClose={closeCard} />;
}
