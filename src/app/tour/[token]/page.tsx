"use client";

import { useParams } from "next/navigation";
import { SnapshotPreconnect } from "@/ui/components/snapshot-preconnect";
import { TournamentViewer } from "@/ui/components/tournament-viewer";

/** Admin-chosen viewer URL, e.g. /tour/bkk-th-ms-championship. */
export default function TournamentViewerPage() {
  const { token } = useParams<{ token: string }>();
  return (
    <>
      <SnapshotPreconnect />
      <TournamentViewer token={token} />
    </>
  );
}
