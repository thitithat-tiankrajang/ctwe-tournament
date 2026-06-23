"use client";

import { create } from "zustand";
import type { CreateCardInput, Player, TournamentCard } from "@/domain/tournament/types";

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  roles: string[];
  csrfToken: string;
}

interface TournamentState {
  cards: TournamentCard[];
  auth: AuthState;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  clearError: () => void;
  createCard: (input: CreateCardInput) => Promise<string>;
  addPlayer: (cardId: string, player: Pick<Player, "firstName" | "lastName" | "school">) => Promise<void>;
  updatePlayer: (cardId: string, playerId: string, player: Pick<Player, "firstName" | "lastName" | "school">) => Promise<void>;
  removePlayer: (cardId: string, playerId: string) => Promise<void>;
  finishRegistration: (cardId: string) => Promise<void>;
  generateMockPlayers: (cardId: string, count: number) => Promise<void>;
  generatePairings: (cardId: string) => Promise<void>;
  swapPlayers: (cardId: string, firstId: string, secondId: string, confirmSchoolConflict?: boolean) => Promise<void>;
  confirmPairingPreview: (cardId: string) => Promise<void>;
  submitResult: (cardId: string, pairingId: string, scoreOne: number, scoreTwo: number, editExisting?: boolean) => Promise<void>;
  reviewResults: (cardId: string) => Promise<void>;
  reopenResults: (cardId: string) => Promise<void>;
  publishResults: (cardId: string) => Promise<void>;
  closeCard: (cardId: string) => Promise<void>;
  simulateTournament: (cardId: string) => Promise<void>;
  resetCard: (cardId: string) => Promise<void>;
}

const anonymous: AuthState = { authenticated: false, username: null, roles: [], csrfToken: "" };

async function readError(response: Response) {
  try {
    const payload = await response.json() as { error?: string; message?: string };
    return payload.error ?? payload.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export const useTournamentStore = create<TournamentState>((set, get) => {
  const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method?.toUpperCase() ?? "GET";
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const token = get().auth.csrfToken;
      if (token) headers.set("X-XSRF-TOKEN", token);
    }
    const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) await get().refreshAuth();
      const message = await readError(response);
      set({ error: message });
      throw new Error(message);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  };

  const replaceCard = (updated: TournamentCard) => set((state) => ({
    cards: state.cards.some((card) => card.id === updated.id)
      ? state.cards.map((card) => card.id === updated.id ? updated : card)
      : [updated, ...state.cards],
    error: null,
  }));

  const mutateCard = async (path: string, cardId: string, init: RequestInit = {}) => {
    const card = get().cards.find((item) => item.id === cardId);
    const headers = new Headers(init.headers);
    if (card) headers.set("If-Match", `\"${card.version}\"`);
    const updated = await request<TournamentCard>(path, { ...init, headers });
    replaceCard(updated);
  };

  return {
    cards: [],
    auth: anonymous,
    loading: true,
    error: null,
    clearError: () => set({ error: null }),
    async refreshAuth() {
      try {
        const auth = await request<AuthState>("/api/auth/me");
        set({ auth });
      } catch {
        set({ auth: anonymous });
      }
    },
    async load() {
      set({ loading: true, error: null });
      try {
        const [auth, cards] = await Promise.all([
          fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }).then((response) => response.json() as Promise<AuthState>),
          fetch("/api/cards", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error(await readError(response));
            return response.json() as Promise<TournamentCard[]>;
          }),
        ]);
        set({ auth, cards, loading: false });
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : "ไม่สามารถเชื่อมต่อ API ได้" });
      }
    },
    async createCard(input) {
      const card = await request<TournamentCard>("/api/cards", { method: "POST", body: JSON.stringify(input) });
      replaceCard(card);
      return card.id;
    },
    async addPlayer(cardId, player) {
      await mutateCard(`/api/cards/${cardId}/players`, cardId, { method: "POST", body: JSON.stringify(player) });
    },
    async updatePlayer(cardId, playerId, player) {
      await mutateCard(`/api/cards/${cardId}/players/${encodeURIComponent(playerId)}`, cardId, {
        method: "PUT",
        body: JSON.stringify(player),
      });
    },
    async removePlayer(cardId, playerId) {
      await mutateCard(`/api/cards/${cardId}/players/${encodeURIComponent(playerId)}`, cardId, { method: "DELETE" });
    },
    async finishRegistration(cardId) {
      await mutateCard(`/api/cards/${cardId}/registration/finish`, cardId, { method: "POST" });
    },
    async generateMockPlayers(cardId, count) {
      await mutateCard(`/api/dev/cards/${cardId}/players?count=${count}`, cardId, { method: "POST" });
    },
    async generatePairings(cardId) {
      await mutateCard(`/api/cards/${cardId}/pairings/preview`, cardId, { method: "POST" });
    },
    async swapPlayers(cardId, firstId, secondId, confirmSchoolConflict = false) {
      await mutateCard(`/api/cards/${cardId}/tables/swap`, cardId, {
        method: "POST",
        body: JSON.stringify({ firstPlayerId: firstId, secondPlayerId: secondId, confirmSchoolConflict }),
      });
    },
    async confirmPairingPreview(cardId) {
      await mutateCard(`/api/cards/${cardId}/pairings/confirm`, cardId, { method: "POST" });
    },
    async submitResult(cardId, pairingId, scoreOne, scoreTwo, editExisting = false) {
      await mutateCard(`/api/cards/${cardId}/matches/${pairingId}/result`, cardId, {
        method: "PUT",
        body: JSON.stringify({ scoreOne, scoreTwo, editExisting }),
      });
    },
    async reviewResults(cardId) {
      await mutateCard(`/api/cards/${cardId}/results/review`, cardId, { method: "POST" });
    },
    async reopenResults(cardId) {
      await mutateCard(`/api/cards/${cardId}/results/reopen`, cardId, { method: "POST" });
    },
    async publishResults(cardId) {
      await mutateCard(`/api/cards/${cardId}/results/publish`, cardId, { method: "POST" });
    },
    async closeCard(cardId) {
      await mutateCard(`/api/cards/${cardId}/close`, cardId, { method: "POST" });
    },
    async simulateTournament(cardId) {
      await mutateCard(`/api/dev/cards/${cardId}/simulate`, cardId, { method: "POST" });
    },
    async resetCard(cardId) {
      await mutateCard(`/api/dev/cards/${cardId}/reset`, cardId, { method: "POST" });
    },
  };
});

export const selectCard = (cards: TournamentCard[], cardId: string) => cards.find((card) => card.id === cardId);
export const rankPlayers = (players: Player[]) => [...players].sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff || a.id.localeCompare(b.id));
