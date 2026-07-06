"use client";

import { useParams } from "next/navigation";
import { TournamentViewer } from "@/ui/components/tournament-viewer";

/** Admin-chosen viewer URL, e.g. /tour/bkk-th-ms-championship. */
export default function TournamentViewerPage() {
  const { token } = useParams<{ token: string }>();
  return <TournamentViewer token={token} />;
}
