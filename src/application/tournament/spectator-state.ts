import { publicApiUrl } from "@/infrastructure/http/public-api";
import { fetchSnapshotBundle } from "@/infrastructure/http/snapshot-api";
import type { Pairing, PublicTournamentBundle } from "@/domain/tournament/types";
import { publicDivisionPayload, spectatorDivision, type PublicDivisionPayload, type SpectatorDivision } from "./spectator-read-model";

class PublicReadError extends Error {
  constructor(readonly status: number) { super(`Public read failed (${status})`); }
}

export interface SpectatorState {
  token: string;
  tournament: { id: string; name: string } | null;
  source: "unresolved" | "live" | "archive";
  loading: boolean;
  error: string | null;
  freshness: "loading" | "current" | "reconnecting" | "delayed";
  updatedAt: number | null;
  /** Compatibility payloads are only for the transitional renderer. New screens use divisions. */
  cards: PublicDivisionPayload[];
  divisions: SpectatorDivision[];
}
export type PublicDelta =
  | { type: "result"; cardId: string; version: number; changedPairings: Pairing[] }
  | { type: "pairings"; cardId: string; version: number; gameNumber: number; pairings: Pairing[] }
  | { type: "publish"; cardId: string; version: number; snapshotId: string; gameNumbers: number[];
      confirmedAt: string; currentGame: number; runtimeStage: PublicDivisionPayload["runtimeStage"] };

/** Transport reconciliation only; ranking, pairing and scoring algorithms remain in the domain. */
export function applyPublicDelta(card: PublicDivisionPayload, delta: PublicDelta): PublicDivisionPayload | null {
  if (delta.cardId !== card.id) return null;
  if (delta.version <= card.version) return card;
  if (delta.version !== card.version + 1) return null;
  const index = card.snapshots.findIndex(snapshot => !snapshot.confirmedAt);
  if (delta.type === "result") {
    if (index < 0) return null;
    // Corrections to confirmed history must be reconciled from the public read, not appended
    // to an unrelated open block.
    if (card.snapshots.some(snapshot => snapshot.confirmedAt && snapshot.pairings.some(pairing =>
      delta.changedPairings.some(change => change.id === pairing.id)))) return null;
    const rows = card.snapshots[index].pairings;
    const changes = new Map(delta.changedPairings.map(pairing => [pairing.id, pairing]));
    const ids = new Set(rows.map(pairing => pairing.id));
    const pairings = rows.map(pairing => changes.get(pairing.id) ?? pairing)
      .concat(delta.changedPairings.filter(pairing => !ids.has(pairing.id)))
      .sort((a, b) => (a.gameNumber ?? 0) - (b.gameNumber ?? 0) || a.tableNumber - b.tableNumber);
    return { ...card, version: delta.version, snapshots: card.snapshots.map((snapshot, i) => i === index ? { ...snapshot, pairings } : snapshot) };
  }
  if (delta.type === "pairings") {
    const rows = [...delta.pairings].sort((a, b) => a.tableNumber - b.tableNumber);
    if (index < 0) return { ...card, version: delta.version, currentGame: Math.max(card.currentGame, delta.gameNumber),
      snapshots: [...card.snapshots, { id: `preview-${delta.gameNumber}`, gameNumbers: [delta.gameNumber], pairings: rows, confirmedAt: "" }] };
    const open = card.snapshots[index];
    const pairings = open.pairings.filter(pairing => (pairing.gameNumber ?? open.gameNumbers[0]) !== delta.gameNumber)
      .concat(rows).sort((a, b) => (a.gameNumber ?? 0) - (b.gameNumber ?? 0) || a.tableNumber - b.tableNumber);
    return { ...card, version: delta.version, snapshots: card.snapshots.map((snapshot, i) => i === index
      ? { ...snapshot, pairings, gameNumbers: [...new Set([...snapshot.gameNumbers, delta.gameNumber])].sort((a, b) => a - b) } : snapshot) };
  }
  const pending = card.snapshots.findIndex(snapshot => !snapshot.confirmedAt && snapshot.gameNumbers.some(game => delta.gameNumbers.includes(game)));
  if (pending < 0) return null;
  // A source-only PAIR_RESULT publication can split a block. Fetch its authoritative shape.
  if (card.snapshots[pending].gameNumbers.some(game => !delta.gameNumbers.includes(game))) return null;
  return { ...card, version: delta.version, currentGame: delta.currentGame, runtimeStage: delta.runtimeStage,
    snapshots: card.snapshots.map((snapshot, i) => i === pending ? { ...snapshot, id: delta.snapshotId,
      gameNumbers: delta.gameNumbers, confirmedAt: delta.confirmedAt } : snapshot) };
}

/** One instance per mounted tournament. No auth dependency, operational store, or persistent selection. */
export function createSpectatorState(token: string, dependencies: {
  fetch?: typeof fetch;
  snapshot?: typeof fetchSnapshotBundle;
} = {}) {
  const request = dependencies.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const snapshot = dependencies.snapshot ?? fetchSnapshotBundle;
  let state: SpectatorState = { token, tournament: null, source: "unresolved", loading: true,
    error: null, freshness: "loading", updatedAt: null, cards: [], divisions: [] };
  const listeners = new Set<() => void>();
  let bundleInflight: Promise<void> | null = null;
  const cardInflight = new Map<string, Promise<void>>();
  const wanted = new Map<string, number>();
  const removed = new Set<string>();
  const set = (patch: Partial<SpectatorState>) => {
    state = { ...state, ...patch, ...(patch.cards ? { divisions: patch.cards.map(spectatorDivision) } : {}) };
    listeners.forEach(listener => listener());
  };
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(publicApiUrl(path), { credentials: "omit" });
    if (!response.ok) throw new PublicReadError(response.status);
    return response.json() as Promise<T>;
  };
  const load = (): Promise<void> => {
    if (bundleInflight) return bundleInflight;
    bundleInflight = (async () => {
      try {
        const archived = await snapshot(token);
        const bundle = archived ?? await read<PublicTournamentBundle>(`/api/public/tournaments/${encodeURIComponent(token)}/bundle`);
        if (!bundle.id || !Array.isArray(bundle.cards)) throw new Error("Invalid public tournament bundle");
        const cards = bundle.cards.filter(card => card.tournamentId === bundle.id && !removed.has(card.id)).map(source => {
          const card = publicDivisionPayload(source);
          const current = state.cards.find(item => item.id === card.id);
          return !archived && current && current.version > card.version ? current : card;
        });
        set({ tournament: { id: bundle.id, name: bundle.name }, source: archived ? "archive" : "live",
          cards, loading: false, error: null, freshness: "current", updatedAt: Date.now() });
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : "Public load failed", freshness: "delayed" });
        throw error;
      } finally { bundleInflight = null; }
    })();
    return bundleInflight;
  };
  const syncCard = (id: string, version?: number): Promise<void> => {
    if (state.source !== "live" || removed.has(id)) return Promise.resolve();
    if (version !== undefined) wanted.set(id, Math.max(version, wanted.get(id) ?? 0));
    const inflight = cardInflight.get(id);
    if (inflight) return inflight;
    const requestedVersion = wanted.get(id);
    const promise = (async () => {
      try {
        const expected = requestedVersion;
        const suffix = expected === undefined ? "" : `?v=${expected}`;
        const card = publicDivisionPayload(await read<PublicDivisionPayload>(`/api/public/cards/${encodeURIComponent(id)}${suffix}`));
        if (card.id !== id || card.tournamentId !== state.tournament?.id) throw new Error("Public division scope mismatch");
        if (removed.has(id) || state.source !== "live") return;
        const current = state.cards.find(item => item.id === id);
        if (!current || card.version >= current.version) set({ cards: current
          ? state.cards.map(item => item.id === id ? card : item) : [...state.cards, card], updatedAt: Date.now(), error: null });
        if (card.version >= (wanted.get(id) ?? 0)) wanted.delete(id);
        else set({ freshness: "delayed" });
      } catch (error) {
        if (error instanceof PublicReadError && error.status === 404) {
          removed.add(id);
          wanted.delete(id);
          set({ cards: state.cards.filter(card => card.id !== id) });
        } else set({ freshness: "delayed", error: error instanceof Error ? error.message : "Public refresh failed" });
      } finally {
        cardInflight.delete(id);
        // A newer event arrived during the request: heal that version too, without a refetch storm.
        if (!removed.has(id) && (wanted.get(id) ?? 0) > (requestedVersion ?? 0)) void syncCard(id, wanted.get(id));
      }
    })();
    cardInflight.set(id, promise);
    return promise;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load, syncCard,
    setFreshness: (freshness: SpectatorState["freshness"]) => set({ freshness }),
    removeCard: (id: string) => { removed.add(id); wanted.delete(id); set({ cards: state.cards.filter(card => card.id !== id) }); },
    applyDelta: (delta: PublicDelta) => {
      const card = state.cards.find(item => item.id === delta.cardId);
      const next = card ? applyPublicDelta(card, delta) : null;
      if (!next) { void syncCard(delta.cardId, delta.version); return; }
      if (next !== card) set({ cards: state.cards.map(item => item.id === next.id ? next : item), updatedAt: Date.now() });
    },
  };
}
export type SpectatorStore = ReturnType<typeof createSpectatorState>;
