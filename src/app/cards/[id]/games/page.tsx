"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Eye, Gamepad2, LockKeyhole, Trophy } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { canManageTournament, hasStaffAccess } from "@/domain/tournament/roles";
import { isPairResultBlock, resultBlockGames } from "@/domain/tournament/flow";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { GameFlow } from "@/ui/components/game-flow";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { ResultEntryGrid, ResultViewGrid, type EntrySlot } from "@/ui/components/result-entry-grid";
import { PairingGrid, RankingGrid } from "@/ui/components/standings-grids";

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

/** Non-active view: ranking per game (window-slide); click a player row to see their history. */
function GamesBrowse({ card, players, canEdit, onOverride }: {
  card: TournamentCard;
  players: Map<string, Player>;
  canEdit: boolean;
  onOverride: (matchId: string, scoreOne: number, scoreTwo: number) => Promise<void>;
}) {
  const [rankingGame, setRankingGame] = useState<number | null>(null);
  const [editGame, setEditGame] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const publishedSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const games = [...new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers))].sort((a, b) => a - b);
  const latest = games[games.length - 1] ?? 0;
  const selected = rankingGame && games.includes(rankingGame) ? rankingGame : latest;
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const ranked = selected > 0 ? rankingAfterGame(rankingCard, selected) : [];
  const selectedPlayer = selectedId ? players.get(selectedId) : undefined;

  return (
    <>
      {games.length > 0 ? (
        <Panel title="อันดับประจำแต่ละเกม" description="เลือกเกมเพื่อดูคะแนนชัยชนะและผลต่างสะสม · คลิกผู้เล่นเพื่อดูประวัติการเล่นรายเกม">
          <div className="panel-padding archive-game-flow"><GameFlow card={rankingCard} selectedGame={selected} onSelect={setRankingGame} mode="ranking" /></div>
          <div className="archive-rule-summary"><strong>อันดับหลังจบเกม {selected}</strong><span>เรียงตาม Win Point แล้ว Total Difference</span></div>
          <RankingGrid ranked={ranked} storageKey={`${card.id}:games:ranking`} resetKey={String(selected)} onRowClick={(player) => setSelectedId(player.id)} activeId={selectedId} />
        </Panel>
      ) : (
        <Panel><EmptyState icon={<Gamepad2 size={25} />} title="ยังไม่มีอันดับที่เผยแพร่" description="อันดับและประวัติการเล่นจะปรากฏที่นี่หลังเจ้าหน้าที่ Publish ผลเกมแรก" /></Panel>
      )}

      {canEdit && games.length > 0 && (() => {
        const target = editGame && games.includes(editGame) ? editGame : selected;
        const snap = publishedSnapshots.find((s) => s.gameNumbers.includes(target));
        const editPairings = snap?.pairings.filter((p) => (p.gameNumber ?? target) === target) ?? [];
        const slots: EntrySlot[] = [...editPairings].sort((a, b) => a.tableNumber - b.tableNumber).map((p) => ({ tableNumber: p.tableNumber, pairing: p }));
        const maxDiff = card.games.find((g) => g.number === target)?.maxDiff ?? 350;
        return (
          <Panel
            title="แก้ไขผลเกมที่เผยแพร่แล้ว"
            description="ผู้อำนวยการแก้ผลย้อนหลังได้ทุกเวลา · standing คำนวณใหม่อัตโนมัติ แต่ pairing เดิมไม่ถูกจับใหม่ (ถ้าต้องการจับคู่ใหม่ ใช้ Un-pairing ที่หน้าโต๊ะแข่งขัน)"
            actions={<div className="overview-game-select"><label htmlFor="override-game">เลือกเกม</label><select id="override-game" className="select" value={target} onChange={(event) => setEditGame(Number(event.target.value))}>{games.map((g) => <option key={g} value={g}>เกม {g}</option>)}</select></div>}
          >
            <div className="notice notice--warning" style={{ margin: 18 }}><LockKeyhole size={18} /><p><strong>การแก้ผลที่เผยแพร่แล้วมีผลต่ออันดับทันที</strong><span>ระบบบันทึก audit log ทุกครั้ง · กรอกคะแนนแล้วกด Enter เพื่อบันทึก</span></p></div>
            <ResultEntryGrid gameNumber={target} slots={slots} players={players} maxDiff={maxDiff} storageKey={`${card.id}:override:${target}`} onSubmit={(pairing, scoreOne, scoreTwo) => onOverride(pairing.id, scoreOne, scoreTwo)} />
          </Panel>
        );
      })()}

      {selectedPlayer && (
        <Panel
          title={`ประวัติการเล่น · ${selectedPlayer.id} · ${selectedPlayer.firstName} ${selectedPlayer.lastName}`}
          description={`${selectedPlayer.school} · แต้มชัยชนะและผลต่างสะสมคิดรวมจากเกมแรกถึงเกมนั้น`}
          actions={<Button variant="secondary" size="sm" onClick={() => setSelectedId(null)}>ปิดประวัติ</Button>}
        >
          <PlayerHistoryTable card={card} players={players} playerId={selectedId!} />
        </Panel>
      )}
    </>
  );
}

export default function GamesPage() {
  const { id } = useParams<{ id: string }>(); const router = useRouter();
  const cards = useTournamentStore((state) => state.cards); const auth = useTournamentStore((state) => state.auth); const loading = useTournamentStore((state) => state.loading);
  const submitResult = useTournamentStore((state) => state.submitResult); const reviewResults = useTournamentStore((state) => state.reviewResults);
  const reopenResults = useTournamentStore((state) => state.reopenResults); const publishResults = useTournamentStore((state) => state.publishResults);
  const overrideResult = useTournamentStore((state) => state.overrideResult);
  const card = selectCard(cards, id); const [busy, setBusy] = useState(false);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  const isStaff = hasStaffAccess(auth);
  if (!isStaff) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="บุคคลทั่วไปดูเฉพาะผลที่ publish แล้วจากหน้าภาพรวม" action={<Link href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
  if (!card) return <CardNotFound />;

  const playerMap = new Map(card.players.map((player) => [player.id, player]));
  const activeGames = resultBlockGames(card);
  const pairResultBlock = isPairResultBlock(card);
  const blockLabel = activeGames.length === 1 ? `Game ${activeGames[0]}` : `Game ${activeGames[0]}–${activeGames[activeGames.length - 1]}`;
  const currentSnapshot = card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.includes(card.currentGame));
  const pairings = currentSnapshot?.pairings.filter((pairing) => activeGames.includes(pairing.gameNumber ?? card.currentGame)) ?? [];
  const resultCollection = card.runtimeStage === "RESULT_COLLECTION"; const reviewing = card.runtimeStage === "RESULT_REVIEW";
  const expectedCount = (card.players.length / 2) * activeGames.length;
  const completedCount = pairings.filter(isRecorded).length;
  const allComplete = pairings.length === expectedCount && completedCount === expectedCount;
  const pairingsForGame = (gameNumber: number) => pairings.filter((pairing) => (pairing.gameNumber ?? card.currentGame) === gameNumber);
  const maxDiffForGame = (gameNumber: number) => card.games.find((game) => game.number === gameNumber)?.maxDiff ?? 350;
  const latestActiveGame = activeGames[activeGames.length - 1];
  const latestActivePairings = pairingsForGame(latestActiveGame);

  const saveResult = (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => submitResult(id, pairing.id, scoreOne, scoreTwo, editExisting);
  const beginReview = async () => { setBusy(true); try { await reviewResults(id); } catch (error) { window.alert(error instanceof Error ? error.message : "เปิดหน้า review ไม่สำเร็จ"); } finally { setBusy(false); } };
  const publish = async () => {
    if (!window.confirm(`ยืนยัน Publish ผล ${blockLabel}? ข้อมูลจะขึ้นหน้าภาพรวมและแก้ไขไม่ได้`)) return;
    const finalGame = activeGames[activeGames.length - 1] === card.games.length; setBusy(true);
    try { await publishResults(id); router.push(finalGame ? `/cards/${id}` : `/cards/${id}/tables`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "Publish ผลไม่สำเร็จ"); } finally { setBusy(false); }
  };

  if (!resultCollection && !reviewing) return <><PageHeader eyebrow={`${card.name} · ${card.runtimeStage}`} title="ผลการแข่งขัน" description="ดูอันดับแต่ละเกม และค้นหาผู้เล่นเพื่อดูประวัติการเล่นย้อนหลัง · การกรอกผลจะเปิดเมื่อยืนยัน pairing เกมปัจจุบัน" /><GamesBrowse card={card} players={playerMap} canEdit={canManageTournament(auth)} onOverride={(matchId, scoreOne, scoreTwo) => overrideResult(id, matchId, scoreOne, scoreTwo)} /></>;

  return (
    <>
      <PageHeader eyebrow={`${card.name} · ${blockLabel}`} title={reviewing ? "Review ผลการแข่งขัน" : "กรอกผลการแข่งขัน"} description={reviewing ? "ตรวจคะแนน ผลชนะ/เสมอ และ diff ก่อน Publish" : pairResultBlock ? "กรอก Game ต้นทางก่อน ระบบจะสร้างคู่ผู้ชนะและคู่ผู้แพ้ใน Game ถัดไปให้กรอกต่อในหน้าเดียวกัน" : "พิมพ์คะแนนในตารางแล้วกด Enter เพื่อบันทึกและเลื่อนไปคู่ถัดไปทันที ไม่ต้องกดปุ่มเปิด/บันทึก"} actions={canManageTournament(auth) && (resultCollection ? <Button variant="success" disabled={!allComplete || busy} onClick={beginReview}><Eye size={16} />Review ผล <ArrowRight size={16} /></Button> : <div className="page-actions"><Button variant="secondary" disabled={busy} onClick={() => void reopenResults(id)}><ArrowLeft size={16} />กลับไปแก้ไข</Button><Button variant="success" disabled={busy} onClick={publish}>{activeGames[activeGames.length - 1] === card.games.length ? <Trophy size={16} /> : <Check size={16} />}Finish & Publish</Button></div>)} />
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ต้องบันทึกผลครบทุกคู่ของ {blockLabel}</strong><span>{completedCount} จาก {expectedCount} คู่บันทึกแล้ว · Pairing และผลจะเผยแพร่ตาม milestone ที่ยืนยัน</span></p></div>

      {resultCollection ? <>
        {activeGames.map((gameNumber) => {
          const gamePairings = pairingsForGame(gameNumber);
          const maxDiff = maxDiffForGame(gameNumber);
          const isDestination = pairResultBlock && gameNumber === activeGames[1];
          const slots: EntrySlot[] = isDestination
            ? [...pairingsForGame(activeGames[0])].sort((a, b) => a.tableNumber - b.tableNumber).map((source) => ({ tableNumber: source.tableNumber, pairing: gamePairings.find((dest) => dest.tableNumber === source.tableNumber) }))
            : [...gamePairings].sort((a, b) => a.tableNumber - b.tableNumber).map((pairing) => ({ tableNumber: pairing.tableNumber, pairing }));
          const completed = gamePairings.filter(isRecorded).length;
          if (slots.length === 0) return <Panel key={gameNumber}><EmptyState icon={<Gamepad2 size={25} />} title={`Game ${gameNumber} ยังไม่มีคู่แข่งขัน`} description="ยืนยัน pairing เกมนี้ก่อนจึงจะกรอกผลได้" /></Panel>;
          return <Panel key={gameNumber} title={`กรอกผล Game ${gameNumber}`} description={`โครงสร้างแบบ Excel · กรอกแล้วกด Enter หรือปุ่มเซฟ · Win +2 / Draw +1 / Loss +0 · Max diff ${maxDiff}`} actions={<Badge tone={completed === slots.length ? "success" : "warning"}>{completed}/{slots.length} คู่</Badge>}>
            <ResultEntryGrid gameNumber={gameNumber} slots={slots} players={playerMap} maxDiff={maxDiff} storageKey={`${id}:${gameNumber}`} pendingNote={isDestination ? `เมื่อบันทึกผลแต่ละ row ของ Game ${activeGames[0]} ระบบจะเติมผู้ชนะไว้คู่บน และผู้แพ้ไว้คู่ล่างทันที; row ปลายทางจะกรอกคะแนนได้เมื่อมีคู่แข่งครบสองฝั่ง` : undefined} onSubmit={saveResult} />
          </Panel>;
        })}
      </> : (
        <>{activeGames.map((gameNumber) => {
          const gamePairings = pairingsForGame(gameNumber); const maxDiff = maxDiffForGame(gameNumber);
          return <Panel key={gameNumber} title={`Review Game ${gameNumber}`} description={`${gamePairings.length} คู่ · Maximum Difference ${maxDiff}`}>
            <ResultViewGrid pairings={gamePairings} players={playerMap} storageKey={`${id}:review:${gameNumber}`} />
          </Panel>;
        })}</>
      )}
      {latestActivePairings.length > 0 && (
        <Panel title={`Pairing เกม ${latestActiveGame}`} description="คู่แข่งขันของเกมที่กำลังกรอกผล">
          <PairingGrid pairings={latestActivePairings} players={playerMap} storageKey={`${id}:games:current-pairing`} />
        </Panel>
      )}
    </>
  );
}
