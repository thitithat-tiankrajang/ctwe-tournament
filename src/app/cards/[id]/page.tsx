"use client";

import { useParams } from "next/navigation";
import { CardOverview } from "@/ui/components/card-overview";

export default function CardOverviewPage() {
  const { id } = useParams<{ id: string }>();
  return <CardOverview cardId={id} />;
}
