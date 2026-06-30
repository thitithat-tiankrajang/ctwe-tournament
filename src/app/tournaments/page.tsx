import { redirect } from "next/navigation";

// The cross-tournament picker is retired: entry is link-based now. Admins manage tournaments (and
// their access links) from the admin console; everyone else reaches a tournament via its link.
export default function TournamentsPage() {
  redirect("/admin");
}
