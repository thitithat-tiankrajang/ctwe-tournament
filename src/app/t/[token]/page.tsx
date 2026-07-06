"use client";

import { useParams } from "next/navigation";
import { TournamentViewer } from "@/ui/components/tournament-viewer";

/**
 * Legacy share links (/t/{hex-token}) keep working forever: same viewer, same token resolution,
 * just the older URL shape. New tournaments hand out /tour/{slug} instead.
 */
export default function LegacyTournamentLinkPage() {
  const { token } = useParams<{ token: string }>();
  return <TournamentViewer token={token} />;
}
