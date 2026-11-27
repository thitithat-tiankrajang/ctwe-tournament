import { inspectTournament, type TournamentInspection } from "@/domain/tournament/card-inspection";
import type { Tournament } from "@/domain/tournament/types";

/** The outcome of ONE tournament-metadata request, tagged with the tournament it was made for. */
export interface TournamentLookupResult {
  tournamentId: string;
  state: TournamentInspection;
}

/**
 * Request lifecycle for the ADMIN inspection's tournament metadata, kept free of React so it can be
 * exercised directly. Only the most recent request may settle: a response that arrives after a newer
 * request was issued, or after {@link cancel}, is dropped. Errors are recorded against the tournament
 * they belong to, so a failure can never outlive a later, successful lookup.
 */
export function createTournamentLookup(
  load: () => Promise<Tournament[]>,
  onSettle: (result: TournamentLookupResult) => void,
) {
  let latest = 0;
  return {
    request(tournamentId: string) {
      const token = ++latest;
      let pending: Promise<Tournament[]>;
      try { pending = load(); }
      catch { pending = Promise.reject(new Error("load failed")); }
      return pending.then(
        (tournaments) => { if (token === latest) onSettle({ tournamentId, state: inspectTournament(tournaments, tournamentId) }); },
        () => { if (token === latest) onSettle({ tournamentId, state: { kind: "error" } }); },
      );
    },
    cancel() { latest++; },
  };
}

/** What to show for the card's tournament now: a settled result only if it is for THIS tournament. */
export function tournamentStateFor(settled: TournamentLookupResult | null, tournamentId: string | undefined): TournamentInspection {
  if (!tournamentId || !settled || settled.tournamentId !== tournamentId) return { kind: "loading" };
  return settled.state;
}
