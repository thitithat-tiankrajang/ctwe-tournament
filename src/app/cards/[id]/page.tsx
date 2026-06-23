"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowRight, ClipboardCheck, LockKeyhole, Trophy } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { Pairing, Player, RuntimeStage } from "@/domain/tournament/types";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { pairingFilters, rankingFilters } from "@/ui/components/grid-filters";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { ResultViewGrid } from "@/ui/components/result-entry-grid";

type OverviewView = "ranking" | "pairing" | "result";

const stageLabels: Record<RuntimeStage, string> = {
  PLAYER_REGISTRATION: "ลงทะเบียนผู้เล่น",
  TABLE_PAIRING: "รอสร้าง Pairing",
  PAIRING_PREVIEW: "ตรวจและยืนยัน Pairing",
  RESULT_COLLECTION: "กรอกผลการแข่งขัน",
  RESULT_REVIEW: "Review ก่อน Publish",
  FINAL_PUBLISHED: "ประกาศผลแล้ว",
};

function workflowHref(cardId: string, stage: RuntimeStage) {
  if (stage === "PLAYER_REGISTRATION") return `/cards/${cardId}/players`;
  if (stage === "TABLE_PAIRING" || stage === "PAIRING_PREVIEW") return `/cards/${cardId}/tables`;
  if (stage === "RESULT_COLLECTION" || stage === "RESULT_REVIEW") return `/cards/${cardId}/games`;
  return `/cards/${cardId}`;
}

function UpdatedAt({ value }: { value: string | null }) {
  return <span className="panel-updated">อัปเดตล่าสุด <strong>{value ? formatDateTime(value) : "—"}</strong></span>;
}

function RankingTable({ players }: { players: ReturnType<typeof rankingAfterGame> }) {
  const rows = players.map((player, index) => ({ player, rank: index + 1 }));
  const columns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "#", min: 42, width: 56, align: "right", render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัสผู้เล่น", min: 80, width: 120, cellClassName: "cell-id", render: ({ player }) => player.id },
    { key: "name", label: "ชื่อ-นามสกุล", min: 130, width: 210, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 120, width: 200, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนชัยชนะ", min: 90, width: 124, align: "right", render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 90, width: 124, align: "right", render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
    { key: "wdl", label: "ชนะ / เสมอ / แพ้", min: 100, width: 142, align: "center", render: ({ player }) => `${player.wins} / ${player.draws} / ${player.losses}` },
  ];
  return <DataGrid columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:ranking" unit="คน" emptyText="ไม่พบผู้เล่นตามตัวกรอง" filters={rankingFilters()} />;
}

function PairingGrid({ pairings, players }: { pairings: Pairing[]; players: Map<string, Player> }) {
  const fullName = (playerId: string) => { const player = players.get(playerId); return `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim(); };
  const columns: DataColumn<Pairing>[] = [
    { key: "pair", label: "คู่", min: 44, width: 60, align: "right", render: (pairing) => <strong>{pairing.tableNumber}</strong> },
    { key: "id1", label: "รหัสฝ่ายที่ 1", min: 80, width: 118, cellClassName: "cell-id", render: (pairing) => players.get(pairing.playerOneId)?.id },
    { key: "name1", label: "ชื่อ - นามสกุล", min: 120, width: 190, render: (pairing) => <span title={fullName(pairing.playerOneId)}>{fullName(pairing.playerOneId)}</span> },
    { key: "school1", label: "โรงเรียน/สถาบัน", min: 110, width: 180, render: (pairing) => <span title={players.get(pairing.playerOneId)?.school}>{players.get(pairing.playerOneId)?.school}</span> },
    { key: "vs", label: "", min: 60, width: 78, align: "center", cellClassName: "cell-vs", render: () => "พบกับ" },
    { key: "id2", label: "รหัสฝ่ายที่ 2", min: 80, width: 118, cellClassName: "cell-id", render: (pairing) => players.get(pairing.playerTwoId)?.id },
    { key: "name2", label: "ชื่อ - นามสกุล", min: 120, width: 190, render: (pairing) => <span title={fullName(pairing.playerTwoId)}>{fullName(pairing.playerTwoId)}</span> },
    { key: "school2", label: "โรงเรียน/สถาบัน", min: 110, width: 180, render: (pairing) => <span title={players.get(pairing.playerTwoId)?.school}>{players.get(pairing.playerTwoId)?.school}</span> },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey="overview:pairing" unit="คู่" emptyText="ไม่พบคู่ตามตัวกรอง" filters={pairingFilters(players)} />;
}

export default function CardOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const cards = useTournamentStore((state) => state.cards);
  const closeCard = useTournamentStore((state) => state.closeCard);
  const auth = useTournamentStore((state) => state.auth);
  const card = selectCard(cards, id);
  const [historyGame, setHistoryGame] = useState<number | null>(null);
  const [views, setViews] = useState<Set<OverviewView>>(new Set<OverviewView>(["ranking", "pairing", "result"]));
  if (!card) return <CardNotFound />;
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  const visibleSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt) || card.runtimeStage !== "PAIRING_PREVIEW" || !snapshot.gameNumbers.includes(card.currentGame));
  const publishedSnapshots = visibleSnapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const publishedGames = new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const visibleGames = new Set(visibleSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const latestVisibleGame = Math.max(0, ...visibleSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const selectedGame = historyGame && visibleGames.has(historyGame) ? historyGame : latestVisibleGame;
  const selectedSnapshot = visibleSnapshots.find((snapshot) => snapshot.gameNumbers.includes(selectedGame));
  const selectedPairings = selectedSnapshot?.pairings.filter((pairing) => (pairing.gameNumber ?? selectedGame) === selectedGame) ?? [];
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const historicalRanking = selectedGame > 0 ? rankingAfterGame(rankingCard, selectedGame) : [...card.players].sort((a, b) => a.id.localeCompare(b.id));
  const selectedResultsPublished = Boolean(selectedSnapshot?.confirmedAt);
  const players = new Map(card.players.map((player) => [player.id, player]));
  const final = card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED";
  const canClose = card.status === "FINISHED" && isStaff;
  const gameOptions = [...visibleGames].sort((a, b) => a - b);
  const toggleView = (view: OverviewView) => setViews((prev) => { const next = new Set(prev); if (next.has(view)) next.delete(view); else next.add(view); return next; });

  const rankingUpdatedAt = publishedSnapshots
    .filter((snapshot) => Math.max(...snapshot.gameNumbers) <= selectedGame)
    .reduce<string | null>((latest, snapshot) => !latest || snapshot.confirmedAt > latest ? snapshot.confirmedAt : latest, null);
  const pairingUpdatedAt = selectedSnapshot?.confirmedAt ?? null;
  const resultsUpdatedAt = selectedResultsPublished ? selectedSnapshot!.confirmedAt : null;

  return (
    <>
      <PageHeader eyebrow={card.division} title={card.name} description={final ? "ประกาศผลการแข่งขันอย่างเป็นทางการ" : `${publishedGames.size} จาก ${card.games.length} เกมเผยแพร่ผลแล้ว`} actions={canClose ? <Button variant="danger" onClick={() => window.confirm("ปิดการ์ดถาวรหรือไม่?") && void closeCard(id)}><LockKeyhole size={16} />ปิดการ์ด</Button> : undefined} />

      {final && (
        <section className="final-trophy"><Trophy size={52} /><div><span>FINAL RESULT</span><h2>ประกาศผลการแข่งขันแล้ว</h2><p>ผลทุกเกมผ่านการ Review และ Publish ครบถ้วน</p></div></section>
      )}

      {isStaff && !final && (
        <div className="notice notice--info workflow-notice"><ClipboardCheck size={20} /><p><strong>ขั้นตอนปัจจุบัน: {stageLabels[card.runtimeStage]}</strong><span>เกม {card.currentGame} จาก {card.games.length} · ทำงานต่อในหน้าที่ระบบกำหนด</span></p><Link href={workflowHref(id, card.runtimeStage)}><Button size="sm">ทำงานต่อ <ArrowRight size={15} /></Button></Link></div>
      )}

      {visibleSnapshots.length === 0 ? (
        card.players.length > 0 ? <>
          <Panel title="Ranking เริ่มต้น" description="รายชื่อผู้เล่นที่เจ้าหน้าที่ Finish การลงทะเบียนแล้ว · WP และ Diff เริ่มที่ 0">
            <RankingTable players={historicalRanking} />
          </Panel>
          <Panel><EmptyState icon={<Trophy size={26} />} title="ยังไม่มี Pairing ที่เผยแพร่" description="เมื่อเจ้าหน้าที่ยืนยัน Pairing เกมแรก ตารางคู่แข่งขันจะปรากฏที่นี่ทันที" /></Panel>
        </> : <Panel><EmptyState icon={<Trophy size={26} />} title="กำลังรอรายชื่อผู้เล่น" description="รายชื่อและ Ranking เริ่มต้นจะปรากฏหลังเจ้าหน้าที่ Finish การลงทะเบียน" /></Panel>
      ) : (
        <>
          <Panel title="ข้อมูลการแข่งขันตามเกม" description="เลือกเกมจาก dropdown แล้วเลือกมุมมองที่ต้องการดู (Ranking / Pairing / Result เลือกได้หลายอย่าง)">
            <div className="overview-controls">
              <div className="overview-game-select">
                <label htmlFor="overview-game">เลือกเกม</label>
                <select id="overview-game" className="select" value={selectedGame} onChange={(event) => setHistoryGame(Number(event.target.value))}>
                  {gameOptions.map((game) => <option key={game} value={game}>เกม {game}</option>)}
                </select>
              </div>
              <div className="segmented-field">
                <span>มุมมองที่แสดง</span>
                <div className="segmented" role="group" aria-label="เลือกมุมมอง">
                  {(["ranking", "pairing", "result"] as const).map((view) => (
                    <button key={view} type="button" className={`segment${views.has(view) ? " segment--on" : ""}`} aria-pressed={views.has(view)} onClick={() => toggleView(view)}>{view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result"}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="archive-rule-summary"><strong>เกม {selectedGame}</strong><span>{selectedResultsPublished ? `เผยแพร่ผลเมื่อ ${formatDateTime(selectedSnapshot!.confirmedAt)}` : "เผยแพร่ Pairing แล้ว · รอผลการแข่งขัน"}</span></div>
          </Panel>

          {views.size === 0 && <Panel><EmptyState icon={<ClipboardCheck size={24} />} title="ยังไม่ได้เลือกมุมมอง" description="กดปุ่ม Ranking / Pairing / Result ด้านบนเพื่อเลือกข้อมูลที่ต้องการดู" /></Panel>}

          {views.has("ranking") && (
            <Panel title={selectedResultsPublished ? `Ranking หลังจบเกม ${selectedGame}` : `Ranking ก่อนจบเกม ${selectedGame}`} description={selectedResultsPublished ? "อันดับสะสมถึงเกมที่เลือก เรียงตาม Win Point แล้ว Total Difference" : "อันดับล่าสุดจากผลที่เผยแพร่ก่อนหน้านี้ คะแนนเกมที่กำลังแข่งยังไม่ถูกนำมาคำนวณ"} actions={<UpdatedAt value={rankingUpdatedAt} />}>
              <RankingTable players={historicalRanking} />
            </Panel>
          )}

          {views.has("pairing") && (
            <Panel title={`Pairing เกม ${selectedGame}`} description="คู่แข่งขันที่เจ้าหน้าที่ยืนยันและเผยแพร่แล้ว" actions={<UpdatedAt value={pairingUpdatedAt} />}>
              <PairingGrid pairings={selectedPairings} players={players} />
            </Panel>
          )}

          {views.has("result") && (
            <Panel title={`ผลการแข่งขันเกม ${selectedGame}`} description={selectedResultsPublished ? "คะแนนและผลที่ผ่าน Review ก่อน Publish แล้ว" : "ผลจะปรากฏพร้อมกันหลังเจ้าหน้าที่ Review และ Finish เกมนี้"} actions={<UpdatedAt value={resultsUpdatedAt} />}>
              {selectedResultsPublished
                ? <ResultViewGrid pairings={selectedPairings} players={players} storageKey={`${id}:overview:results`} />
                : <EmptyState icon={<LockKeyhole size={25} />} title="Pairing เผยแพร่แล้ว · ผลยังไม่เผยแพร่" description="เจ้าหน้าที่กำลังกรอกหรือตรวจผล คะแนนจะไม่ถูกส่งออกสู่สาธารณะก่อน Finish" />}
            </Panel>
          )}
        </>
      )}
    </>
  );
}
