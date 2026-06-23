import { redirect } from "next/navigation";

export default async function RemovedStandingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/cards/${id}/players`);
}
