"use client";

import { create } from "zustand";
import type { CreateCardInput, ManagedUser, Player, Tournament, TournamentCard } from "@/domain/tournament/types";

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  roles: string[];
  csrfToken: string;
}

export interface ActiveTournament {
  id: string;
  name: string;
}

export interface TournamentArchive {
  id: string;
  tournamentName: string;
  fileName: string;
  byteSize: number;
  cardCount: number;
  playerCount: number;
  archivedBy: string | null;
  archivedAt: string;
}

interface TournamentState {
  cards: TournamentCard[];
  auth: AuthState;
  loading: boolean;
  error: string | null;
  activeTournament: ActiveTournament | null;
  archives: TournamentArchive[];
  setActiveTournament: (tournament: ActiveTournament | null) => void;
  load: () => Promise<void>;
  syncCard: (cardId: string) => Promise<void>;
  refreshAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  createCard: (input: CreateCardInput) => Promise<string>;
  addPlayer: (cardId: string, player: Pick<Player, "firstName" | "lastName" | "school">) => Promise<void>;
  importPlayers: (cardId: string, players: Pick<Player, "firstName" | "lastName" | "school">[]) => Promise<void>;
  updatePlayer: (cardId: string, playerId: string, player: Pick<Player, "firstName" | "lastName" | "school">) => Promise<void>;
  removePlayer: (cardId: string, playerId: string) => Promise<void>;
  finishRegistration: (cardId: string) => Promise<void>;
  generateMockPlayers: (cardId: string, count: number) => Promise<void>;
  generatePairings: (cardId: string) => Promise<void>;
  swapPlayers: (cardId: string, firstId: string, secondId: string, confirmSchoolConflict?: boolean) => Promise<void>;
  confirmPairingPreview: (cardId: string) => Promise<void>;
  submitResult: (cardId: string, pairingId: string, scoreOne: number, scoreTwo: number, editExisting?: boolean) => Promise<void>;
  overrideResult: (cardId: string, matchId: string, scoreOne: number, scoreTwo: number) => Promise<void>;
  verifyPassword: (password: string) => Promise<boolean>;
  reviewResults: (cardId: string) => Promise<void>;
  reopenResults: (cardId: string) => Promise<void>;
  publishResults: (cardId: string) => Promise<void>;
  startFinal: (cardId: string) => Promise<void>;
  submitFinalResult: (cardId: string, slot: number, gameIndex: number, scoreOne: number, scoreTwo: number) => Promise<void>;
  setFinalWinner: (cardId: string, slot: number, winnerId: string) => Promise<void>;
  publishFinal: (cardId: string) => Promise<void>;
  undoPairing: (cardId: string) => Promise<void>;
  unpairToPreview: (cardId: string) => Promise<void>;
  closeCard: (cardId: string) => Promise<void>;
  deleteCard: (cardId: string) => Promise<void>;
  simulateTournament: (cardId: string) => Promise<void>;
  resetCard: (cardId: string) => Promise<void>;
  // tenant + account management
  loadTournaments: () => Promise<Tournament[]>;
  createTournament: (name: string) => Promise<Tournament>;
  deleteTournament: (tournamentId: string) => Promise<void>;
  loadArchives: () => Promise<TournamentArchive[]>;
  archiveTournament: (tournamentId: string) => Promise<void>;
  deleteArchive: (archiveId: string) => Promise<void>;
  setTournamentStatus: (tournamentId: string, open: boolean) => Promise<void>;
  grantStaffTournament: (username: string, tournamentId: string) => Promise<void>;
  revokeStaffTournament: (username: string, tournamentId: string) => Promise<void>;
  listDirectors: () => Promise<ManagedUser[]>;
  createDirector: (username: string, password: string, tournamentIds: string[]) => Promise<void>;
  deleteDirector: (username: string) => Promise<void>;
  assignDirector: (tournamentId: string, username: string) => Promise<void>;
  unassignDirector: (tournamentId: string, username: string) => Promise<void>;
  setAccountEnabled: (scope: "directors" | "staff", username: string, enabled: boolean) => Promise<void>;
  resetAccountPassword: (scope: "directors" | "staff", username: string, password: string) => Promise<void>;
  listStaff: () => Promise<ManagedUser[]>;
  createStaff: (username: string, password: string) => Promise<void>;
  deleteStaff: (username: string) => Promise<void>;
}

const anonymous: AuthState = { authenticated: false, username: null, roles: [], csrfToken: "" };
const ACTIVE_TOURNAMENT_KEY = "ctwe.activeTournament";

export function readActiveTournament(): ActiveTournament | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_TOURNAMENT_KEY);
    const parsed = raw ? JSON.parse(raw) as ActiveTournament : null;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch { return null; }
}

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

  const replaceCard = (updated: TournamentCard) => set((state) => {
    const existing = state.cards.find((card) => card.id === updated.id);
    if (existing && existing.version > updated.version) return { error: null };
    return {
      cards: existing
        ? state.cards.map((card) => card.id === updated.id ? updated : card)
        : [updated, ...state.cards],
      error: null,
    };
  });

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
    activeTournament: null,
    archives: [],
    setActiveTournament: (tournament) => {
      if (typeof window !== "undefined") {
        if (tournament) window.localStorage.setItem(ACTIVE_TOURNAMENT_KEY, JSON.stringify(tournament));
        else window.localStorage.removeItem(ACTIVE_TOURNAMENT_KEY);
      }
      set({ activeTournament: tournament });
    },
    clearError: () => set({ error: null }),
    async syncCard(cardId) {
      // Background live-sync for concurrent multi-user editing: pull the latest card, ignore transient errors.
      try {
        const response = await fetch(`/api/cards/${cardId}`, { credentials: "same-origin", cache: "no-store" });
        if (response.ok) replaceCard(await response.json() as TournamentCard);
        else if (response.status === 404) set((state) => ({ cards: state.cards.filter((card) => card.id !== cardId), error: null }));
      } catch { /* transient network/poll error — keep current state */ }
    },
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
    async login(username, password) {
      const body = new URLSearchParams({ username, password, _csrf: get().auth.csrfToken });
      const response = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(response.status === 401 ? "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" : `เข้าสู่ระบบไม่สำเร็จ (${response.status})`);
      await get().refreshAuth();
      if (!get().auth.authenticated) throw new Error("สร้าง session เจ้าหน้าที่ไม่สำเร็จ");
    },
    async logout() {
      const body = new URLSearchParams({ _csrf: get().auth.csrfToken });
      const response = await fetch("/logout", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`ออกจากระบบไม่สำเร็จ (${response.status})`);
      set({ auth: anonymous });
    },
    async createCard(input) {
      const card = await request<TournamentCard>("/api/cards", { method: "POST", body: JSON.stringify(input) });
      replaceCard(card);
      return card.id;
    },
    async addPlayer(cardId, player) {
      await mutateCard(`/api/cards/${cardId}/players`, cardId, { method: "POST", body: JSON.stringify(player) });
    },
    async importPlayers(cardId, players) {
      await mutateCard(`/api/cards/${cardId}/players/bulk`, cardId, { method: "POST", body: JSON.stringify({ players }) });
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
    async overrideResult(cardId, matchId, scoreOne, scoreTwo) {
      await mutateCard(`/api/cards/${cardId}/matches/${matchId}/override`, cardId, {
        method: "PUT",
        body: JSON.stringify({ scoreOne, scoreTwo, editExisting: true }),
      });
    },
    async verifyPassword(password) {
      // Re-auth: a wrong password is a 401 we must NOT treat as a lost session, so bypass the shared helper.
      const headers = new Headers({ "Content-Type": "application/json" });
      const token = get().auth.csrfToken;
      if (token) headers.set("X-XSRF-TOKEN", token);
      const response = await fetch("/api/auth/verify-password", { method: "POST", headers, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ password }) });
      return response.ok;
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
    async startFinal(cardId) {
      await mutateCard(`/api/cards/${cardId}/final/start`, cardId, { method: "POST" });
    },
    async submitFinalResult(cardId, slot, gameIndex, scoreOne, scoreTwo) {
      await mutateCard(`/api/cards/${cardId}/final/${slot}/games/${gameIndex}`, cardId, { method: "PUT", body: JSON.stringify({ scoreOne, scoreTwo }) });
    },
    async setFinalWinner(cardId, slot, winnerId) {
      await mutateCard(`/api/cards/${cardId}/final/${slot}/winner`, cardId, { method: "PUT", body: JSON.stringify({ winnerId }) });
    },
    async publishFinal(cardId) {
      await mutateCard(`/api/cards/${cardId}/final/publish`, cardId, { method: "POST" });
    },
    async undoPairing(cardId) {
      await mutateCard(`/api/cards/${cardId}/pairings/undo`, cardId, { method: "POST" });
    },
    async unpairToPreview(cardId) {
      await mutateCard(`/api/cards/${cardId}/pairings/unpair-to-preview`, cardId, { method: "POST" });
    },
    async closeCard(cardId) {
      await mutateCard(`/api/cards/${cardId}/close`, cardId, { method: "POST" });
    },
    async deleteCard(cardId) {
      await request(`/api/cards/${cardId}`, { method: "DELETE" });
      set((state) => ({ cards: state.cards.filter((card) => card.id !== cardId), error: null }));
    },
    async simulateTournament(cardId) {
      await mutateCard(`/api/dev/cards/${cardId}/simulate`, cardId, { method: "POST" });
    },
    async resetCard(cardId) {
      await mutateCard(`/api/dev/cards/${cardId}/reset`, cardId, { method: "POST" });
    },

    // ---- tenant + account management ----
    async loadTournaments() {
      return request<Tournament[]>("/api/tournaments");
    },
    async createTournament(name) {
      return request<Tournament>("/api/admin/tournaments", { method: "POST", body: JSON.stringify({ name }) });
    },
    async deleteTournament(tournamentId) {
      await request(`/api/admin/tournaments/${tournamentId}`, { method: "DELETE" });
      set((state) => ({ cards: state.cards.filter((card) => card.tournamentId !== tournamentId), error: null }));
    },
    async loadArchives() {
      const archives = await request<TournamentArchive[]>("/api/archives");
      set({ archives });
      return archives;
    },
    async archiveTournament(tournamentId) {
      await request(`/api/admin/tournaments/${tournamentId}/archive`, { method: "POST" });
      const archives = await request<TournamentArchive[]>("/api/archives");
      set((state) => ({ cards: state.cards.filter((card) => card.tournamentId !== tournamentId), archives, error: null }));
    },
    async deleteArchive(archiveId) {
      await request(`/api/admin/archives/${archiveId}`, { method: "DELETE" });
      set((state) => ({ archives: state.archives.filter((archive) => archive.id !== archiveId), error: null }));
    },
    async setTournamentStatus(tournamentId, open) {
      await request(`/api/admin/tournaments/${tournamentId}/status`, { method: "PATCH", body: JSON.stringify({ open }) });
    },
    async grantStaffTournament(username, tournamentId) {
      await request(`/api/director/staff/${encodeURIComponent(username)}/tournaments`, { method: "POST", body: JSON.stringify({ tournamentId }) });
    },
    async revokeStaffTournament(username, tournamentId) {
      await request(`/api/director/staff/${encodeURIComponent(username)}/tournaments/${tournamentId}`, { method: "DELETE" });
    },
    async listDirectors() {
      return request<ManagedUser[]>("/api/admin/directors");
    },
    async createDirector(username, password, tournamentIds) {
      await request("/api/admin/directors", { method: "POST", body: JSON.stringify({ username, password, tournamentIds }) });
    },
    async deleteDirector(username) {
      await request(`/api/admin/directors/${encodeURIComponent(username)}`, { method: "DELETE" });
    },
    async assignDirector(tournamentId, username) {
      await request(`/api/admin/tournaments/${tournamentId}/directors`, { method: "POST", body: JSON.stringify({ username }) });
    },
    async unassignDirector(tournamentId, username) {
      await request(`/api/admin/tournaments/${tournamentId}/directors/${encodeURIComponent(username)}`, { method: "DELETE" });
    },
    async setAccountEnabled(scope, username, enabled) {
      const base = scope === "directors" ? "/api/admin/directors" : "/api/director/staff";
      await request(`${base}/${encodeURIComponent(username)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    },
    async resetAccountPassword(scope, username, password) {
      const base = scope === "directors" ? "/api/admin/directors" : "/api/director/staff";
      await request(`${base}/${encodeURIComponent(username)}/password`, { method: "POST", body: JSON.stringify({ password }) });
    },
    async listStaff() {
      return request<ManagedUser[]>("/api/director/staff");
    },
    async createStaff(username, password) {
      await request("/api/director/staff", { method: "POST", body: JSON.stringify({ username, password }) });
    },
    async deleteStaff(username) {
      await request(`/api/director/staff/${encodeURIComponent(username)}`, { method: "DELETE" });
    },
  };
});

export const selectCard = (cards: TournamentCard[], cardId: string) => cards.find((card) => card.id === cardId);
export const rankPlayers = (players: Player[]) => [...players].sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff || a.id.localeCompare(b.id));
