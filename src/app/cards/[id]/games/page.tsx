"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Eye, Gamepad2, Gavel, LockKeyhole, Megaphone, Trophy } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { canManageTournament, isOperator } from "@/domain/tournament/roles";
import { allResultBlocks, isPairResultBlock, resultBlockGames } from "@/domain/tournament/flow";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { PromptDialog } from "@/ui/components/prompt-dialog";
import { GameFlow } from "@/ui/components/game-flow";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { ResultEntryGrid, ResultViewGrid, type EntrySlot } from "@/ui/components/result-entry-grid";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { PairingGrid, RankingGrid } from "@/ui/components/standings-grids";
import { OverrideEditor } from "@/ui/components/override-editor";
import { FinalRoundBoard } from "@/ui/components/final-round-board";
import { SelectMenu } from "@/ui/components/select-menu";
import { stageLabels } from "@/ui/components/stage-info";

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

/** Non-active view: ranking per game (window-slide); click a player row to see their history. */
function GamesBrowse({ card, players, canEdit, onOverride, onRevokePenalty }: {
  card: TournamentCard;
  players: Map<string, Player>;
  canEdit: boolean;
  onOverride: (matchId: string, scoreOne: number, scoreTwo: number) => Promise<void>;
  onRevokePenalty: (pairing: Pairing) => void;
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
        <Panel><EmptyState icon={<Gamepad2 size={25} />} title="ยังไม่มีอันดับที่เผยแพร่" description="อันดับและประวัติการเล่นจะปรากฏที่นี่หลังผู้อำนวยการ Publish ผลเกมแรก" /></Panel>
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
            <ResultEntryGrid gameNumber={target} slots={slots} players={players} maxDiff={maxDiff} storageKey={`${card.id}:override:${target}`} onSubmit={(pairing, scoreOne, scoreTwo) => onOverride(pairing.id, scoreOne, scoreTwo)} onRevokePenalty={onRevokePenalty} />
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

/** Final / championship round: seeding review (director starts) then the entry + summary board. */
function FinalRoundView({ card, canManage, onStart, onSubmitGame, onSetWinner, onPublish }: {
  card: TournamentCard;
  canManage: boolean;
  onStart: () => Promise<void>;
  onSubmitGame: (slot: number, gameIndex: number, scoreOne: number, scoreTwo: number, password?: string) => Promise<void>;
  onSetWinner: (slot: number, winnerId: string, winnerWins: number, winnerLosses: number, totalDiff: number, password?: string) => Promise<void>;
  onPublish: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const seeding = card.runtimeStage === "FINAL_SEEDING";
  const needed = card.finalType === "CHAMPION_AND_THIRD" ? 4 : 2;
  const seeds = [...card.players].sort((a, b) => b.winPoints - a.winPoints || b.diff - a.diff).slice(0, needed);
  const start = async () => {
    if (!await appDialog.confirm("ผู้เข้าชิงจะถูกล็อกตามอันดับนี้ และจะแก้ไขผล/ยกเลิกการจับคู่ของเกมปกติไม่ได้อีก", {
      title: "เริ่มรอบชิง?",
      confirmLabel: "เริ่มรอบชิง",
      danger: true,
    })) return;
    setBusy(true);
    try { await onStart(); } catch (error) { await appDialog.alert(error instanceof Error ? error.message : "เริ่มรอบชิงไม่สำเร็จ", "เริ่มรอบชิงไม่สำเร็จ", true); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader eyebrow={`${card.name} · รอบชิงชนะเลิศ`} title="รอบชิงชนะเลิศ"
        description={seeding ? "ตรวจรายชื่อผู้เข้าชิงตามอันดับท้ายเกมสุดท้าย แล้วกดเริ่มรอบชิง" : "กรอกผลรายเกม (ไม่มี max diff) แล้วสรุปผู้ชนะของแต่ละคู่เอง"} />
      {seeding ? (
        <Panel title="ผู้เข้าชิง (ตรวจก่อนเริ่ม)" description={card.finalType === "CHAMPION_AND_THIRD" ? "ชิงที่ 1 (อันดับ 1,2) และชิงที่ 3 (อันดับ 3,4)" : "ชิงที่ 1 (อันดับ 1,2)"}>
          <div className="panel-padding">
            {seeds.length < needed ? (
              <p className="form-error">ผู้เล่นไม่พอสำหรับรอบชิง (ต้องการ {needed} คน มี {seeds.length} คน)</p>
            ) : (
              <ol className="final-seed-list">
                {seeds.map((player, index) => (
                  <li key={player.id}>
                    <Badge tone={index === 0 ? "success" : "info"}>อันดับ {index + 1}</Badge>
                    <strong>{player.firstName} {player.lastName}</strong><small>{player.school}</small>
                    {index % 2 === 1 && <span className="final-seed-vs">ชิงอันดับ {index === 1 ? "1-2" : "3-4"}</span>}
                  </li>
                ))}
              </ol>
            )}
            <div className="notice notice--warning" style={{ marginTop: 12 }}><LockKeyhole size={18} /><p><strong>เริ่มรอบชิงแล้วล็อกถาวร</strong><span>หลังเริ่ม จะแก้ไขผลเกมปกติหรือยกเลิกการจับคู่ไม่ได้อีก</span></p></div>
            {canManage && <div className="form-actions" style={{ paddingLeft: 0 }}><Button disabled={busy || seeds.length < needed} onClick={() => void start()}><Trophy size={16} />เริ่มรอบชิง (ล็อก seed)</Button></div>}
          </div>
        </Panel>
      ) : (
        <FinalRoundBoard
          card={card}
          canManage={canManage}
          onSubmitGame={onSubmitGame}
          onSetWinner={onSetWinner}
          onPublish={onPublish}
          onUnlockPublishedEdit={canManage ? async () => {
            const password = await appDialog.prompt("หลังประกาศผลรอบชิงแล้ว เฉพาะผู้อำนวยการเท่านั้นที่แก้ไขได้ กรุณายืนยันรหัสผ่าน", {
              title: "แก้ไขรอบชิงหลังประกาศผล",
              label: "รหัสผ่านผู้อำนวยการ",
              type: "password",
              confirmLabel: "ปลดล็อกแก้ไข",
            });
            if (!password) return null;
            if (!await useTournamentStore.getState().verifyPassword(password)) {
              await appDialog.alert("รหัสผ่านไม่ถูกต้อง", "ยืนยันตัวตนไม่สำเร็จ", true);
              return null;
            }
            return password;
          } : undefined}
        />
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
  const applyPenalty = useTournamentStore((state) => state.applyPenalty);
  const revokePenalty = useTournamentStore((state) => state.revokePenalty);
  const swapPlayers = useTournamentStore((state) => state.swapPlayers);
  const unpairCurrentPairing = useTournamentStore((state) => state.unpairCurrentPairing);
  const publishNextPairing = useTournamentStore((state) => state.publishNextPairing);
  const verifyPassword = useTournamentStore((state) => state.verifyPassword);
  const startFinal = useTournamentStore((state) => state.startFinal);
  const submitFinalResult = useTournamentStore((state) => state.submitFinalResult);
  const setFinalWinner = useTournamentStore((state) => state.setFinalWinner);
  const publishFinal = useTournamentStore((state) => state.publishFinal);
  const card = selectCard(cards, id); const [busy, setBusy] = useState(false);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [editUnlocked, setEditUnlocked] = useState(false);
  const [pwOpen, setPwOpen] = useState(false); const [pwBusy, setPwBusy] = useState(false); const [pwError, setPwError] = useState("");
  // Director "ลงดาบ" penalty dialog.
  const [penaltyMatch, setPenaltyMatch] = useState<string | null>(null);
  const [penaltyPoints, setPenaltyPoints] = useState(""); const [penaltyPw, setPenaltyPw] = useState("");
  const [penaltyBusy, setPenaltyBusy] = useState(false); const [penaltyError, setPenaltyError] = useState("");
  const closePenaltyDialog = () => { if (!penaltyBusy) { setPenaltyPw(""); setPenaltyMatch(null); } };

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  // Result entry is operator work (director/staff). Admins and public viewers watch published
  // results on the overview page and never reach the games workspace.
  if (!isOperator(auth)) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="ดูผลที่เผยแพร่แล้วได้จากหน้าภาพรวมของการ์ด" action={<Link prefetch={false} href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
  if (!card) return <CardNotFound />;

  const playerMap = new Map(card.players.map((player) => [player.id, player]));
  const activeGames = resultBlockGames(card);
  const pairResultBlock = isPairResultBlock(card);
  const blockLabel = activeGames.length === 1 ? `เกม ${activeGames[0]}` : `เกม ${activeGames[0]}–${activeGames[activeGames.length - 1]}`;
  const currentSnapshot = card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.includes(card.currentGame));
  const pairings = currentSnapshot?.pairings.filter((pairing) => activeGames.includes(pairing.gameNumber ?? card.currentGame)) ?? [];
  const resultCollection = card.runtimeStage === "RESULT_COLLECTION"; const reviewing = card.runtimeStage === "RESULT_REVIEW";
  // PAIR_RESULT materialises exactly one destination row per source row, including byes.
  // Deriving from the live source avoids terminated/restored players skewing the UI count.
  const sourceCount = pairResultBlock
    ? pairings.filter((pairing) => (pairing.gameNumber ?? card.currentGame) === activeGames[0]).length
    : pairings.length;
  const expectedCount = pairResultBlock ? sourceCount * activeGames.length : sourceCount;
  const completedCount = pairings.filter(isRecorded).length;
  const allComplete = pairings.length === expectedCount && completedCount === expectedCount;
  const pairingsForGame = (gameNumber: number) => pairings.filter((pairing) => (pairing.gameNumber ?? card.currentGame) === gameNumber);
  const sourcePairings = pairResultBlock ? pairingsForGame(activeGames[0]) : [];
  const sourceComplete = sourcePairings.length > 0 && sourcePairings.every(isRecorded);
  const destinationPairings = pairResultBlock ? pairingsForGame(activeGames[1]) : [];
  const hasAnyPlayer = (pairing?: Pairing) => Boolean(pairing?.playerOneId || pairing?.playerTwoId);
  const destinationPairingComplete = pairResultBlock && sourceComplete
    && destinationPairings.length === sourcePairings.length
    && destinationPairings.every(hasAnyPlayer);
  const destinationPairingPublished = destinationPairings.length > 0
    && destinationPairings.every((pairing) => pairing.pairingPublished);
  const maxDiffForGame = (gameNumber: number) => card.games.find((game) => game.number === gameNumber)?.maxDiff ?? 350;
  const latestActiveGame = activeGames[activeGames.length - 1];
  const latestActivePairings = pairingsForGame(latestActiveGame);
  // Director-only: navigate to any past/current result block; staff stays on the current block.
  const isDirector = canManageTournament(auth);
  const currentKey = activeGames.join("-");
  const selectableBlocks = allResultBlocks(card).filter((block) => block[0] <= card.currentGame);
  const effectiveKey = viewKey && selectableBlocks.some((block) => block.join("-") === viewKey) ? viewKey : currentKey;
  const selectedBlock = selectableBlocks.find((block) => block.join("-") === effectiveKey) ?? activeGames;
  const viewingCurrent = effectiveKey === currentKey;
  const blockLabelOf = (block: number[]) => block.length === 2 ? `เกม ${block[0]} - เกม ${block[1]}` : `เกม ${block[0]}`;
  const publishedPairingsForGame = (game: number) => {
    const snapshot = card.snapshots.find((item) => Boolean(item.confirmedAt) && item.gameNumbers.includes(game));
    return (snapshot?.pairings ?? []).filter((pairing) => (pairing.gameNumber ?? game) === game);
  };

  const saveResult = (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => submitResult(id, pairing.id, scoreOne, scoreTwo, editExisting);
  const beginReview = async () => { setBusy(true); try { await reviewResults(id); } catch (error) { await appDialog.alert(error instanceof Error ? error.message : "เปิดหน้า review ไม่สำเร็จ", "เปิด Review ไม่สำเร็จ", true); } finally { setBusy(false); } };
  const publishDestinationPairing = async () => {
    if (destinationPairingPublished) return;
    if (!destinationPairingComplete) {
      await appDialog.alert(`Pairing เกม ${activeGames[1]} ยังสร้างไม่ครบ ต้องกรอกผล เกม ${activeGames[0]} ให้ครบก่อน`, "ยัง Publish Pairing ไม่ได้", true);
      return;
    }
    if (!await appDialog.confirm(`Publish Pairing เกม ${activeGames[1]} ให้ Viewer เห็นตอนนี้?`, {
      title: "เผยแพร่ Pairing",
      confirmLabel: "Publish Pairing",
    })) return;
    setBusy(true);
    try { await publishNextPairing(id); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "Publish Pairing ไม่สำเร็จ", "Publish Pairing ไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!await appDialog.confirm(`ยืนยัน Publish ผล ${blockLabel}? ข้อมูลจะขึ้นหน้าภาพรวมและแก้ไขไม่ได้`, {
      title: "เผยแพร่ผลการแข่งขัน",
      confirmLabel: "Finish & Publish",
    })) return;
    const finalGame = activeGames[activeGames.length - 1] === card.games.length; setBusy(true);
    try { await publishResults(id); router.push(finalGame ? `/cards/${id}` : `/cards/${id}/tables`); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "Publish ผลไม่สำเร็จ", "Publish ผลไม่สำเร็จ", true); } finally { setBusy(false); }
  };
  // Director edit-pairing during result collection. The API verifies the password again as well.
  const onSwapPairing = async (gameNumber: number, a: string, b: string, password: string): Promise<boolean> => {
    if (!await verifyPassword(password)) {
      await appDialog.alert("รหัสผ่านไม่ถูกต้อง", "ยืนยันตัวตนไม่สำเร็จ", true);
      return false;
    }
    try { await swapPlayers(id, a, b, password, false, gameNumber); return true; }
    catch (error) {
      const message = error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ";
      if (message.includes("SCHOOL_CONFLICT") && await appDialog.confirm(message.replace("SCHOOL_CONFLICT: ", ""), {
        title: "พบผู้เล่นสถาบันเดียวกัน",
        confirmLabel: "ยืนยันการสลับ",
      })) {
        try { await swapPlayers(id, a, b, password, true, gameNumber); return true; }
        catch (retry) { await appDialog.alert(retry instanceof Error ? retry.message : "สลับผู้เล่นไม่สำเร็จ", "สลับผู้เล่นไม่สำเร็จ", true); return false; }
      }
      if (!message.includes("SCHOOL_CONFLICT")) await appDialog.alert(message, "สลับผู้เล่นไม่สำเร็จ", true);
      return false;
    }
  };
  const onUnpairing = async () => {
    const password = await appDialog.prompt("Pairing ปัจจุบันจะถูกลบทั้งหมด และระบบจะกลับไปอยู่ในสถานะรอกด Pairing ใหม่ ใช้ได้เมื่อยังไม่มีการกรอกผลในเกมนี้", {
      title: "ยืนยัน Unpairing",
      label: "รหัสผ่านผู้อำนวยการ",
      type: "password",
      confirmLabel: "ยืนยัน Unpairing",
    });
    if (!password) return;
    try { await unpairCurrentPairing(id, password); router.push(`/cards/${id}/tables`); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "ยกเลิกการจับคู่ไม่สำเร็จ", "Unpairing ไม่สำเร็จ", true); }
  };
  const confirmPw = async (password: string) => {
    if (!password) return;
    setPwBusy(true); setPwError("");
    try {
      if (await verifyPassword(password)) { setEditUnlocked(true); setPwOpen(false); }
      else setPwError("รหัสผ่านไม่ถูกต้อง");
    } catch { setPwError("ตรวจสอบรหัสผ่านไม่สำเร็จ"); }
    finally { setPwBusy(false); }
  };

  const oneOnly = (pairing?: Pairing) => Boolean(pairing) && (Boolean(pairing!.playerOneId) !== Boolean(pairing!.playerTwoId));
  const openPenalty = (pairing: Pairing) => { setPenaltyMatch(pairing.id); setPenaltyPoints(""); setPenaltyPw(""); setPenaltyError(""); };
  const submitPenalty = async () => {
    if (!penaltyMatch) return;
    const points = Number(penaltyPoints);
    if (!Number.isInteger(points) || points < 0) { setPenaltyError("แต้มต้องเป็นจำนวนเต็ม ≥ 0"); return; }
    if (!penaltyPw) { setPenaltyError("กรุณาใส่รหัสผ่านผู้อำนวยการ"); return; }
    setPenaltyBusy(true); setPenaltyError("");
    try { await applyPenalty(id, penaltyMatch, points, penaltyPw); closePenaltyDialog(); }
    catch (error) { setPenaltyError(error instanceof Error ? error.message : "ลงดาบไม่สำเร็จ"); }
    finally { setPenaltyBusy(false); }
  };
  const withdrawPenalty = async (pairing: Pairing) => {
    const password = await appDialog.prompt(
      "ผลคู่นี้จะกลับเป็นช่องว่างเหมือนยังไม่เคยกรอกผล และจึงจะกรอกคะแนนใหม่ได้",
      {
        title: "ถอนดาบ?",
        label: "รหัสผ่านผู้อำนวยการ",
        type: "password",
        confirmLabel: "ยืนยันถอนดาบ",
      },
    );
    if (!password) return;
    try { await revokePenalty(id, pairing.id, password); }
    catch (error) {
      await appDialog.alert(error instanceof Error ? error.message : "ถอนดาบไม่สำเร็จ", "ถอนดาบไม่สำเร็จ", true);
    }
  };

  if (card.runtimeStage === "FINAL_SEEDING" || card.runtimeStage === "FINAL_COLLECTION" || (card.runtimeStage === "FINAL_PUBLISHED" && card.finalType !== "NONE")) {
    return <FinalRoundView card={card} canManage={isDirector}
      onStart={() => startFinal(id)}
      onSubmitGame={(slot, gameIndex, scoreOne, scoreTwo, password) => submitFinalResult(id, slot, gameIndex, scoreOne, scoreTwo, password)}
      onSetWinner={(slot, winnerId, winnerWins, winnerLosses, totalDiff, password) => setFinalWinner(id, slot, winnerId, winnerWins, winnerLosses, totalDiff, password)}
      onPublish={() => publishFinal(id)} />;
  }

  if (!resultCollection && !reviewing) return <><PageHeader eyebrow={`${card.name} · ${stageLabels[card.runtimeStage]}`} title="ผลการแข่งขัน" description="ดูอันดับแต่ละเกม และค้นหาผู้เล่นเพื่อดูประวัติการเล่นย้อนหลัง · การกรอกผลจะเปิดเมื่อยืนยัน pairing เกมปัจจุบัน" /><GamesBrowse card={card} players={playerMap} canEdit={isDirector} onOverride={(matchId, scoreOne, scoreTwo) => overrideResult(id, matchId, scoreOne, scoreTwo)} onRevokePenalty={withdrawPenalty} /></>;

  return (
    <>
      <PageHeader
        className="results-entry-header"
        eyebrow={`${card.name} · ${blockLabel}`}
        title={reviewing ? "Review ผลการแข่งขัน" : "กรอกผลการแข่งขัน"}
        description={reviewing ? "ตรวจคะแนน ผลชนะ/เสมอ และ diff ก่อน Publish" : pairResultBlock ? "กรอกเกมต้นทางก่อน ระบบจะสร้างคู่ผู้ชนะและคู่ผู้แพ้ในเกมถัดไปให้กรอกต่อในหน้าเดียวกัน" : "พิมพ์คะแนนในตารางแล้วกด Enter หรือปุ่มบันทึกในแถวนั้น"}
        actions={canManageTournament(auth) && (resultCollection
          ? <div className="page-actions">
              {pairResultBlock && !destinationPairingPublished && (
                <Button variant="secondary" disabled={busy || !destinationPairingComplete} onClick={() => void publishDestinationPairing()}
                  title={destinationPairingComplete ? `เผยแพร่ Pairing เกม ${activeGames[1]} ไปยังหน้าภาพรวม` : `ต้องให้ Pairing เกม ${activeGames[1]} สร้างครบก่อน`}>
                  <Megaphone size={16} />Publish Pairing เกม {activeGames[1]}
                </Button>
              )}
              <Button variant="success" disabled={!allComplete || busy} onClick={beginReview}><Eye size={16} />Review ผล <ArrowRight size={16} /></Button>
            </div>
          : <div className="page-actions"><Button variant="secondary" disabled={busy} onClick={() => void reopenResults(id)}><ArrowLeft size={16} />กลับไปแก้ไข</Button><Button variant="success" disabled={busy} onClick={publish}>{activeGames[activeGames.length - 1] === card.games.length ? <Trophy size={16} /> : <Check size={16} />}Finish & Publish</Button></div>)}
      />
      {!isDirector && resultCollection && allComplete && (
        <div className="notice notice--success"><CheckCircle2 size={18} /><p><strong>กรอกผล{blockLabel}ครบทุกคู่แล้ว</strong><span>รอผู้อำนวยการตรวจสอบ (Review) และเผยแพร่ผล — แก้ไขคะแนนได้จนกว่าจะ Publish</span></p></div>
      )}
      {!isDirector && reviewing && (
        <div className="notice notice--info"><Eye size={18} /><p><strong>ผู้อำนวยการกำลัง Review ผล{blockLabel}</strong><span>ผลจะขึ้นหน้าภาพรวมทันทีที่ Publish</span></p></div>
      )}
      {isDirector && resultCollection && selectableBlocks.length > 1 && (
        <div className="entry-toolbar director-game-toolbar">
          <div className="director-game-picker">
            <span className="director-game-picker__label">เลือกเกม/บล็อกที่จะดู (ผู้อำนวยการ)</span>
            <SelectMenu
              ariaLabel="เลือกเกมหรือบล็อกผลการแข่งขัน"
              className="director-game-menu"
              value={effectiveKey}
              options={selectableBlocks.map((block) => ({
                value: block.join("-"),
                label: `${blockLabelOf(block)}${block.join("-") === currentKey ? " · ปัจจุบัน" : ""}`,
              }))}
              onChange={setViewKey}
            />
          </div>
          {!viewingCurrent && <span className="director-game-toolbar__note">กำลังดูเกมย้อนหลัง — แก้ได้หลังยืนยันรหัสผ่าน · standing คำนวณใหม่ทุกเกม แต่ pairing เดิมไม่ถูกจับใหม่</span>}
        </div>
      )}
      {resultCollection && !viewingCurrent ? (
        editUnlocked ? (
          <OverrideEditor key={effectiveKey} block={selectedBlock} pairingsForGame={publishedPairingsForGame} players={playerMap} onCommit={(matchId, scoreOne, scoreTwo) => overrideResult(id, matchId, scoreOne, scoreTwo)} onRevokePenalty={withdrawPenalty} onDone={() => setEditUnlocked(false)} />
        ) : (
          <>
            <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>แก้ไขผลย้อนหลัง (เฉพาะผู้อำนวยการ)</strong><span>ยืนยันรหัสผ่านบัญชีของคุณก่อน จึงจะแก้ผลของบล็อกนี้ได้ · แก้ได้หลายคู่แล้วบันทึกทีเดียว</span></p><Button size="sm" onClick={() => { setPwError(""); setPwOpen(true); }}><LockKeyhole size={14} />ยืนยันรหัสผ่านเพื่อแก้ไข</Button></div>
            {selectedBlock.map((gameNumber) => {
              const past = publishedPairingsForGame(gameNumber);
              if (past.length === 0) return <Panel key={gameNumber}><EmptyState icon={<Gamepad2 size={25} />} title={`เกม ${gameNumber} ยังไม่มีผลที่เผยแพร่`} description="เลือกบล็อกอื่นจาก dropdown" /></Panel>;
              return <Panel key={gameNumber} title={`ผล เกม ${gameNumber} (ย้อนหลัง)`} description="ดูอย่างเดียว — ยืนยันรหัสผ่านเพื่อแก้ไข"><ResultViewGrid pairings={past} players={playerMap} storageKey={`${id}:past:${gameNumber}`} /></Panel>;
            })}
          </>
        )
      ) : resultCollection ? <>
        {activeGames.map((gameNumber) => {
          const gamePairings = pairingsForGame(gameNumber);
          const maxDiff = maxDiffForGame(gameNumber);
          const isDestination = pairResultBlock && gameNumber === activeGames[1];
          // A one-player game-1 row is a bye; a one-player destination row is a bye once the whole source game is recorded.
          const destinationSourceComplete = isDestination && sourceComplete;
          const slots: EntrySlot[] = isDestination
            ? [...pairingsForGame(activeGames[0])].sort((a, b) => a.tableNumber - b.tableNumber).map((source) => { const dest = gamePairings.find((d) => d.tableNumber === source.tableNumber); return { tableNumber: source.tableNumber, pairing: dest, isBye: oneOnly(dest) && destinationSourceComplete }; })
            : [...gamePairings].sort((a, b) => a.tableNumber - b.tableNumber).map((pairing) => ({ tableNumber: pairing.tableNumber, pairing, isBye: oneOnly(pairing) }));
          const completed = gamePairings.filter(isRecorded).length;
          const destinationHasPlayers = isDestination && gamePairings.some(hasAnyPlayer);
          const publishTitle = !sourceComplete
            ? `ต้องกรอกผล เกม ${activeGames[0]} ให้ครบก่อน`
            : !destinationPairingComplete
              ? `Pairing เกม ${gameNumber} ยังสร้างไม่ครบ`
              : `เผยแพร่ Pairing เกม ${gameNumber} ไปยังหน้าภาพรวม`;
          const pairingEdit = isDirector
            ? isDestination
              ? {
                  onSwap: (a: string, b: string, password: string) => onSwapPairing(gameNumber, a, b, password),
                  swapDisabled: !destinationHasPlayers,
                  swapTitle: destinationHasPlayers ? "สลับผู้เล่นใน Pairing เกมปลายทางที่ยังไม่กรอกผล" : "ยังไม่มีผู้เล่นใน Pairing เกมปลายทางให้สลับ",
                  onPublish: destinationPairingPublished ? undefined : publishDestinationPairing,
                  publishDisabled: busy || !destinationPairingComplete,
                  publishLabel: `Publish Pairing เกม ${gameNumber}`,
                  publishTitle,
                }
              : gameNumber === card.currentGame
                ? { onSwap: (a: string, b: string, password: string) => onSwapPairing(gameNumber, a, b, password), onUnpair: onUnpairing }
                : undefined
            : undefined;
          if (slots.length === 0) return <Panel key={gameNumber}><EmptyState icon={<Gamepad2 size={25} />} title={`เกม ${gameNumber} ยังไม่มีคู่แข่งขัน`} description="ยืนยัน pairing เกมนี้ก่อนจึงจะกรอกผลได้" /></Panel>;
          return <Panel key={gameNumber} title={`กรอกผล เกม ${gameNumber}`} description={`โครงสร้างแบบ Excel · กรอกแล้วกด Enter หรือปุ่มเซฟ · Win +2 / Draw +1 / Loss +0 · Max diff ${maxDiff}`} actions={<Badge tone={completed === slots.length ? "success" : "warning"}>{completed}/{slots.length} คู่</Badge>}>
            <ResultEntryGrid gameNumber={gameNumber} slots={slots} players={playerMap} maxDiff={maxDiff} storageKey={`${id}:${gameNumber}`} onSubmit={saveResult} onPenalty={isDirector ? openPenalty : undefined} onRevokePenalty={isDirector ? withdrawPenalty : undefined} pairingEdit={pairingEdit} />
          </Panel>;
        })}
      </> : (
        <>{activeGames.map((gameNumber) => {
          const gamePairings = pairingsForGame(gameNumber); const maxDiff = maxDiffForGame(gameNumber);
          return <Panel key={gameNumber} title={`Review เกม ${gameNumber}`} description={`${gamePairings.length} คู่ · Maximum Difference ${maxDiff}`}>
            <ResultViewGrid pairings={gamePairings} players={playerMap} storageKey={`${id}:review:${gameNumber}`} />
          </Panel>;
        })}</>
      )}
      {viewingCurrent && latestActivePairings.length > 0 && (
        <Panel title={`Pairing เกม ${latestActiveGame}`} description="คู่แข่งขันของเกมที่กำลังกรอกผล">
          <PairingGrid pairings={latestActivePairings} players={playerMap} storageKey={`${id}:games:current-pairing`} />
        </Panel>
      )}

      <PromptDialog
        open={pwOpen}
        eyebrow="ยืนยันตัวตน"
        title="ยืนยันรหัสผ่านผู้อำนวยการ"
        description={`กรอกรหัสผ่านบัญชีของคุณ (${auth.username}) เพื่อยืนยันการแก้ไขผลย้อนหลัง · standing จะคำนวณใหม่ทุกเกม`}
        label="รหัสผ่าน"
        type="password"
        confirmLabel="ยืนยัน"
        busy={pwBusy}
        error={pwError || undefined}
        onSubmit={(value) => void confirmPw(value)}
        onCancel={() => { if (!pwBusy) { setPwOpen(false); setPwError(""); } }}
      />

      <ConfirmDialog
        open={penaltyMatch !== null}
        eyebrow="ลงดาบ"
        icon={<Gavel size={20} />}
        title="บังคับแพ้ทั้งคู่"
        description={`กำหนดแต้มที่หัก (diff −X) ให้ทั้งคู่ของคู่นี้ (รวมคู่บายที่มีคนเดียว) แล้วยืนยันด้วยรหัสผ่านผู้อำนวยการ (${auth.username})`}
        confirmLabel="ยืนยันลงดาบ"
        busyLabel="กำลังลงดาบ…"
        danger
        busy={penaltyBusy}
        error={penaltyError || undefined}
        onConfirm={() => void submitPenalty()}
        onCancel={closePenaltyDialog}
      >
        <label className="form-label" htmlFor="penalty-points">แต้มที่หัก (X)</label>
        <input className="input" id="penalty-points" type="number" min={0} autoFocus value={penaltyPoints} placeholder="เช่น 100" disabled={penaltyBusy} onChange={(event) => setPenaltyPoints(event.target.value)} />
        <label className="form-label" htmlFor="penalty-pw">รหัสผ่านผู้อำนวยการ</label>
        <FreshSecretInput className="input" id="penalty-pw" value={penaltyPw} placeholder="รหัสผ่าน" disabled={penaltyBusy} onChange={(event) => setPenaltyPw(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitPenalty(); }} />
      </ConfirmDialog>
    </>
  );
}
