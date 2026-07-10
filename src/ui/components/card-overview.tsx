"use client";

import Link from "next/link";
import { ArrowRight, ClipboardCheck, LockKeyhole, Trophy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { canManageTournament, hasStaffAccess } from "@/domain/tournament/roles";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { FinalSlot, Pairing, PairingSnapshot, Player, RuntimeStage, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { FinalRoundBoard } from "@/ui/components/final-round-board";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { SelectMenu } from "@/ui/components/select-menu";
import { OverviewRecordFilter, type OverviewRecordFilterValue } from "@/ui/components/overview-record-filter";

type OverviewView = "ranking" | "pairing" | "result";

const stageLabels: Record<RuntimeStage, string> = {
  PLAYER_REGISTRATION: "ลงทะเบียนผู้เล่น",
  TABLE_PAIRING: "รอสร้าง Pairing",
  PAIRING_PREVIEW: "ตรวจและยืนยัน Pairing",
  RESULT_COLLECTION: "กรอกผลการแข่งขัน",
  RESULT_REVIEW: "Review ก่อน Publish",
  FINAL_SEEDING: "ตรวจผู้เข้าชิงรอบชิง",
  FINAL_COLLECTION: "กรอกผลรอบชิงชนะเลิศ",
  FINAL_PUBLISHED: "ประกาศผลแล้ว",
};

function workflowHref(cardId: string, stage: RuntimeStage) {
  if (stage === "PLAYER_REGISTRATION") return `/cards/${cardId}/players`;
  if (stage === "TABLE_PAIRING" || stage === "PAIRING_PREVIEW") return `/cards/${cardId}/tables`;
  if (stage === "RESULT_COLLECTION" || stage === "RESULT_REVIEW" || stage === "FINAL_SEEDING" || stage === "FINAL_COLLECTION") return `/cards/${cardId}/games`;
  return `/cards/${cardId}`;
}

/** Seat number for a player in a pairing (seat 1 = couple n → seats 2n-1 / 2n). */
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;
const athleteName = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "รอคู่แข่ง";

/** Two-line athlete cell: name (black) over school (dark grey), shared by pairing + result viewers. */
function AthleteCell({ player, gibsonized = false }: { player?: Player; gibsonized?: boolean }) {
  const name = athleteName(player);
  return (
    <div className="cell-athlete">
      <span className="cell-athlete__name" title={name}><span>{name}</span>{gibsonized && <span className="gibson-mark">GIB</span>}</span>
      <span className="cell-athlete__school" title={player?.school}>{player?.school ?? "—"}</span>
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
  return <DataGrid columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:ranking:v3" tableClassName="entry-grid--ranking" unit="คน" emptyText="ไม่พบผู้เล่นตามตัวกรอง" resizableColumns={resizableColumns} onRowClick={onPlayerClick ? (row) => onPlayerClick(row.player) : undefined} rowClassName={selectedId ? (row) => row.player.id === selectedId ? "egrid-row--active" : undefined : undefined} />;
}

function PairingGrid({ pairings, players, resizableColumns }: { pairings: Pairing[]; players: Map<string, Player>; resizableColumns: boolean }) {
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const columns: DataColumn<Pairing>[] = [
    { key: "seat1", label: "#", min: 38, width: 50, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 1), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 1) },
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 150, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerOneId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} gibsonized={pairing.playerOneGibsonized} /> },
    { key: "vs", label: "", min: 42, width: 56, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    { key: "seat2", label: "#", min: 38, width: 50, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 2), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 2) },
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 150, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} gibsonized={pairing.playerTwoGibsonized} /> },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey="overview:pairing" tableClassName="entry-grid--match" unit="คู่" emptyText="ไม่พบคู่ตามตัวกรอง" resizableColumns={resizableColumns} rowClassName={(pairing) => pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "egrid-row--gibson" : undefined} />;
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
    { key: "seat1", label: "#", min: 36, width: 48, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 1), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 1) },
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 140, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerOneId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} gibsonized={pairing.playerOneGibsonized} /> },
    { key: "vs", label: "", min: 40, width: 52, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    { key: "seat2", label: "#", min: 36, width: 48, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 2), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 2) },
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 140, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} gibsonized={pairing.playerTwoGibsonized} /> },
    { key: "score", label: "คะแนน", min: 36, width: 68, fitContent: true, align: "center", cellClassName: "cell-score", value: (pairing) => scoreText(pairing), filterable: false, render: (pairing) => scoreText(pairing) },
    { key: "diff", label: "ผลต่าง", min: 56, width: 68, align: "center", cellClassName: (pairing) => `cell-diff cell-diff--${pairing.resultType === "PENALTY" ? "penalty" : "win"}`, value: (pairing) => diffOf(pairing) ?? -1, filterable: false, render: (pairing) => diffText(pairing) },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={`${storageKey}:layout-v4:score-content-${longestScore}`} tableClassName="entry-grid--match" unit="คู่" emptyText="ไม่พบคู่ตามตัวกรอง" resizableColumns={resizableColumns} rowClassName={(pairing) => pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "egrid-row--gibson" : undefined} />;
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
        <table className="data-table final-history-table">
          <thead><tr><th>เกม</th><th className="numeric">คะแนน</th><th>ผู้ชนะเกม</th><th className="numeric">diff</th></tr></thead>
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
function overviewViewState(card: TournamentCard | undefined): { forcedKey: string; forcedView: OverviewView; entryView: OverviewView } | null {
  if (!card) return null;
  const visibleSnapshots = card.snapshots.filter((snapshot) =>
    Boolean(snapshot.confirmedAt)
    || card.runtimeStage !== "PAIRING_PREVIEW"
    || !snapshot.gameNumbers.includes(card.currentGame));
  const latestGame = Math.max(0, ...visibleSnapshots.flatMap(overviewGames));
  const activeGame = latestGame > 0 ? latestGame : card.currentGame;
  const snapshot = visibleSnapshots.find((item) => overviewGames(item).includes(activeGame));
  if (!snapshot) return null;
  if (snapshot.confirmedAt) return { forcedKey: `ranking:${activeGame}`, forcedView: "ranking", entryView: "ranking" };
  const currentPairings = overviewPairings(snapshot).filter((pairing) => (pairing.gameNumber ?? activeGame) === activeGame);
  // Loose != : an unscored pairing arrives with the score fields OMITTED (undefined), not null.
  const hasFirstResult = currentPairings.some((pairing) => pairing.scoreOne != null || pairing.scoreTwo != null);
  return { forcedKey: `pairing:${activeGame}`, forcedView: "pairing", entryView: hasFirstResult ? "result" : "pairing" };
}

/** Read-only card overview (ranking / pairing / results) shared by /cards/[id] and the /tour viewer. */
export function CardOverview({ cardId: id }: { cardId: string }) {
  const cards = useTournamentStore((state) => state.cards);
  const loading = useTournamentStore((state) => state.loading);
  const closeCard = useTournamentStore((state) => state.closeCard);
  const auth = useTournamentStore((state) => state.auth);
  const resizableColumns = hasStaffAccess(auth);
  const card = selectCard(cards, id);
  const [historyGame, setHistoryGame] = useState<number | "final" | null>(null);
  const [views, setViews] = useState<Set<OverviewView>>(new Set<OverviewView>());
  const [selectedRankingPlayerId, setSelectedRankingPlayerId] = useState<string | null>(null);
  const [historyPlayerId, setHistoryPlayerId] = useState<string | null>(null);
  const [finalHistorySlot, setFinalHistorySlot] = useState<FinalSlot | null>(null);
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [recordFilter, setRecordFilter] = useState<OverviewRecordFilterValue>({ mode: "player", playerIds: [], schools: [] });
  const viewRefs = useRef<Record<OverviewView, HTMLDivElement | null>>({ ranking: null, pairing: null, result: null });
  const viewState = overviewViewState(card);
  const enteredCardRef = useRef<string | null>(null);
  const appliedForcedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setRecordFilter({ mode: "player", playerIds: [], schools: [] });
  }, [id]);

  // Entering a card applies the entry default (Result once a first score exists); after that, only
  // the big publishes steer the screen: pairing publish -> Pairing, ranking publish -> Ranking.
  // A result being recorded mid-game deliberately never forces a view change. Steering happens only
  // when forcedKey actually advances — a re-run with the same key (StrictMode double-invoke, an
  // unrelated re-render) must not overwrite what the entry default or the visitor chose.
  useEffect(() => {
    if (!viewState) return;
    if (enteredCardRef.current !== id) {
      enteredCardRef.current = id;
      appliedForcedKeyRef.current = viewState.forcedKey;
      setViews(new Set<OverviewView>([viewState.entryView]));
      return;
    }
    if (appliedForcedKeyRef.current === viewState.forcedKey) return;
    appliedForcedKeyRef.current = viewState.forcedKey;
    setViews(new Set<OverviewView>([viewState.forcedView]));
  }, [id, viewState?.forcedKey]);

  useEffect(() => {
    if (!selectedRankingPlayerId) return;
    const clearSelectionOutsideTable = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".overview-ranking-table")) return;
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
  const selectedGame = typeof historyGame === "number" && visibleGames.has(historyGame) ? historyGame : currentVisibleGame;
  const selectedSnapshot = visibleSnapshots.find((snapshot) => overviewGames(snapshot).includes(selectedGame));
  const selectedPairings = selectedSnapshot ? overviewPairings(selectedSnapshot).filter((pairing) => (pairing.gameNumber ?? selectedGame) === selectedGame) : [];
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const historicalRanking = selectedGame > 0 ? rankingAfterGame(rankingCard, selectedGame) : [...card.players].sort((a, b) => a.id.localeCompare(b.id));
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
  const historyPlayer = historyPlayerId ? players.get(historyPlayerId) : undefined;
  const historyCard = { ...rankingCard, snapshots: publishedSnapshots.filter((snapshot) => Math.max(...snapshot.gameNumbers) <= selectedGame) };
  const final = card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED";
  const canClose = card.status === "FINISHED" && canManage;
  const gameOptions = [...visibleGames].sort((a, b) => a - b)
    .map((game) => ({ value: String(game), label: `เกม ${game}` }))
    .concat(hasFinalRound ? [{ value: "final", label: "รอบชิง" }] : []);
  const toggleView = (view: OverviewView) => {
    const opening = !views.has(view);
    setViews((prev) => {
      const next = new Set(prev);
      if (next.has(view)) next.delete(view); else next.add(view);
      return next;
    });
    if (opening && window.matchMedia("(max-width: 768px)").matches) {
      window.setTimeout(() => viewRefs.current[view]?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
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
        title={<>{card.name}{card.division && <span className="page-title-inline-subtitle"> {card.division}</span>}</>}
        actions={(visibleSnapshots.length > 0 || canClose || final) ? (
          <div className="overview-header-actions">
            {visibleSnapshots.length > 0 && (
              <div className="overview-header-controls">
                <div className="overview-game-filter-row">
                  {!selectedFinal && <OverviewRecordFilter players={card.players} value={recordFilter} onChange={setRecordFilter} />}
                  <div className="overview-game-menu-wrap">
                    <SelectMenu
                      ariaLabel="เลือกเกม"
                      className="overview-game-menu"
                      value={selectedFinal ? "final" : String(selectedGame)}
                      options={gameOptions}
                      onChange={(value) => setHistoryGame(value === "final" ? "final" : Number(value))}
                      onOpenChange={setGameMenuOpen}
                    />
                    <span
                      className={`overview-game-published${gameMenuOpen ? " overview-game-published--hidden" : ""}`}
                      aria-hidden={gameMenuOpen}
                    >
                      {publishedGames.size} จาก {card.games.length} เกมเผยแพร่ผลแล้ว
                    </span>
                  </div>
                </div>
                {!selectedFinal && <div className="segmented overview-view-picker" role="group" aria-label="เลือกมุมมอง">
                  {(["ranking", "pairing", "result"] as const).map((view) => {
                    // Result opens only once the game has its first recorded score (or is published).
                    const unavailable = view === "result" && !selectedResultsVisible;
                    const active = views.has(view) && !unavailable;
                    return (
                      <button key={view} type="button" className={`segment${active ? " segment--on" : ""}`} aria-pressed={active} disabled={unavailable} title={unavailable ? "ผลจะเปิดให้ดูเมื่อมีการบันทึกคะแนนคู่แรกของเกมนี้" : undefined} onClick={() => toggleView(view)}>{view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result"}</button>
                    );
                  })}
                </div>}
              </div>
            )}
            {final && <Badge tone="warning">complete</Badge>}
            {canClose && <Button variant="danger" onClick={async () => {
              if (await appDialog.confirm("การ์ดที่ปิดแล้วจะไม่สามารถแก้ไขได้อีก", { title: "ปิดการ์ดถาวรหรือไม่?", confirmLabel: "ปิดการ์ด", danger: true })) await closeCard(id);
            }}><LockKeyhole size={16} />ปิดการ์ด</Button>}
          </div>
        ) : undefined}
      />

      {selectedFinal && card.finalRound && <FinalRoundBoard card={card} readOnly onSlotHistory={setFinalHistorySlot} />}

      {canManage && !final && (
        <div className="notice notice--info workflow-notice"><ClipboardCheck size={20} /><p><strong>ขั้นตอนปัจจุบัน: {stageLabels[card.runtimeStage]}</strong><span>เกม {card.currentGame} จาก {card.games.length} · ทำงานต่อในหน้าที่ระบบกำหนด</span></p><Link prefetch={false} href={workflowHref(id, card.runtimeStage)}><Button size="sm">ทำงานต่อ <ArrowRight size={15} /></Button></Link></div>
      )}

      {!selectedFinal && (visibleSnapshots.length === 0 ? (
        card.players.length > 0 ? <>
          <Panel className="overview-data-panel" title="Ranking เริ่มต้น">
            <div className="overview-ranking-table">
              <RankingTable players={visibleRanking} rankingPositions={rankingPositions} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} />
            </div>
          </Panel>
          <Panel><EmptyState icon={<Trophy size={26} />} title="ยังไม่มี Pairing ที่เผยแพร่" description="เมื่อเจ้าหน้าที่ยืนยัน Pairing เกมแรก ตารางคู่แข่งขันจะปรากฏที่นี่ทันที" /></Panel>
        </> : <Panel><EmptyState icon={<Trophy size={26} />} title="กำลังรอรายชื่อผู้เล่น" description="รายชื่อและ Ranking เริ่มต้นจะปรากฏหลังเจ้าหน้าที่ Finish การลงทะเบียน" /></Panel>
      ) : (
        <>
          {views.size === 0 && <Panel><EmptyState icon={<ClipboardCheck size={24} />} title="ยังไม่ได้เลือกมุมมอง" description="กดปุ่ม Ranking / Pairing / Result ด้านล่างเพื่อเลือกข้อมูลที่ต้องการดู" /></Panel>}

          {views.has("ranking") && (
            <div ref={(element) => { viewRefs.current.ranking = element; }} className="overview-view-section">
              <Panel className="overview-data-panel" title={selectedResultsPublished ? `Ranking หลังจบเกม ${selectedGame}` : `Ranking ก่อนจบเกม ${selectedGame}`}>
                <div className="overview-ranking-table">
                  <RankingTable players={visibleRanking} rankingPositions={rankingPositions} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} />
                </div>
              </Panel>
            </div>
          )}

          {views.has("pairing") && (
            <div ref={(element) => { viewRefs.current.pairing = element; }} className="overview-view-section">
              <Panel className="overview-data-panel" title={`Pairing เกม ${selectedGame}`}>
                <PairingGrid pairings={visiblePairings} players={players} resizableColumns={resizableColumns} />
              </Panel>
            </div>
          )}

          {views.has("result") && selectedResultsVisible && (
            <div ref={(element) => { viewRefs.current.result = element; }} className="overview-view-section">
              <Panel className="overview-data-panel" title={`ผลการแข่งขันเกม ${selectedGame}`}>
                <ResultTable pairings={visiblePairings} players={players} storageKey={`${id}:overview:results`} resizableColumns={resizableColumns} />
              </Panel>
            </div>
          )}

          <nav className="overview-mobile-nav" aria-label="มุมมองข้อมูลการแข่งขัน">
            {(["ranking", "pairing", "result"] as const).map((view) => {
              const unavailable = view === "result" && !selectedResultsVisible;
              const active = views.has(view) && !unavailable;
              return (
                <button key={view} type="button" className={active ? "overview-mobile-nav__button overview-mobile-nav__button--on" : "overview-mobile-nav__button"} aria-pressed={active} disabled={unavailable} onClick={() => toggleView(view)}>
                  {view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result"}
                </button>
              );
            })}
          </nav>
        </>
      ))}

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
