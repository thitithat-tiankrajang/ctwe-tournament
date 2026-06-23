"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowRight, ClipboardCheck, LockKeyhole, Trophy } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { RuntimeStage } from "@/domain/tournament/types";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { GameFlow } from "@/ui/components/game-flow";
import { EmptyState, PageHeader, Panel, Stat } from "@/ui/components/page";

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

export default function CardOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const cards = useTournamentStore((state) => state.cards);
  const closeCard = useTournamentStore((state) => state.closeCard);
  const auth = useTournamentStore((state) => state.auth);
  const card = selectCard(cards, id);
  const [historyGame, setHistoryGame] = useState<number | null>(null);
  if (!card) return <CardNotFound />;
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  const publishedSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const publishedCard = { ...card, snapshots: publishedSnapshots };
  const publishedGames = new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  publishedCard.games = card.games.map((game) => publishedGames.has(game.number) ? { ...game, status: "COMPLETED" as const } : { ...game, status: "PENDING" as const });
  const latestPublishedGame = Math.max(0, ...publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const selectedGame = historyGame && publishedGames.has(historyGame) ? historyGame : latestPublishedGame;
  const selectedSnapshot = publishedSnapshots.find((snapshot) => snapshot.gameNumbers.includes(selectedGame));
  const selectedPairings = selectedSnapshot?.pairings.filter((pairing) => (pairing.gameNumber ?? selectedGame) === selectedGame) ?? [];
  const historicalRanking = selectedGame > 0 ? rankingAfterGame(publishedCard, selectedGame) : [];
  const players = new Map(card.players.map((player) => [player.id, player]));
  const latestUpdate = card.audit.reduce((latest, entry) => entry.timestamp > latest ? entry.timestamp : latest, card.createdAt);
  const final = card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED";
  const canClose = card.status === "FINISHED" && isStaff;

  return (
    <>
      <PageHeader eyebrow={card.division} title={card.name} description={final ? "ประกาศผลการแข่งขันอย่างเป็นทางการ" : `${publishedSnapshots.length} จาก ${card.games.length} เกมเผยแพร่แล้ว`} actions={canClose ? <Button variant="danger" onClick={() => window.confirm("ปิดการ์ดถาวรหรือไม่?") && void closeCard(id)}><LockKeyhole size={16} />ปิดการ์ด</Button> : undefined} />

      {final && (
        <section className="final-trophy"><Trophy size={52} /><div><span>FINAL RESULT</span><h2>ประกาศผลการแข่งขันแล้ว</h2><p>ผลทุกเกมผ่านการ Review และ Publish ครบถ้วน</p></div></section>
      )}

      {isStaff && !final && (
        <div className="notice notice--info workflow-notice"><ClipboardCheck size={20} /><p><strong>ขั้นตอนปัจจุบัน: {stageLabels[card.runtimeStage]}</strong><span>เกม {card.currentGame} จาก {card.games.length} · ทำงานต่อในหน้าที่ระบบกำหนด</span></p><Link href={workflowHref(id, card.runtimeStage)}><Button size="sm">ทำงานต่อ <ArrowRight size={15} /></Button></Link></div>
      )}

      <div className="stat-grid stat-grid--three">
        <Stat label="ผู้เล่นทั้งหมด" value={card.players.length.toLocaleString("th-TH")} note="คน" />
        <Stat label="ผลที่ Publish" value={`${publishedSnapshots.length}/${card.games.length}`} tone="green" note="เกม" />
        <Stat label="อัปเดตล่าสุด" value={<span className="stat__date">{formatDateTime(latestUpdate)}</span>} tone="blue" note={isStaff ? "จาก audit ล่าสุด" : "ข้อมูลสาธารณะ"} />
      </div>

      {publishedSnapshots.length === 0 ? (
        <Panel><EmptyState icon={<Trophy size={26} />} title="ยังไม่มีผลที่เผยแพร่" description="เมื่อเจ้าหน้าที่ Review และ Finish ผลเกมแรก ข้อมูล Ranking, Pairing และผลการแข่งขันจะปรากฏที่นี่" /></Panel>
      ) : (
        <>
          <Panel title="ประวัติการแข่งขันตามเกม" description="เลือกเกมหนึ่งครั้งเพื่อดู Ranking, Pairing และผลการแข่งขันของเกมนั้นในหน้าเดียว">
            <div className="panel-padding archive-game-flow"><GameFlow card={publishedCard} selectedGame={selectedGame} onSelect={setHistoryGame} mode="overview" /></div>
            <div className="archive-rule-summary"><strong>เกม {selectedGame}</strong><span>Publish เมื่อ {selectedSnapshot?.confirmedAt ? formatDateTime(selectedSnapshot.confirmedAt) : "—"}</span></div>
          </Panel>

          <Panel title={`1. Ranking หลังจบเกม ${selectedGame}`} description="อันดับสะสมถึงเกมที่เลือก เรียงตาม Win Point แล้ว Total Difference">
            <div className="dense-table-wrap archive-table-wrap"><table className="data-table"><thead><tr><th className="numeric">อันดับ</th><th>ผู้เล่น</th><th>โรงเรียน/สถาบัน</th><th className="numeric">WP</th><th className="numeric">ชนะ</th><th className="numeric">เสมอ</th><th className="numeric">แพ้</th><th className="numeric">Diff</th></tr></thead><tbody>{historicalRanking.map((player, index) => <tr key={player.id}><td className="numeric"><strong>{index + 1}</strong></td><td><strong>{player.firstName} {player.lastName}</strong><small className="table-subline">{player.id}</small></td><td>{player.school}</td><td className="numeric"><strong>{player.winPoints}</strong></td><td className="numeric">{player.wins}</td><td className="numeric">{player.draws}</td><td className="numeric">{player.losses}</td><td className="numeric">{player.diff > 0 ? "+" : ""}{player.diff}</td></tr>)}</tbody></table></div>
          </Panel>

          <Panel title={`2. Pairing เกม ${selectedGame}`} description="คู่แข่งขันที่เจ้าหน้าที่ยืนยันและเผยแพร่แล้ว">
            <div className="dense-table-wrap archive-table-wrap"><table className="data-table archive-pairing-table"><thead><tr><th className="numeric">คู่</th><th>ผู้เล่น 1</th><th>ผู้เล่น 2</th><th>สถานะ</th></tr></thead><tbody>{selectedPairings.map((pairing) => { const one = players.get(pairing.playerOneId); const two = players.get(pairing.playerTwoId); return <tr key={pairing.id}><td className="numeric">{pairing.tableNumber}</td><td><strong>{one?.firstName} {one?.lastName}</strong><small className="table-subline">{one?.id} · {one?.school}</small></td><td><strong>{two?.firstName} {two?.lastName}</strong><small className="table-subline">{two?.id} · {two?.school}</small></td><td><Badge tone="success">ยืนยันแล้ว</Badge></td></tr>; })}</tbody></table></div>
          </Panel>

          <Panel title={`3. ผลการแข่งขันเกม ${selectedGame}`} description="คะแนนและผลที่ผ่าน Review ก่อน Publish แล้ว">
            <div className="dense-table-wrap archive-table-wrap"><table className="data-table review-results"><thead><tr><th className="numeric">คู่</th><th>ผู้เล่น 1</th><th className="numeric">คะแนน</th><th>ผู้เล่น 2</th><th className="numeric">คะแนน</th><th>ผล</th><th className="numeric">Diff</th></tr></thead><tbody>{selectedPairings.map((pairing) => { const one = players.get(pairing.playerOneId); const two = players.get(pairing.playerTwoId); const winner = players.get(pairing.winnerId ?? ""); return <tr key={pairing.id}><td className="numeric">{pairing.tableNumber}</td><td><strong>{one?.firstName} {one?.lastName}</strong><small className="table-subline">{one?.id} · {one?.school}</small></td><td className="numeric score-review">{pairing.scoreOne}</td><td><strong>{two?.firstName} {two?.lastName}</strong><small className="table-subline">{two?.id} · {two?.school}</small></td><td className="numeric score-review">{pairing.scoreTwo}</td><td>{pairing.resultType === "DRAW" ? <Badge tone="warning">เสมอ</Badge> : <Badge tone="success">{winner?.id} ชนะ</Badge>}</td><td className="numeric">{pairing.resultType === "DRAW" ? "0" : `±${pairing.calculatedDiff}`}</td></tr>; })}</tbody></table></div>
          </Panel>
        </>
      )}
    </>
  );
}
