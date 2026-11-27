import type { TournamentCard } from "@/domain/tournament/types";
import { liveSlots, type Staged } from "@/ui/components/use-pairing-baseline";

const draftKey = (id: string) => `ctwe-pairing-ui-draft:${id}`;
const key = ({ game, table }: { game: number; table: number }) => `${game}:${table}`;

export function clearPairingDraft(id: string) {
  try { sessionStorage.removeItem(draftKey(id)); } catch { /* Browser storage is optional. */ }
}

export function readPairingDraft(card: TournamentCard): {
  staged: Staged; available: Record<number, string[]>; cleared: string[]; selectedGame?: number;
} | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(card.id)) ?? "null");
    if (!saved) return null;
    const [round, , oldSlots] = saved.scope ? JSON.parse(saved.scope) : [];
    if ((saved.round ?? round) !== card.currentGame || !Array.isArray(saved.staged)) {
      clearPairingDraft(card.id);
      return null;
    }
    const current = new Map(liveSlots(card).map((slot) => [key(slot), slot]));
    const previous = new Map<string, { one: string | null; two: string | null }>(
      saved.baseline ?? (oldSlots ?? []).map((slot: { game: number; table: number }) => [key(slot), slot]),
    );
    const touched = new Set<string>([...saved.staged.map(([id]: [string]) => id), ...(saved.cleared ?? [])]);
    const staleGames = new Set<number>();
    for (const id of touched) {
      const before = previous.get(id), now = current.get(id);
      if (!before || !now || before.one !== now.one || before.two !== now.two) staleGames.add(Number(id.split(":")[0]));
    }
    const valid = (id: string) => !staleGames.has(Number(id.split(":")[0]));
    const available = Object.fromEntries(Object.entries(saved.availableByGame ?? { [card.currentGame]: saved.available ?? [] })
      .filter(([game]) => !staleGames.has(Number(game)) && [...current.values()].some((slot) => slot.game === Number(game)))) as Record<number, string[]>;
    return { staged: new Map(saved.staged.filter(([id]: [string]) => valid(id))), available,
      cleared: (saved.cleared ?? []).filter((id: string) => valid(id) && current.get(id)?.hasResult),
      selectedGame: saved.selectedGame };
  } catch { return null; }
}

export function savePairingDraft(card: TournamentCard, staged: Staged, availableByGame: Record<number, string[]>,
  cleared: Set<string>, selectedGame: number) {
  sessionStorage.setItem(draftKey(card.id), JSON.stringify({ round: card.currentGame,
    baseline: liveSlots(card).map((slot) => [key(slot), { one: slot.one, two: slot.two }]),
    staged: [...staged], availableByGame, cleared: [...cleared], selectedGame }));
}
