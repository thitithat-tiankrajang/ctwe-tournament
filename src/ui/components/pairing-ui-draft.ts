import type { TournamentCard } from "@/domain/tournament/types";
import { liveSlots, type Staged } from "@/ui/components/use-pairing-baseline";

const draftKey = (id: string) => `ctwe-pairing-ui-draft:${id}`;
const scope = (card: TournamentCard) => JSON.stringify([card.currentGame, card.runtimeStage, liveSlots(card)]);

export function clearPairingDraft(id: string) {
  try { sessionStorage.removeItem(draftKey(id)); } catch { /* Browser storage is optional. */ }
}

export function readPairingDraft(card: TournamentCard): { staged: Staged; available: string[] } | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(card.id)) ?? "null");
    if (!saved) return null;
    if (saved.scope !== scope(card) || !Array.isArray(saved.staged) || !Array.isArray(saved.available)) {
      clearPairingDraft(card.id);
      return null;
    }
    return { staged: new Map(saved.staged), available: saved.available };
  } catch { return null; }
}

export function savePairingDraft(card: TournamentCard, staged: Staged, available: string[]) {
  sessionStorage.setItem(draftKey(card.id), JSON.stringify({ scope: scope(card), staged: [...staged], available }));
}
