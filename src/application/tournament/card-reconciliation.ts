import type { Pairing, PairingChange, TournamentCard } from "@/domain/tournament/types";

const pairingsOf = (card: TournamentCard) => card.snapshots.flatMap((snapshot) => snapshot.pairings);

function pairingKey(pairing: Pairing): string {
  return `${pairing.gameNumber ?? 0}:${pairing.tableNumber}`;
}

function sameResult(a: Pairing | undefined, b: Pairing | undefined): boolean {
  // A JSON card may encode an omitted optional result field as null. Treat null and undefined as
  // the same empty value so a wake read does not manufacture a result notice for every untouched
  // pairing in a payload with a different serializer shape.
  return (a?.scoreOne ?? undefined) === (b?.scoreOne ?? undefined)
    && (a?.scoreTwo ?? undefined) === (b?.scoreTwo ?? undefined)
    && (a?.resultType ?? undefined) === (b?.resultType ?? undefined)
    && (a?.winnerId ?? undefined) === (b?.winnerId ?? undefined)
    && (a?.calculatedDiff ?? undefined) === (b?.calculatedDiff ?? undefined)
    && Boolean(a?.resultWithdrawn) === Boolean(b?.resultWithdrawn)
    && Boolean(a?.voided) === Boolean(b?.voided);
}

/** Results changed by an authoritative card read, in the same payload shape as the staff SSE notice. */
export function changedResultPairings(before: TournamentCard | undefined, after: TournamentCard): Pairing[] {
  const held = new Map((before ? pairingsOf(before) : []).map((pairing) => [pairing.id, pairing]));
  return pairingsOf(after).filter((pairing) => !sameResult(held.get(pairing.id), pairing));
}

/** Player movement changed by an authoritative card read, in the same shape as pairing SSE notices. */
export function changedPairingSlots(before: TournamentCard | undefined, after: TournamentCard): PairingChange[] {
  const held = new Map((before ? pairingsOf(before) : []).map((pairing) => [pairingKey(pairing), pairing]));
  const fresh = new Map(pairingsOf(after).map((pairing) => [pairingKey(pairing), pairing]));
  const keys = new Set([...held.keys(), ...fresh.keys()]);
  return [...keys].sort().flatMap((key) => {
    const previous = held.get(key);
    const current = fresh.get(key);
    if ((previous?.playerOneId ?? null) === (current?.playerOneId ?? null)
      && (previous?.playerTwoId ?? null) === (current?.playerTwoId ?? null)) return [];
    const [game, table] = key.split(":").map(Number);
    return [{
      game,
      table,
      beforeOne: previous?.playerOneId ?? null,
      beforeTwo: previous?.playerTwoId ?? null,
      afterOne: current?.playerOneId ?? null,
      afterTwo: current?.playerTwoId ?? null,
    }];
  });
}
