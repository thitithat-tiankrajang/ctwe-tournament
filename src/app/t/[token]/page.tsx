"use client";

import { useParams } from "next/navigation";
import { SnapshotPreconnect } from "@/ui/components/snapshot-preconnect";
import { TournamentViewer } from "@/ui/components/tournament-viewer";

/**
 * Legacy share links (/t/{hex-token}) keep working forever: same viewer, same token resolution,
 * just the older URL shape. New tournaments hand out /tour/{slug} instead.
 *
 * Snapshot resolution is derived from the access token, not from the URL shape, so a legacy link
 * finds a published snapshot exactly as a /tour/{slug} link does.
 */
export default function LegacyTournamentLinkPage() {
  const { token } = useParams<{ token: string }>();
  return (
    <>
      <SnapshotPreconnect />
      <TournamentViewer token={token} />
    </>
  );
}
