"use client";

import Link from "next/link";
import { ArrowRight, ClipboardCheck, Hourglass, LockKeyhole, Megaphone, Trophy, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { canManageTournament, hasStaffAccess, isAdmin } from "@/domain/tournament/roles";
import { finalStandings, rankingAfterGame } from "@/domain/tournament/history";
import { comparePlayerCodes } from "@/domain/tournament/player-code";
import type { FinalSlot, Pairing, PairingSnapshot, Player, RuntimeStage, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { FinalRoundBoard } from "@/ui/components/final-round-board";
import { DocumentDownloadPanel } from "@/ui/components/document-download-panel";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { SelectMenu } from "@/ui/components/select-menu";
import { stageLabels } from "@/ui/components/stage-info";
import { OverviewRecordFilter, type OverviewRecordFilterValue } from "@/ui/components/overview-record-filter";

export type OverviewView = "ranking" | "pairing" | "result";

const publishedAtText = (iso: string) =>
  `เผยแพร่ผลเมื่อ ${new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}`;

function workflowHref(cardId: string, stage: RuntimeStage) {
  if (stage === "PLAYER_REGISTRATION") return `/cards/${cardId}/players`;
  if (stage === "TABLE_PAIRING" || stage === "PAIRING_PREVIEW") return `/cards/${cardId}/tables`;
  if (stage === "RESULT_COLLECTION" || stage === "RESULT_REVIEW" || stage === "FINAL_SEEDING" || stage === "FINAL_COLLECTION") return `/cards/${cardId}/games`;
  return `/cards/${cardId}`;
}

/** Seat number for a player in a pairing (seat 1 = couple n → seats 2n-1 / 2n). */
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;
const athleteName = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "";

/** Two-line athlete cell: name (black) over school (dark grey), shared by pairing + result viewers. */
function AthleteCell({ player, gibsonized = false }: { player?: Player; gibsonized?: boolean }) {
  const name = athleteName(player);
  return (
    <div className="cell-athlete">
      <span className="cell-athlete__name" title={name}><span>{name}</span>{gibsonized && <span className="gibson-mark">GIB</span>}</span>
      <span className="cell-athlete__school" title={player?.school}>{player?.school ?? ""}</span>
    </div>
  );
}

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne != null && pairing.scoreTwo != null && Boolean(pairing.resultType);
}

/**
 * The overview shows what the audience is meant to see. Rows of an unconfirmed snapshot count only
 * once the director published them: PAIR_RESULT materialises the destination game's pairings while
 * the source game is still being scored, and those stay backstage (even for logged-in staff, whose
 * card payload contains them) until the explicit "Publish Pairing" milestone.
 */
function overviewPairings(snapshot: PairingSnapshot) {
  return snapshot.confirmedAt ? snapshot.pairings : snapshot.pairings.filter((pairing) => pairing.pairingPublished);
}

/** Games of a snapshot that have at least one overview-visible pairing row. */
function overviewGames(snapshot: PairingSnapshot) {
  if (snapshot.confirmedAt) return snapshot.gameNumbers;
  const games = new Set(overviewPairings(snapshot).map((pairing) => pairing.gameNumber ?? snapshot.gameNumbers[0]));
  return snapshot.gameNumbers.filter((game) => games.has(game));
}

function RankingTable({ players, rankingPositions, selectedId, onPlayerClick, resizableColumns }: {
  players: ReturnType<typeof rankingAfterGame>;
  rankingPositions?: Map<string, number>;
  selectedId?: string | null;
  onPlayerClick?: (player: Player) => void;
  resizableColumns: boolean;
}) {
  const rows = players.map((player, index) => ({ player, rank: rankingPositions?.get(player.id) ?? index + 1 }));
  const columns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 48, width: 58, align: "center", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัส", min: 50, width: 60, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: ({ player }) => player.id, render: ({ player }) => player.id },
    { key: "name", label: "ชื่อ - นามสกุล", min: 120, width: 250, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 120, width: 250, cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนสะสม", min: 76, width: 90, align: "center", value: ({ player }) => player.winPoints, render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 82, width: 96, align: "center", value: ({ player }) => player.diff, filterable: false, render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
  ];
  return <DataGrid ariaLabel="ตารางอันดับ" columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:ranking:v3" tableClassName="entry-grid--ranking" emptyText="ไม่พบผู้เล่นตามตัวกรอง" resizableColumns={resizableColumns} onRowClick={onPlayerClick ? (row) => onPlayerClick(row.player) : undefined} rowClassName={selectedId ? (row) => row.player.id === selectedId ? "egrid-row--active" : undefined : undefined} />;
}

/**
 * Final placings shown after the whole card is done: only rank / name / school (no points), and a
 * click opens the player's master card. The championship result is already baked into the order.
 */
function FinalResultsList({ standings, onPlayerClick, resizableColumns }: {
  standings: Player[];
  onPlayerClick: (playerId: string) => void;
  resizableColumns: boolean;
}) {
  const rows = standings.map((player, index) => ({ player, rank: index + 1 }));
  const columns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 48, width: 64, align: "center", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "name", label: "ชื่อ - นามสกุล", min: 140, width: 300, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 140, width: 320, cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
  ];
  return <DataGrid ariaLabel="ผลรอบชิงชนะเลิศ" columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:final-result" tableClassName="entry-grid--ranking" emptyText="ยังไม่มีผลการแข่งขัน" resizableColumns={resizableColumns} onRowClick={(row) => onPlayerClick(row.player.id)} />;
}

function PairingGrid({ pairings, players, resizableColumns }: { pairings: Pairing[]; players: Map<string, Player>; resizableColumns: boolean }) {
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const columns: DataColumn<Pairing>[] = [
    { key: "seat1", label: "ที่นั่ง", min: 38, width: 50, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 1), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 1) },
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 150, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerOneId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} gibsonized={pairing.playerOneGibsonized} /> },
    { key: "vs", label: "", min: 42, width: 56, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    { key: "seat2", label: "ที่นั่ง", min: 38, width: 50, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 2), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 2) },
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 150, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} gibsonized={pairing.playerTwoGibsonized} /> },
  ];
  return <DataGrid ariaLabel="ตารางประกบคู่" columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey="overview:pairing" tableClassName="entry-grid--match" emptyText="ไม่พบคู่ตามตัวกรอง" resizableColumns={resizableColumns} rowClassName={(pairing) => pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "egrid-row--gibson" : undefined} />;
}

function ResultTable({ pairings, players, storageKey, resizableColumns }: { pairings: Pairing[]; players: Map<string, Player>; storageKey: string; resizableColumns: boolean }) {
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const scoreText = (pairing: Pairing) => pairing.resultType === "PENALTY" ? "ลงดาบ" : isRecorded(pairing) ? `${pairing.scoreOne} - ${pairing.scoreTwo}` : "—";
  const longestScore = pairings.reduce((longest, pairing) => Math.max(longest, scoreText(pairing).length), "คะแนน".length);
  const diffOf = (pairing: Pairing) => !isRecorded(pairing) ? null : pairing.resultType === "DRAW" ? 0 : pairing.calculatedDiff ?? 0;
  const diffText = (pairing: Pairing) => {
    if (!isRecorded(pairing)) return "—";
    if (pairing.resultType === "PENALTY") return `−${pairing.calculatedDiff ?? 0}`;
    const diff = diffOf(pairing);
    return diff === 0 ? "0" : `${diff}`;
  };
  const columns: DataColumn<Pairing>[] = [
    { key: "seat1", label: "ที่นั่ง", min: 36, width: 48, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 1), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 1) },
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 140, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerOneId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} gibsonized={pairing.playerOneGibsonized} /> },
    { key: "vs", label: "", min: 40, width: 52, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    { key: "seat2", label: "ที่นั่ง", min: 36, width: 48, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 2), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 2) },
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 140, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} gibsonized={pairing.playerTwoGibsonized} /> },
    { key: "score", label: "คะแนน", min: 36, width: 68, fitContent: true, align: "center", cellClassName: "cell-score", value: (pairing) => scoreText(pairing), filterable: false, render: (pairing) => scoreText(pairing) },
    { key: "diff", label: "ผลต่าง", min: 56, width: 68, align: "center", cellClassName: (pairing) => `cell-diff cell-diff--${pairing.resultType === "PENALTY" ? "penalty" : "win"}`, value: (pairing) => diffOf(pairing) ?? -1, filterable: false, render: (pairing) => diffText(pairing) },
  ];
  return <DataGrid ariaLabel="ตารางผลการแข่งขัน" columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={`${storageKey}:layout-v4:score-content-${longestScore}`} tableClassName="entry-grid--match" emptyText="ไม่พบคู่ตามตัวกรอง" resizableColumns={resizableColumns} rowClassName={(pairing) => pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "egrid-row--gibson" : undefined} />;
}

function FinalHistoryDialog({ slot, players, onClose }: { slot: FinalSlot; players: Map<string, Player>; onClose: () => void }) {
  const name = (id: string) => {
    const player = players.get(id);
    return player ? `${player.id} · ${player.firstName} ${player.lastName}` : id;
  };
  const school = (id: string) => players.get(id)?.school ?? "—";
  const winnerName = slot.winnerId ? name(slot.winnerId) : "ยังไม่สรุป";
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="history-table-dialog final-history-dialog" role="dialog" aria-modal="true" aria-labelledby="final-history-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>ประวัติรอบชิง</span><h2 id="final-history-title">{slot.slot === 0 ? "คู่ชิงอันดับ 1 - 2" : "คู่ชิงอันดับ 3 - 4"}</h2></div>
          <button type="button" className="confirm-dialog__close" aria-label="ปิดประวัติรอบชิง" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="final-history-matchup">
          <strong>{name(slot.playerOneId)}</strong><span>พบ</span><strong>{name(slot.playerTwoId)}</strong>
          <small>{school(slot.playerOneId)} · {school(slot.playerTwoId)}</small>
        </div>
        <table className="data-table final-history-table" aria-label="ประวัติเกมรอบชิงชนะเลิศ">
          <thead><tr><th scope="col">เกม</th><th scope="col" className="numeric">คะแนน</th><th scope="col">ผู้ชนะเกม</th><th scope="col" className="numeric">diff</th></tr></thead>
          <tbody>
            {slot.games.map((game) => (
              <tr key={game.gameIndex}>
                <td>เกม {game.gameIndex}</td>
                <td className="numeric">{game.scoreOne == null || game.scoreTwo == null ? "—" : `${game.scoreOne} - ${game.scoreTwo}`}</td>
                <td>{game.winnerId ? name(game.winnerId) : game.scoreOne != null && game.scoreTwo != null ? "เสมอ" : "—"}</td>
                <td className="numeric">{game.diff ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="final-history-summary">
          <CrownBadge />
          <strong>{winnerName}</strong>
          <span>ชนะ {slot.winnerWins ?? "—"} เกม · แพ้ {slot.winnerLosses ?? "—"} เกม · Total diff {slot.totalDiff == null ? "—" : `${slot.totalDiff > 0 ? "+" : ""}${slot.totalDiff}`}</span>
        </div>
      </section>
    </div>
  );
}

function CrownBadge() {
  return <span className="final-history-crown">★</span>;
}

/**
 * The card's current headline state, split into two signals with different jobs:
 *
 * - `forcedKey` changes ONLY on the big publishes — a pairing publish (`pairing:N`) or a ranking
 *   publish (`ranking:N`) — and steering follows it live: whoever is watching gets switched to
 *   that view the moment the director publishes.
 * - `entryView` additionally prefers Result once the game has its first recorded score, but it is
 *   applied only when (re)entering the card — a result trickling in never yanks the viewer away
 *   from whatever they chose to look at.
 */
function overviewViewState(card: TournamentCard | undefined): { forcedKey: string; forcedView: OverviewView; entryView: OverviewView; activeGame: number } | null {
  if (!card) return null;
  const visibleSnapshots = card.snapshots.filter((snapshot) =>
    Boolean(snapshot.confirmedAt)
    || card.runtimeStage !== "PAIRING_PREVIEW"
    || !snapshot.gameNumbers.includes(card.currentGame));
  const latestGame = Math.max(0, ...visibleSnapshots.flatMap(overviewGames));
  const activeGame = latestGame > 0 ? latestGame : card.currentGame;
  const snapshot = visibleSnapshots.find((item) => overviewGames(item).includes(activeGame));
  if (!snapshot) return null;
  if (snapshot.confirmedAt) return { forcedKey: `ranking:${activeGame}`, forcedView: "ranking", entryView: "ranking", activeGame };
  const currentPairings = overviewPairings(snapshot).filter((pairing) => (pairing.gameNumber ?? activeGame) === activeGame);
  // Loose != : an unscored pairing arrives with the score fields OMITTED (undefined), not null.
  const hasFirstResult = currentPairings.some((pairing) => pairing.scoreOne != null || pairing.scoreTwo != null);
  return { forcedKey: `pairing:${activeGame}`, forcedView: "pairing", entryView: hasFirstResult ? "result" : "pairing", activeGame };
}

/**
 * True on phone-width screens (D15/UX-F3).
 *
 * `useSyncExternalStore` rather than an effect so the very first client render already has the right
 * answer and hydration does not warn: the server snapshot is the desktop default, which is also the
 * safe one — multi-select degrades to "you can open more than one panel", never to a lost view.
 */
function useNarrowViewport() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW_VIEWPORT);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(NARROW_VIEWPORT).matches,
    () => false,
  );
}

const NARROW_VIEWPORT = "(max-width: 768px)";

/**
 * What the view picker shows after tapping `view` (D15/UX-F3).
 *
 * Desktop keeps multi-select: the panels sit side by side, and comparing Pairing against Ranking is
 * the whole reason a spectator opens both. A phone shows one panel per screenful, so "adding" a
 * second only buries the first under a scroll — there, picking a view REPLACES the current one.
 * Deselecting the only open view is allowed in both modes, so the tables can be collapsed away.
 *
 * Pure and exported so the rule is testable without a DOM; the component only supplies `narrow`.
 */
export function nextOverviewViews(
  current: ReadonlySet<OverviewView>,
  view: OverviewView,
  narrow: boolean,
): Set<OverviewView> {
  if (narrow) return current.has(view) ? new Set<OverviewView>() : new Set<OverviewView>([view]);
  const next = new Set(current);
  if (next.has(view)) next.delete(view); else next.add(view);
  return next;
}

/** What a publish announcement says. The viewer chooses to follow it; nothing moves on its own. */
const announcementCopy: Record<OverviewView, (game: number) => { text: string; action: string }> = {
  ranking: (game) => ({ text: `ประกาศอันดับของเกม ${game} แล้ว`, action: "ดูอันดับ" }),
  pairing: (game) => ({ text: `ประกาศคู่แข่งขันของเกม ${game} แล้ว`, action: "ดูคู่แข่งขัน" }),
  result: (game) => ({ text: `มีผลการแข่งขันใหม่ของเกม ${game}`, action: "ดูผล" }),
};

/** Read-only card overview (ranking / pairing / results) shared by /cards/[id] and the /tour viewer. */
export function CardOverview({ cardId: id }: { cardId: string }) {
  const cards = useTournamentStore((state) => state.cards);
  const loading = useTournamentStore((state) => state.loading);
  const closeCard = useTournamentStore((state) => state.closeCard);
  const auth = useTournamentStore((state) => state.auth);
  const resizableColumns = hasStaffAccess(auth);
  const card = selectCard(cards, id);
  const [historyGame, setHistoryGame] = useState<number | "final" | "result" | null>(null);
  const [views, setViews] = useState<Set<OverviewView>>(new Set<OverviewView>());
  const [selectedRankingPlayerId, setSelectedRankingPlayerId] = useState<string | null>(null);
  const [historyPlayerId, setHistoryPlayerId] = useState<string | null>(null);
  const [finalHistorySlot, setFinalHistorySlot] = useState<FinalSlot | null>(null);
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [recordFilter, setRecordFilter] = useState<OverviewRecordFilterValue>({ mode: "player", playerIds: [], schools: [] });
  /** A publish the viewer has been TOLD about but has not chosen to follow yet (D15/UX-F3). */
  const [announcement, setAnnouncement] = useState<{ view: OverviewView; game: number } | null>(null);
  const narrow = useNarrowViewport();
  const viewState = overviewViewState(card);
  const enteredCardRef = useRef<string | null>(null);
  const appliedForcedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setRecordFilter({ mode: "player", playerIds: [], schools: [] });
  }, [id]);

  // Entering a card still applies the entry default (Result once a first score exists) — that is the
  // opening state, not a jump.
  //
  // What a publish does has CHANGED (D15/UX-F3). It used to replace the viewer's selection outright:
  // whatever you were reading was swapped for Pairing or Ranking the instant the director published.
  // For a spectator following one player mid-table that is the screen being taken away, and it is
  // worse on a phone where the swapped-in panel fills the viewport. A publish now raises a banner and
  // the viewer decides. Nothing moves until they tap it.
  //
  // Still keyed on forcedKey advancing, so a re-run with the same key (StrictMode double-invoke, an
  // unrelated re-render) neither re-announces nor disturbs the current selection.
  useEffect(() => {
    if (!viewState) return;
    if (enteredCardRef.current !== id) {
      enteredCardRef.current = id;
      appliedForcedKeyRef.current = viewState.forcedKey;
      setAnnouncement(null);
      setViews(new Set<OverviewView>([viewState.entryView]));
      return;
    }
    if (appliedForcedKeyRef.current === viewState.forcedKey) return;
    appliedForcedKeyRef.current = viewState.forcedKey;
    setAnnouncement({ view: viewState.forcedView, game: viewState.activeGame });
  }, [id, viewState?.forcedKey]);

  useEffect(() => {
    if (!selectedRankingPlayerId) return;
    const clearSelectionOutsideTable = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".overview-ranking-panel")) return;
      setSelectedRankingPlayerId(null);
    };
    document.addEventListener("pointerdown", clearSelectionOutsideTable);
    return () => document.removeEventListener("pointerdown", clearSelectionOutsideTable);
  }, [selectedRankingPlayerId]);

  if (loading || card?.summaryOnly) return <div className="panel panel-padding">กำลังโหลดข้อมูลการแข่งขัน…</div>;
  if (!card) return <CardNotFound />;
  const canManage = canManageTournament(auth);
  const visibleSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt) || card.runtimeStage !== "PAIRING_PREVIEW" || !snapshot.gameNumbers.includes(card.currentGame));
  const publishedSnapshots = visibleSnapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const publishedGames = new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const visibleGames = new Set(visibleSnapshots.flatMap(overviewGames));
  const hasFinalRound = card.finalType !== "NONE" && Boolean(card.finalRound);
  const finalActive = hasFinalRound && (card.runtimeStage === "FINAL_COLLECTION" || card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED");
  const latestVisibleGame = Math.max(0, ...visibleSnapshots.flatMap(overviewGames));
  const currentVisibleGame = latestVisibleGame > 0 ? latestVisibleGame : card.currentGame;
  const selectedFinal = hasFinalRound && (historyGame === "final" || (historyGame == null && finalActive));
  const selectedResultSummary = historyGame === "result";
  const selectedGame = typeof historyGame === "number" && visibleGames.has(historyGame) ? historyGame : currentVisibleGame;
  const selectedSnapshot = visibleSnapshots.find((snapshot) => overviewGames(snapshot).includes(selectedGame));
  const selectedPairings = selectedSnapshot ? overviewPairings(selectedSnapshot).filter((pairing) => (pairing.gameNumber ?? selectedGame) === selectedGame) : [];
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const historicalRanking = selectedGame > 0 ? rankingAfterGame(rankingCard, selectedGame) : [...card.players].filter((player) => !player.terminated).sort((a, b) => comparePlayerCodes(a.id, b.id));
  const rankingPositions = new Map(historicalRanking.map((player, index) => [player.id, index + 1]));
  const players = new Map(card.players.map((player) => [player.id, player]));
  const activeRecordValues = recordFilter.mode === "player" ? recordFilter.playerIds : recordFilter.schools;
  const recordFilterActive = activeRecordValues.length > 0;
  const matchesRecordFilter = (playerId: string | null) => {
    if (!recordFilterActive || !playerId) return !recordFilterActive;
    return recordFilter.mode === "player"
      ? recordFilter.playerIds.includes(playerId)
      : recordFilter.schools.includes(players.get(playerId)?.school ?? "");
  };
  const visibleRanking = recordFilterActive
    ? historicalRanking.filter((player) => matchesRecordFilter(player.id))
    : historicalRanking;
  const visiblePairings = recordFilterActive
    ? selectedPairings.filter((pairing) => matchesRecordFilter(pairing.playerOneId) || matchesRecordFilter(pairing.playerTwoId))
    : selectedPairings;
  const selectedResultsPublished = Boolean(selectedSnapshot?.confirmedAt);
  // Loose != : an unscored pairing arrives with the score fields OMITTED (undefined), not null.
  const selectedHasResults = selectedPairings.some((pairing) => pairing.scoreOne != null || pairing.scoreTwo != null);
  const selectedResultsVisible = selectedResultsPublished || selectedHasResults;
  const viewUnavailable: Record<OverviewView, boolean> = {
    ranking: historicalRanking.length === 0,
    pairing: selectedPairings.length === 0,
    result: !selectedResultsVisible,
  };
  const viewUnavailableTitle: Record<OverviewView, string> = {
    ranking: "Ranking จะเปิดให้ดูเมื่อมีรายชื่อผู้เล่น",
    pairing: "Pairing จะเปิดให้ดูเมื่อเผยแพร่คู่แข่งขันของเกมนี้",
    result: "Result จะเปิดให้ดูเมื่อมีการบันทึกคะแนนคู่แรกของเกมนี้",
  };
  const historyPlayer = historyPlayerId ? players.get(historyPlayerId) : undefined;
  const historyUpToGame = selectedResultSummary ? Number.MAX_SAFE_INTEGER : selectedGame;
  const historyCard = { ...rankingCard, snapshots: publishedSnapshots.filter((snapshot) => Math.max(...snapshot.gameNumbers) <= historyUpToGame) };
  const final = card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED";
  const canClose = card.status === "FINISHED" && canManage;
  // Final placings (bracket-aware) for the "ผลการแข่งขัน" view, shown once the card is finished.
  const finalResults = selectedResultSummary ? finalStandings(rankingCard, latestVisibleGame) : [];
  const gameOptions = [...visibleGames].sort((a, b) => a - b)
    .map((game) => ({ value: String(game), label: `เกม ${game}` }))
    .concat(hasFinalRound ? [{ value: "final", label: "รอบชิง" }] : [])
    .concat(final ? [{ value: "result", label: "ผลการแข่งขัน" }] : []);
  // Desktop keeps multi-select: the panels sit side by side, and comparing Pairing against Ranking
  // is the whole reason a spectator opens both. A phone shows one panel per screenful, so "adding" a
  // second only buries the first under a scroll — there, picking a view REPLACES the current one
  // (D15/UX-F3). Deselecting the only open view is allowed on both, so the tables can be collapsed.
  const toggleView = (view: OverviewView) => {
    const opening = !views.has(view);
    setViews((prev) => nextOverviewViews(prev, view, narrow));
    // Opening the view a banner was offering answers it; leaving it up would be nagging.
    if (opening && announcement?.view === view) setAnnouncement(null);
    if (opening && narrow) {
      window.setTimeout(() => document.getElementById(`overview-view-${view}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };

  /** Follow a publish announcement: go to the game it is about, open its view, clear the banner. */
  const followAnnouncement = () => {
    if (!announcement) return;
    setHistoryGame(null);
    setViews((prev) => narrow ? new Set<OverviewView>([announcement.view]) : new Set(prev).add(announcement.view));
    setAnnouncement(null);
    if (narrow) {
      window.setTimeout(() => document.getElementById(`overview-view-${announcement.view}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };
  const selectRankingPlayer = (player: Player) => {
    if (selectedRankingPlayerId === player.id) {
      setHistoryPlayerId(player.id);
      return;
    }
    setSelectedRankingPlayerId(player.id);
    setHistoryPlayerId(null);
  };

  return (
    <>
      <PageHeader
        className={`overview-page-header${final ? " overview-page-header--complete" : ""}`}
        title={<>{card.name}{card.division && <span className="page-title-inline-subtitle">{card.division}</span>}</>}
        actions={(visibleSnapshots.length > 0 || final) ? (
          <div className="overview-header-actions">
            {visibleSnapshots.length > 0 && (
              <div className="overview-header-controls">
                <div className="overview-game-filter-row">
                  {!selectedFinal && !selectedResultSummary && <OverviewRecordFilter players={card.players.filter((player) => !player.terminated)} value={recordFilter} onChange={setRecordFilter} />}
                  <div className="overview-game-menu-wrap">
                    <SelectMenu
                      ariaLabel="เลือกเกม"
                      className="overview-game-menu"
                      value={selectedResultSummary ? "result" : selectedFinal ? "final" : String(selectedGame)}
                      options={gameOptions}
                      onChange={(value) => setHistoryGame(value === "final" ? "final" : value === "result" ? "result" : Number(value))}
                      onOpenChange={setGameMenuOpen}
                    />
                  </div>
                </div>
                {/*
                  The roles follow the behaviour rather than the other way round: a phone picks ONE
                  view, which is a radio group, while desktop toggles several, which is aria-pressed.
                  Announcing a multi-select as radios (or the reverse) is exactly the mismatch UX-F3
                  filed — "a segmented picker that is really multi-select".
                */}
                {!selectedFinal && !selectedResultSummary && <div className="segmented overview-view-picker" role={narrow ? "radiogroup" : "group"} aria-label="เลือกมุมมอง">
                  {(["ranking", "pairing", "result"] as const).map((view) => {
                    const unavailable = viewUnavailable[view];
                    const active = views.has(view) && !unavailable;
                    const label = view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result";
                    return (
                      <button
                        key={view}
                        type="button"
                        className={`segment${active ? " segment--on" : ""}`}
                        role={narrow ? "radio" : undefined}
                        {...(narrow ? { "aria-checked": active } : { "aria-pressed": active })}
                        disabled={unavailable}
                        title={unavailable ? viewUnavailableTitle[view] : undefined}
                        onClick={() => toggleView(view)}
                      >{label}</button>
                    );
                  })}
                </div>}
              </div>
            )}
            {final && <Badge tone="warning">จบแล้ว</Badge>}
          </div>
        ) : undefined}
      />

      {/*
        D15/UX-F3: a publish used to swap the viewer's screen out from under them. It now announces
        itself and waits. `aria-live="polite"` so a screen reader hears it without being interrupted,
        and the dismiss is a real control rather than a timeout — an announcement the viewer has not
        acted on should still be there when they look up from the board.
      */}
      {announcement && !viewUnavailable[announcement.view] && (
        <div className="notice notice--info overview-announcement" role="status" aria-live="polite">
          <Megaphone size={20} />
          <p><strong>{announcementCopy[announcement.view](announcement.game).text}</strong></p>
          <div className="overview-announcement-actions">
            <Button size="sm" onClick={followAnnouncement}>
              {announcementCopy[announcement.view](announcement.game).action} <ArrowRight size={15} />
            </Button>
            <button
              type="button"
              className="overview-announcement-dismiss"
              aria-label="ปิดการแจ้งเตือน"
              onClick={() => setAnnouncement(null)}
            ><X size={16} /></button>
          </div>
        </div>
      )}

      {selectedFinal && card.finalRound && <FinalRoundBoard card={card} readOnly onSlotHistory={setFinalHistorySlot} />}

      {selectedResultSummary && (
        <Panel className="overview-data-panel overview-ranking-panel" title="ผลการแข่งขัน (อันดับสุดท้าย)" description={hasFinalRound ? "คำนวณผลรอบชิงแล้ว — ผู้ชนะคู่ชิงอยู่อันดับสูงกว่า" : undefined}>
          <FinalResultsList standings={finalResults} onPlayerClick={setHistoryPlayerId} resizableColumns={resizableColumns} />
        </Panel>
      )}

      {canManage && !final && (
        <div className="notice notice--info workflow-notice"><ClipboardCheck size={20} /><p><strong>ขั้นตอนปัจจุบัน: {stageLabels[card.runtimeStage]}</strong><span>เกม {card.currentGame} จาก {card.games.length} · ทำงานต่อในหน้าที่ระบบกำหนด</span></p><Link prefetch={false} href={workflowHref(id, card.runtimeStage)}><Button size="sm">ทำงานต่อ <ArrowRight size={15} /></Button></Link></div>
      )}

      {/* Spectators see why the latest game has nothing yet, instead of a silently stale screen. */}
      {!canManage && !final && !selectedFinal && visibleSnapshots.length > 0
        && latestVisibleGame < card.currentGame && card.currentGame <= card.games.length && (
        <div className="notice notice--info"><Hourglass size={18} /><p>
          <strong>{card.runtimeStage === "TABLE_PAIRING" || card.runtimeStage === "PAIRING_PREVIEW"
            ? `กำลังจัดคู่เกม ${card.currentGame}`
            : `เกม ${card.currentGame} กำลังแข่งขัน`}</strong>
          <span>ข้อมูลจะอัปเดตที่นี่อัตโนมัติทันทีที่เผยแพร่</span>
        </p></div>
      )}

      {!selectedFinal && !selectedResultSummary && (visibleSnapshots.length === 0 ? (
        card.players.length > 0 ? <>
          <Panel className="overview-data-panel overview-ranking-panel" title="Ranking เริ่มต้น">
            <RankingTable players={visibleRanking} rankingPositions={rankingPositions} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} />
          </Panel>
          <Panel><EmptyState icon={<Trophy size={26} />} title="ยังไม่มี Pairing ที่เผยแพร่" description="เมื่อผู้อำนวยการยืนยัน Pairing เกมแรก ตารางคู่แข่งขันจะปรากฏที่นี่ทันที" /></Panel>
        </> : <Panel><EmptyState icon={<Trophy size={26} />} title="กำลังรอรายชื่อผู้เล่น" description="รายชื่อและ Ranking เริ่มต้นจะปรากฏหลังผู้อำนวยการจบการลงทะเบียน" /></Panel>
      ) : (
        <>
          {views.size === 0 && <Panel><EmptyState icon={<ClipboardCheck size={24} />} title="ยังไม่ได้เลือกมุมมอง" description="เลือกมุมมอง ผลการจัดอันดับ / ผลประกบคู่ / ผลการแข่งขัน เพื่อแสดงข้อมูลที่ต้องการ" /></Panel>}

          {views.has("ranking") && (
            <Panel id="overview-view-ranking" className="overview-data-panel overview-view-section overview-ranking-panel" title={selectedResultsPublished ? `RANKING (ผลการจัดอันดับ หลังจบเกม ${selectedGame})` : selectedHasResults ? `RANKING (ผลการจัดอันดับ ก่อนจบเกม ${selectedGame})` : `RANKING (ผลการจัดอันดับ ก่อนเริ่มเกม ${selectedGame})`} description={selectedResultsPublished && selectedSnapshot?.confirmedAt ? publishedAtText(selectedSnapshot.confirmedAt) : undefined}>
              <RankingTable players={visibleRanking} rankingPositions={rankingPositions} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} />
            </Panel>
          )}

          {views.has("pairing") && (
            <Panel id="overview-view-pairing" className="overview-data-panel overview-view-section" title={`PAIRING (ผลประกบคู่ เกม ${selectedGame})`}>
              <PairingGrid pairings={visiblePairings} players={players} resizableColumns={resizableColumns} />
            </Panel>
          )}

          {views.has("result") && selectedResultsVisible && (
            <Panel id="overview-view-result" className="overview-data-panel overview-view-section" title={`RESULT (ผลการแข่งขัน เกม ${selectedGame})`} description={selectedSnapshot?.confirmedAt ? publishedAtText(selectedSnapshot.confirmedAt) : undefined}>
              <ResultTable pairings={visiblePairings} players={players} storageKey={`${id}:overview:results`} resizableColumns={resizableColumns} />
            </Panel>
          )}

          <nav className="overview-mobile-nav" aria-label="มุมมองข้อมูลการแข่งขัน">
            {(["ranking", "pairing", "result"] as const).map((view) => {
              const unavailable = viewUnavailable[view];
              const active = views.has(view) && !unavailable;
              return (
                <button key={view} type="button" className={active ? "overview-mobile-nav__button overview-mobile-nav__button--on" : "overview-mobile-nav__button"} aria-pressed={active} disabled={unavailable} title={unavailable ? viewUnavailableTitle[view] : undefined} onClick={() => toggleView(view)}>
                  {view === "ranking" ? "RANKING" : view === "pairing" ? "PAIRING" : "RESULT"}
                </button>
              );
            })}
          </nav>
        </>
      ))}

      {/* Back-office extras live below the spectator content: document export, then the danger zone. */}
      {(isAdmin(auth) || canManage) && <DocumentDownloadPanel card={card} />}
      {canClose && (
        <Panel className="panel--danger" title="ปิดการ์ดถาวร" description="การ์ดที่ปิดแล้วจะแก้ไขข้อมูลใด ๆ ไม่ได้อีก — ทำเมื่อการแข่งขันจบสมบูรณ์แล้วเท่านั้น">
          <div className="panel-padding">
            <Button variant="danger" onClick={async () => {
              if (await appDialog.confirm("การ์ดที่ปิดแล้วจะไม่สามารถแก้ไขได้อีก", { title: "ปิดการ์ดถาวรหรือไม่?", confirmLabel: "ปิดการ์ด", danger: true })) await closeCard(id);
            }}><LockKeyhole size={16} />ปิดการ์ดถาวร</Button>
          </div>
        </Panel>
      )}

      {historyPlayer && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setHistoryPlayerId(null)}>
          <section className="history-table-dialog" role="dialog" aria-modal="true" aria-labelledby="player-history-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span>ประวัติการแข่งขัน</span><h2 id="player-history-title">{historyPlayer.id} · {historyPlayer.firstName} {historyPlayer.lastName}</h2></div>
              <button type="button" className="confirm-dialog__close" aria-label="ปิดประวัติ" onClick={() => setHistoryPlayerId(null)}><X size={18} /></button>
            </header>
            <div className="history-table-dialog__summary">{historyPlayer.school} · แสดงประวัติถึงเกม {selectedGame}</div>
            <PlayerHistoryTable card={historyCard} players={players} playerId={historyPlayer.id} />
          </section>
        </div>
      )}
      {finalHistorySlot && <FinalHistoryDialog slot={finalHistorySlot} players={players} onClose={() => setFinalHistorySlot(null)} />}
    </>
  );
}
