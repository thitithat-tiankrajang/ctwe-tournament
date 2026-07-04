"use client";

import { create } from "zustand";
import type { AuditEntry, CreateCardInput, ManagedUser, Pairing, Player, PublicCardSummary, PublicTournamentSummary, Tournament, TournamentCard } from "@/domain/tournament/types";

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

/** Admin-managed realtime tuning; mirrors /api/admin/settings/realtime. */
export interface RealtimeSettings {
  realtimeEnabled: boolean;
  sseEnabled: boolean;
  pollingEnabled: boolean;
  maxPublicSseConnections: number;
  maxStaffSseConnections: number;
  pollingIntervalMs: number;
  heartbeatIntervalMs: number;
  reconnectDelayMs: number;
  activePublicStreams: number;
  activeStaffStreams: number;
  updatedAt: string | null;
}

export type RealtimeSettingsInput = Omit<RealtimeSettings, "activePublicStreams" | "activeStaffStreams" | "updatedAt">;

interface TournamentState {
  cards: TournamentCard[];
  auth: AuthState;
  loading: boolean;
  error: string | null;
  activeTournament: ActiveTournament | null;
  archives: TournamentArchive[];
  setActiveTournament: (tournament: ActiveTournament | null) => void;
  load: () => Promise<void>;
  refreshPublicCatalog: (versionToken?: string) => Promise<PublicCardSummary[]>;
  syncCard: (cardId: string, publicVersion?: number) => Promise<void>;
  applyCardState: (card: TournamentCard) => void;
  applyResultPatch: (cardId: string, version: number, changedPairings: Pairing[]) => boolean;
  loadAudit: (cardId: string) => Promise<AuditEntry[]>;
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
  swapPlayers: (cardId: string, firstId: string, secondId: string, password: string, confirmSchoolConflict?: boolean) => Promise<void>;
  confirmPairingPreview: (cardId: string) => Promise<void>;
  publishNextPairing: (cardId: string) => Promise<void>;
  submitResult: (cardId: string, pairingId: string, scoreOne: number, scoreTwo: number, editExisting?: boolean) => Promise<void>;
  overrideResult: (cardId: string, matchId: string, scoreOne: number, scoreTwo: number) => Promise<void>;
  applyPenalty: (cardId: string, matchId: string, points: number, password: string) => Promise<void>;
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
  // public (anonymous) link-scoped entry
  loadPublicTournaments: () => Promise<PublicTournamentSummary[]>;
  loadPublicArchives: () => Promise<TournamentArchive[]>;
  resolveTournamentToken: (token: string) => Promise<PublicTournamentSummary>;
  // tenant + account management
  loadTournaments: () => Promise<Tournament[]>;
  createTournament: (name: string) => Promise<Tournament>;
  deleteTournament: (tournamentId: string) => Promise<void>;
  loadArchives: () => Promise<TournamentArchive[]>;
  archiveTournament: (tournamentId: string) => Promise<void>;
  deleteArchive: (archiveId: string) => Promise<void>;
  setTournamentStatus: (tournamentId: string, open: boolean, password: string) => Promise<void>;
  loadRealtimeSettings: () => Promise<RealtimeSettings>;
  updateRealtimeSettings: (settings: RealtimeSettingsInput) => Promise<RealtimeSettings>;
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
const STAFF_SESSION_MARKER = "CTWE_STAFF";
const CSRF_COOKIE = "XSRF-TOKEN";

function hasStaffSessionHint() {
  return typeof document !== "undefined"
    && document.cookie.split(";").some((item) => item.trim() === `${STAFF_SESSION_MARKER}=1`);
}

function clearStaffSessionHint() {
  if (typeof document !== "undefined")
    document.cookie = `${STAFF_SESSION_MARKER}=; Path=/; Max-Age=0; SameSite=Strict`;
}

function clearCsrfCookie() {
  if (typeof document !== "undefined")
    document.cookie = `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`;
}

export function readActiveTournament(): ActiveTournament | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_TOURNAMENT_KEY);
    const parsed = raw ? JSON.parse(raw) as ActiveTournament : null;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch { return null; }
}

function publicSummaryCard(summary: PublicCardSummary): TournamentCard {
  return {
    id: summary.id,
    tournamentId: summary.tournamentId,
    name: summary.name,
    division: summary.division,
    status: summary.status,
    runtimeStage: summary.runtimeStage,
    currentGame: summary.currentGame,
    version: summary.version,
    games: [],
    rules: [],
    players: [],
    tables: [],
    snapshots: [],
    audit: [],
    finalType: "NONE",
    finalGames: 0,
    finalRound: null,
    gibsonEnabled: false,
    createdAt: summary.createdAt,
    playerCount: summary.playerCount,
    gameCount: summary.gameCount,
    publishedGameCount: summary.publishedGameCount,
    summaryOnly: true,
  };
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
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    return body ? JSON.parse(body) as T : undefined as T;
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

  const fetchPublicCatalog = async (versionToken?: string) => {
    const suffix = versionToken ? `?v=${encodeURIComponent(versionToken)}` : "";
    const response = await fetch(`/api/public/cards${suffix}`, { credentials: "omit" });
    if (!response.ok) throw new Error(await readError(response));
    return response.json() as Promise<PublicCardSummary[]>;
  };

  const mergePublicCatalog = (summaries: PublicCardSummary[]) => set((state) => {
    const existing = new Map(state.cards.map((card) => [card.id, card]));
    return {
      cards: summaries.map((summary) => {
        const card = existing.get(summary.id);
        if (card && !card.summaryOnly && card.version === summary.version) {
          return {
            ...card,
            name: summary.name,
            division: summary.division,
            status: summary.status,
            runtimeStage: summary.runtimeStage,
            currentGame: summary.currentGame,
            playerCount: summary.playerCount,
            gameCount: summary.gameCount,
            publishedGameCount: summary.publishedGameCount,
          };
        }
        return publicSummaryCard(summary);
      }),
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

  const applyResultPatch = (cardId: string, version: number, changedPairings: Pairing[]) => {
    let patched = false;
    set((state) => ({
      cards: state.cards.map((card) => {
        if (card.id !== cardId) return card;
        if (card.version >= version) {
          patched = true;
          return card;
        }
        const index = card.snapshots.findIndex((snapshot) => !snapshot.confirmedAt);
        if (index < 0) return card;
        patched = true;
        const changes = new Map(changedPairings.map((pairing) => [pairing.id, pairing]));
        const existingIds = new Set(card.snapshots[index].pairings.map((pairing) => pairing.id));
        const merged = card.snapshots[index].pairings
          .map((pairing) => changes.get(pairing.id) ?? pairing)
          .concat(changedPairings.filter((pairing) => !existingIds.has(pairing.id)))
          .sort((a, b) => (a.gameNumber ?? 0) - (b.gameNumber ?? 0) || a.tableNumber - b.tableNumber);
        const snapshots = card.snapshots.map((snapshot, i) =>
          i === index ? { ...snapshot, pairings: merged } : snapshot);
        return { ...card, snapshots, version };
      }),
      error: null,
    }));
    return patched;
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
    async syncCard(cardId, publicVersion) {
      // Background live-sync for concurrent multi-user editing: pull the latest card, ignore transient errors.
      try {
        const backOffice = get().auth.authenticated;
        const expectedPublicVersion = publicVersion ?? get().cards.find((card) => card.id === cardId)?.version;
        const publicVersionQuery = expectedPublicVersion === undefined
          ? ""
          : `?v=${encodeURIComponent(expectedPublicVersion)}`;
        const response = await fetch(
          backOffice ? `/api/cards/${cardId}` : `/api/public/cards/${cardId}${publicVersionQuery}`,
          backOffice
            ? { credentials: "same-origin", cache: "no-store" }
            : { credentials: "omit" },
        );
        if (response.ok) replaceCard(await response.json() as TournamentCard);
        else if (response.status === 404) set((state) => ({ cards: state.cards.filter((card) => card.id !== cardId), error: null }));
      } catch { /* transient network/poll error — keep current state */ }
    },
    applyCardState: replaceCard,
    applyResultPatch,
    async loadAudit(cardId) {
      // Audit is no longer in the card payload (kept the hot path cheap); fetch it on demand for the audit page.
      return request<AuditEntry[]>(`/api/cards/${cardId}/audit`);
    },
    async refreshAuth() {
      try {
        const auth = await request<AuthState>("/api/auth/me");
        set({ auth });
        if (!auth.authenticated) clearStaffSessionHint();
      } catch {
        set({ auth: anonymous });
        clearStaffSessionHint();
      }
    },
    async load() {
      set({ loading: true, error: null });
      try {
        let auth = anonymous;
        if (hasStaffSessionHint()) {
          const authResponse = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
          if (!authResponse.ok) throw new Error(await readError(authResponse));
          auth = await authResponse.json() as AuthState;
          if (!auth.authenticated) clearStaffSessionHint();
        }
        let cards: TournamentCard[];
        if (auth.authenticated) {
          const response = await fetch("/api/cards", { credentials: "same-origin", cache: "no-store" });
          if (!response.ok) throw new Error(await readError(response));
          cards = await response.json() as TournamentCard[];
        } else {
          cards = (await fetchPublicCatalog()).map(publicSummaryCard);
        }
        set({ auth, cards, loading: false });
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : "ไม่สามารถเชื่อมต่อ API ได้" });
      }
    },
    async refreshPublicCatalog(versionToken) {
      if (get().auth.authenticated) return [];
      const summaries = await fetchPublicCatalog(versionToken);
      mergePublicCatalog(summaries);
      return summaries;
    },
    async login(username, password) {
      // Logout invalidates the server session. Always mint a token for the current anonymous
      // session instead of reusing the token that existed before logout.
      clearCsrfCookie();
      const authResponse = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!authResponse.ok) throw new Error(`เตรียม session เข้าสู่ระบบไม่สำเร็จ (${authResponse.status})`);
      const freshAuth = await authResponse.json() as AuthState;
      set({ auth: freshAuth });

      const body = new URLSearchParams({ username, password, _csrf: freshAuth.csrfToken });
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
      await get().load();
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
      clearStaffSessionHint();
      clearCsrfCookie();
      set({ auth: anonymous });
      await get().load();
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
    async swapPlayers(cardId, firstId, secondId, password, confirmSchoolConflict = false) {
      await mutateCard(`/api/cards/${cardId}/tables/swap`, cardId, {
        method: "POST",
        body: JSON.stringify({ firstPlayerId: firstId, secondPlayerId: secondId, password, confirmSchoolConflict }),
      });
    },
    async confirmPairingPreview(cardId) {
      await mutateCard(`/api/cards/${cardId}/pairings/confirm`, cardId, { method: "POST" });
    },
    async publishNextPairing(cardId) {
      await mutateCard(`/api/cards/${cardId}/pairings/publish-next`, cardId, { method: "POST" });
    },
    async submitResult(cardId, pairingId, scoreOne, scoreTwo, editExisting = false) {
      // Hot path: the server returns just the in-progress block's pairings (+ version), not the whole card.
      const patch = await request<{ version: number; changedPairings: Pairing[] }>(
        `/api/cards/${cardId}/matches/${pairingId}/result`,
        { method: "PUT", body: JSON.stringify({ scoreOne, scoreTwo, editExisting }) },
      );
      const patched = applyResultPatch(cardId, patch.version, patch.changedPairings);
      if (!patched) await get().syncCard(cardId); // safety net: pull the full card if we couldn't patch in place
    },
    async overrideResult(cardId, matchId, scoreOne, scoreTwo) {
      await mutateCard(`/api/cards/${cardId}/matches/${matchId}/override`, cardId, {
        method: "PUT",
        body: JSON.stringify({ scoreOne, scoreTwo, editExisting: true }),
      });
    },
    async applyPenalty(cardId, matchId, points, password) {
      await mutateCard(`/api/cards/${cardId}/matches/${matchId}/penalty`, cardId, {
        method: "POST",
        body: JSON.stringify({ points, password }),
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

    // ---- public (anonymous) link-scoped entry ----
    async loadPublicTournaments() {
      const response = await fetch("/api/public/tournaments", { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      return response.json() as Promise<PublicTournamentSummary[]>;
    },
    async loadPublicArchives() {
      const response = await fetch("/api/public/archives", { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      return response.json() as Promise<TournamentArchive[]>;
    },
    async resolveTournamentToken(token) {
      const response = await fetch(`/api/public/tournaments/${encodeURIComponent(token)}`, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      return response.json() as Promise<PublicTournamentSummary>;
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
      if (!get().auth.roles.includes("ROLE_ADMIN")) {
        set({ archives: [] });
        return [];
      }
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
    async setTournamentStatus(tournamentId, open, password) {
      await request(`/api/admin/tournaments/${tournamentId}/status`, { method: "PATCH", body: JSON.stringify({ open, password }) });
    },
    async loadRealtimeSettings() {
      return request<RealtimeSettings>("/api/admin/settings/realtime");
    },
    async updateRealtimeSettings(settings) {
      return request<RealtimeSettings>("/api/admin/settings/realtime", { method: "PUT", body: JSON.stringify(settings) });
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
