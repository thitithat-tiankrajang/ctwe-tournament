"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowRight, ClipboardCheck, FilterX, LockKeyhole, Trophy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { canManageTournament } from "@/domain/tournament/roles";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { Pairing, Player, RuntimeStage, TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { FinalRoundBoard } from "@/ui/components/final-round-board";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { SelectMenu } from "@/ui/components/select-menu";

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

function ViewPanelActions({ onClear }: { onClear: () => void }) {
  return <Button variant="secondary" size="sm" onClick={onClear}><FilterX size={14} />ล้างตัวกรอง</Button>;
}

/** Seat number for a player in a pairing (seat 1 = couple n → seats 2n-1 / 2n). */
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;
const athleteName = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "รอคู่แข่ง";

/** Two-line athlete cell: name (black) over school (dark grey), shared by pairing + result viewers. */
function AthleteCell({ player }: { player?: Player }) {
  const name = athleteName(player);
  return (
    <div className="cell-athlete">
      <span className="cell-athlete__name" title={name}>{name}</span>
      <span className="cell-athlete__school" title={player?.school}>{player?.school ?? "—"}</span>
    </div>
  );
}

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne != null && pairing.scoreTwo != null && Boolean(pairing.resultType);
}

function RankingTable({ players, selectedId, onPlayerClick, onFilterActiveChange }: {
  players: ReturnType<typeof rankingAfterGame>;
  selectedId?: string | null;
  onPlayerClick?: (player: Player) => void;
  onFilterActiveChange?: (active: boolean) => void;
}) {
  const rows = players.map((player, index) => ({ player, rank: index + 1 }));
  const columns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 48, width: 58, align: "center", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัส", min: 50, width: 60, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: ({ player }) => player.id, render: ({ player }) => player.id },
    { key: "name", label: "ชื่อ - นามสกุล", min: 120, width: 250, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 120, width: 250, cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนสะสม", min: 76, width: 90, align: "center", value: ({ player }) => player.winPoints, render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 82, width: 96, align: "center", value: ({ player }) => player.diff, filterable: false, render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
  ];
  return <DataGrid columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:ranking:v3" tableClassName="entry-grid--ranking" unit="คน" emptyText="ไม่พบผู้เล่นตามตัวกรอง" inlineClear={false} onFilterActiveChange={onFilterActiveChange} onRowClick={onPlayerClick ? (row) => onPlayerClick(row.player) : undefined} rowClassName={selectedId ? (row) => row.player.id === selectedId ? "egrid-row--active" : undefined : undefined} />;
}

function PairingGrid({ pairings, players, onFilterActiveChange }: { pairings: Pairing[]; players: Map<string, Player>; onFilterActiveChange?: (active: boolean) => void }) {
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const columns: DataColumn<Pairing>[] = [
    { key: "seat1", label: "#", min: 38, width: 50, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 1), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 1) },
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 150, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerOneId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} /> },
    { key: "vs", label: "", min: 42, width: 56, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    { key: "seat2", label: "#", min: 38, width: 50, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 2), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 2) },
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 150, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} /> },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey="overview:pairing" tableClassName="entry-grid--match" unit="คู่" emptyText="ไม่พบคู่ตามตัวกรอง" inlineClear={false} onFilterActiveChange={onFilterActiveChange} />;
}

function ResultTable({ pairings, players, storageKey, onFilterActiveChange }: { pairings: Pairing[]; players: Map<string, Player>; storageKey: string; onFilterActiveChange?: (active: boolean) => void }) {
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const scoreText = (pairing: Pairing) => pairing.resultType === "PENALTY" ? "ลงดาบ" : isRecorded(pairing) ? `${pairing.scoreOne} - ${pairing.scoreTwo}` : "—";
  const longestScore = pairings.reduce((longest, pairing) => Math.max(longest, scoreText(pairing).length), "คะแนน".length);
  // The overview renders both scores in one cell (e.g. "234 - 242"). Keep enough room for
  // the complete header or the longest rendered score, whichever is wider.
  const scoreColumnWidth = Math.max(64, Math.min(132, longestScore * 8 + 12));
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
    { key: "name1", label: "นักกีฬา", min: 140, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerOneId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} /> },
    { key: "vs", label: "", min: 40, width: 52, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    { key: "seat2", label: "#", min: 36, width: 48, align: "center", cellClassName: "cell-seat", value: (pairing) => seatOf(pairing.tableNumber, 2), filterable: false, render: (pairing) => seatOf(pairing.tableNumber, 2) },
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 140, width: 300, value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} /> },
    { key: "score", label: "คะแนน", min: scoreColumnWidth, width: scoreColumnWidth, fitMin: scoreColumnWidth, align: "center", cellClassName: "cell-score", value: (pairing) => scoreText(pairing), filterable: false, render: (pairing) => scoreText(pairing) },
    { key: "diff", label: "ผลต่าง", min: 56, width: 68, align: "center", cellClassName: (pairing) => `cell-diff cell-diff--${pairing.resultType === "PENALTY" ? "penalty" : "win"}`, value: (pairing) => diffOf(pairing) ?? -1, filterable: false, render: (pairing) => diffText(pairing) },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={`${storageKey}:layout-v3:score-${scoreColumnWidth}`} tableClassName="entry-grid--match" unit="คู่" emptyText="ไม่พบคู่ตามตัวกรอง" inlineClear={false} onFilterActiveChange={onFilterActiveChange} />;
}

function defaultOverviewState(card: TournamentCard | undefined): { key: string; view: OverviewView } | null {
  if (!card) return null;
  const visibleSnapshots = card.snapshots.filter((snapshot) =>
    Boolean(snapshot.confirmedAt)
    || card.runtimeStage !== "PAIRING_PREVIEW"
    || !snapshot.gameNumbers.includes(card.currentGame));
  const latestGame = Math.max(0, ...visibleSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const activeGame = latestGame > 0 ? latestGame : card.currentGame;
  const snapshot = visibleSnapshots.find((item) => item.gameNumbers.includes(activeGame));
  if (!snapshot) return null;
  if (snapshot.confirmedAt) return { key: `ranking:${activeGame}`, view: "ranking" };
  const currentPairings = snapshot.pairings.filter((pairing) => (pairing.gameNumber ?? activeGame) === activeGame);
  const hasFirstResult = currentPairings.some((pairing) => pairing.scoreOne !== null || pairing.scoreTwo !== null);
  return hasFirstResult
    ? { key: `result:${activeGame}`, view: "result" }
    : { key: `pairing:${activeGame}`, view: "pairing" };
}

export default function CardOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const cards = useTournamentStore((state) => state.cards);
  const loading = useTournamentStore((state) => state.loading);
  const closeCard = useTournamentStore((state) => state.closeCard);
  const auth = useTournamentStore((state) => state.auth);
  const card = selectCard(cards, id);
  const [historyGame, setHistoryGame] = useState<number | null>(null);
  const [views, setViews] = useState<Set<OverviewView>>(new Set<OverviewView>());
  const [filterResetKeys, setFilterResetKeys] = useState<Record<OverviewView, number>>({ ranking: 0, pairing: 0, result: 0 });
  const [filteredViews, setFilteredViews] = useState<Record<OverviewView, boolean>>({ ranking: false, pairing: false, result: false });
  const [selectedRankingPlayerId, setSelectedRankingPlayerId] = useState<string | null>(null);
  const [historyPlayerId, setHistoryPlayerId] = useState<string | null>(null);
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const viewRefs = useRef<Record<OverviewView, HTMLDivElement | null>>({ ranking: null, pairing: null, result: null });
  const defaultState = defaultOverviewState(card);

  useEffect(() => {
    if (defaultState) setViews(new Set<OverviewView>([defaultState.view]));
  }, [defaultState?.key]);

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
  const visibleGames = new Set(visibleSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const latestVisibleGame = Math.max(0, ...visibleSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const currentVisibleGame = latestVisibleGame > 0 ? latestVisibleGame : card.currentGame;
  const selectedGame = historyGame && visibleGames.has(historyGame) ? historyGame : currentVisibleGame;
  const selectedSnapshot = visibleSnapshots.find((snapshot) => snapshot.gameNumbers.includes(selectedGame));
  const selectedPairings = selectedSnapshot?.pairings.filter((pairing) => (pairing.gameNumber ?? selectedGame) === selectedGame) ?? [];
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const historicalRanking = selectedGame > 0 ? rankingAfterGame(rankingCard, selectedGame) : [...card.players].sort((a, b) => a.id.localeCompare(b.id));
  const selectedResultsPublished = Boolean(selectedSnapshot?.confirmedAt);
  const selectedHasResults = selectedPairings.some((pairing) => pairing.scoreOne !== null || pairing.scoreTwo !== null);
  const selectedResultsVisible = selectedResultsPublished || selectedHasResults;
  const players = new Map(card.players.map((player) => [player.id, player]));
  const historyPlayer = historyPlayerId ? players.get(historyPlayerId) : undefined;
  const historyCard = { ...rankingCard, snapshots: publishedSnapshots.filter((snapshot) => Math.max(...snapshot.gameNumbers) <= selectedGame) };
  const final = card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED";
  const canClose = card.status === "FINISHED" && canManage;
  const gameOptions = [...visibleGames].sort((a, b) => a - b);
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
  const resetFilters = (view: OverviewView) =>
    setFilterResetKeys((current) => ({ ...current, [view]: current[view] + 1 }));
  const setViewFilterActive = (view: OverviewView, active: boolean) =>
    setFilteredViews((current) => current[view] === active ? current : { ...current, [view]: active });
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
        className="overview-page-header"
        title={card.name}
        subtitle={card.division}
        description={final ? "ประกาศผลการแข่งขันอย่างเป็นทางการ" : undefined}
        actions={(visibleSnapshots.length > 0 || canClose) ? (
          <div className="overview-header-actions">
            {visibleSnapshots.length > 0 && (
              <div className="overview-header-controls">
                <div className="overview-game-menu-wrap">
                  <SelectMenu
                    ariaLabel="เลือกเกม"
                    className="overview-game-menu"
                    value={String(selectedGame)}
                    options={gameOptions.map((game) => ({ value: String(game), label: `เกม ${game}` }))}
                    onChange={(value) => setHistoryGame(Number(value))}
                    onOpenChange={setGameMenuOpen}
                  />
                  <span
                    className={`overview-game-published${gameMenuOpen ? " overview-game-published--hidden" : ""}`}
                    aria-hidden={gameMenuOpen}
                  >
                    {publishedGames.size} จาก {card.games.length} เกมเผยแพร่ผลแล้ว
                  </span>
                </div>
                <div className="segmented overview-view-picker" role="group" aria-label="เลือกมุมมอง">
                  {(["ranking", "pairing", "result"] as const).map((view) => (
                    <button key={view} type="button" className={`segment${views.has(view) ? " segment--on" : ""}`} aria-pressed={views.has(view)} onClick={() => toggleView(view)}>{view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result"}</button>
                  ))}
                </div>
              </div>
            )}
            {canClose && <Button variant="danger" onClick={() => window.confirm("ปิดการ์ดถาวรหรือไม่?") && void closeCard(id)}><LockKeyhole size={16} />ปิดการ์ด</Button>}
          </div>
        ) : undefined}
      />

      {final && (
        <section className="final-trophy"><Trophy size={52} /><div><span>FINAL RESULT</span><h2>ประกาศผลการแข่งขันแล้ว</h2><p>ผลทุกเกมผ่านการ Review และ Publish ครบถ้วน</p></div></section>
      )}

      {card.finalType !== "NONE" && card.finalRound && (
        <div style={{ marginBottom: 4 }}><FinalRoundBoard card={card} readOnly /></div>
      )}

      {canManage && !final && (
        <div className="notice notice--info workflow-notice"><ClipboardCheck size={20} /><p><strong>ขั้นตอนปัจจุบัน: {stageLabels[card.runtimeStage]}</strong><span>เกม {card.currentGame} จาก {card.games.length} · ทำงานต่อในหน้าที่ระบบกำหนด</span></p><Link href={workflowHref(id, card.runtimeStage)}><Button size="sm">ทำงานต่อ <ArrowRight size={15} /></Button></Link></div>
      )}

      {visibleSnapshots.length === 0 ? (
        card.players.length > 0 ? <>
          <Panel className="overview-data-panel" title="Ranking เริ่มต้น" actions={filteredViews.ranking ? <ViewPanelActions onClear={() => resetFilters("ranking")} /> : undefined}>
            <div className="overview-ranking-table">
              <RankingTable key={filterResetKeys.ranking} players={historicalRanking} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} onFilterActiveChange={(active) => setViewFilterActive("ranking", active)} />
            </div>
          </Panel>
          <Panel><EmptyState icon={<Trophy size={26} />} title="ยังไม่มี Pairing ที่เผยแพร่" description="เมื่อเจ้าหน้าที่ยืนยัน Pairing เกมแรก ตารางคู่แข่งขันจะปรากฏที่นี่ทันที" /></Panel>
        </> : <Panel><EmptyState icon={<Trophy size={26} />} title="กำลังรอรายชื่อผู้เล่น" description="รายชื่อและ Ranking เริ่มต้นจะปรากฏหลังเจ้าหน้าที่ Finish การลงทะเบียน" /></Panel>
      ) : (
        <>
          {views.size === 0 && <Panel><EmptyState icon={<ClipboardCheck size={24} />} title="ยังไม่ได้เลือกมุมมอง" description="กดปุ่ม Ranking / Pairing / Result ด้านล่างเพื่อเลือกข้อมูลที่ต้องการดู" /></Panel>}

          {views.has("ranking") && (
            <div ref={(element) => { viewRefs.current.ranking = element; }} className="overview-view-section">
              <Panel className="overview-data-panel" title={selectedResultsPublished ? `Ranking หลังจบเกม ${selectedGame}` : `Ranking ก่อนจบเกม ${selectedGame}`} actions={filteredViews.ranking ? <ViewPanelActions onClear={() => resetFilters("ranking")} /> : undefined}>
                <div className="overview-ranking-table">
                  <RankingTable key={filterResetKeys.ranking} players={historicalRanking} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} onFilterActiveChange={(active) => setViewFilterActive("ranking", active)} />
                </div>
              </Panel>
            </div>
          )}

          {views.has("pairing") && (
            <div ref={(element) => { viewRefs.current.pairing = element; }} className="overview-view-section">
              <Panel className="overview-data-panel" title={`Pairing เกม ${selectedGame}`} actions={filteredViews.pairing ? <ViewPanelActions onClear={() => resetFilters("pairing")} /> : undefined}>
                <PairingGrid key={filterResetKeys.pairing} pairings={selectedPairings} players={players} onFilterActiveChange={(active) => setViewFilterActive("pairing", active)} />
              </Panel>
            </div>
          )}

          {views.has("result") && (
            <div ref={(element) => { viewRefs.current.result = element; }} className="overview-view-section">
              <Panel className="overview-data-panel" title={`ผลการแข่งขันเกม ${selectedGame}`} actions={filteredViews.result ? <ViewPanelActions onClear={() => resetFilters("result")} /> : undefined}>
                {selectedResultsVisible
                  ? <ResultTable key={filterResetKeys.result} pairings={selectedPairings} players={players} storageKey={`${id}:overview:results`} onFilterActiveChange={(active) => setViewFilterActive("result", active)} />
                  : <EmptyState icon={<LockKeyhole size={25} />} title="Pairing เผยแพร่แล้ว · รอผลคู่แรก" description="เมื่อเจ้าหน้าที่บันทึกคะแนน ผลการแข่งขันจะปรากฏที่นี่แบบ Realtime" />}
              </Panel>
            </div>
          )}

          <nav className="overview-mobile-nav" aria-label="มุมมองข้อมูลการแข่งขัน">
            {(["ranking", "pairing", "result"] as const).map((view) => (
              <button key={view} type="button" className={views.has(view) ? "overview-mobile-nav__button overview-mobile-nav__button--on" : "overview-mobile-nav__button"} aria-pressed={views.has(view)} onClick={() => toggleView(view)}>
                {view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result"}
              </button>
            ))}
          </nav>
        </>
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
    </>
  );
}
