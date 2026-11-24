"use client";

import "../../../prototype-results.css";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, Gamepad2, Globe, LoaderCircle, LockKeyhole, Megaphone, Trophy, Undo2 } from "lucide-react";
import { useState } from "react";
import { ApiError, selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { canManageTournament, isOperator } from "@/domain/tournament/roles";
import { allResultBlocks, editableResultGames, resultBlockGames } from "@/domain/tournament/flow";
import { rankingAfterGame } from "@/domain/tournament/history";
import { blockCompletion, isRecordedPairing, isVoidPairing } from "@/domain/tournament/pairing-slot";
import { useNavigateWithPending } from "@/ui/layout/use-navigate-with-pending";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { PromptDialog } from "@/ui/components/prompt-dialog";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { PenaltySword, ResultEntryGrid, ResultViewGrid, type EntrySlot } from "@/ui/components/result-entry-grid";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { RankingGrid } from "@/ui/components/standings-grids";
import { OverrideEditor } from "@/ui/components/override-editor";
import { FinalRoundBoard } from "@/ui/components/final-round-board";
import { SelectMenu } from "@/ui/components/select-menu";
import { operatorStageLabels } from "@/ui/components/stage-info";

function GamesBrowse({ card, players, canEdit, onOverride, onRevokePenalty }: {
  card: TournamentCard;
  players: Map<string, Player>;
  canEdit: boolean;
  onOverride: (matchId: string, scoreOne: number, scoreTwo: number) => Promise<void>;
  onRevokePenalty: (pairing: Pairing) => void;
}) {
  const [rankingGame, setRankingGame] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Published results are read-only until the director re-enters the password for that game.
  const verifyPassword = useTournamentStore((state) => state.verifyPassword);
  const [unlocked, setUnlocked] = useState<number | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState("");
  const askUnlock = (game: number) => { setPwError(""); setAsking(game); };
  const confirmUnlock = async (password: string) => {
    if (!password || asking === null) return;
    setPwBusy(true); setPwError("");
    try {
      if (await verifyPassword(password)) { setUnlocked(asking); setAsking(null); }
      else setPwError("รหัสผ่านไม่ถูกต้อง");
    } catch { setPwError("ตรวจสอบรหัสผ่านไม่สำเร็จ"); }
    finally { setPwBusy(false); }
  };
  const publishedSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const games = [...new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers))].sort((a, b) => a - b);
  const latest = games[games.length - 1] ?? 0;
  const selected = rankingGame && games.includes(rankingGame) ? rankingGame : latest;
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const ranked = selected > 0 ? rankingAfterGame(rankingCard, selected) : [];
  const selectedPlayer = selectedId ? players.get(selectedId) : undefined;
  const publishedPairingsForGame = (game: number) => {
    const snapshot = publishedSnapshots.find((item) => item.gameNumbers.includes(game));
    return snapshot?.pairings.filter((pairing) => (pairing.gameNumber ?? game) === game) ?? [];
  };

  return (
    <>
      {games.length > 0 ? (
        <section className="panel" aria-label="อันดับหลังจบเกม">
          <div className="panel-head"><h2>อันดับ · หลังเกม {selected}</h2><span className="desc">คะแนนชัยชนะและผลต่างสะสม</span>
            <span className="actions"><SelectMenu appearance="prototype" ariaLabel="เลือกเกมสำหรับอันดับ" value={String(selected)}
              options={games.map((game) => ({ value: String(game), label: `เกม ${game}${game === latest ? " · ล่าสุด" : ""}` }))}
              onChange={(value) => { const game = Number(value); setRankingGame(game); setUnlocked(null); if (canEdit && game !== latest) askUnlock(game); }} /></span></div>
          <RankingGrid ranked={ranked} storageKey={`${card.id}:games:ranking`} resetKey={String(selected)} onRowClick={(player) => setSelectedId(player.id)} activeId={selectedId} />
        </section>
      ) : (
        <div className="notice notice--quiet"><p>ยังไม่มีอันดับที่เผยแพร่</p></div>
      )}

      {games.length > 0 && <section className="panel director-grid-panel" aria-label={`ผล เกม ${selected}`}>
        <div className="panel-head"><h2>ผล เกม {selected}</h2><span className="desc">{canEdit && unlocked === selected ? "โหมดแก้ไข" : "ดูอย่างเดียว"}</span>
          {canEdit && unlocked !== selected && <span className="actions"><button type="button" className="btn btn--sm btn--secondary" onClick={() => askUnlock(selected)}>
            <LockKeyhole className="i" size={13} />แก้ไขผล</button></span>}</div>
        {canEdit && unlocked === selected
          ? <OverrideEditor key={selected} block={[selected]} pairingsForGame={publishedPairingsForGame} players={players} onCommit={onOverride}
              onRevokePenalty={onRevokePenalty} onDone={() => setUnlocked(null)} />
          : <ResultViewGrid pairings={publishedPairingsForGame(selected)} players={players} />}
      </section>}
      {canEdit && <PromptDialog appearance="prototype" open={asking !== null} eyebrow="ยืนยันตัวตน" title="ยืนยันรหัสผ่านผู้อำนวยการ"
        description={`กรอกรหัสผ่านเพื่อแก้ไขผลเกม ${asking ?? ""} ที่เผยแพร่แล้ว · อันดับจะคำนวณใหม่ทันทีและระบบบันทึกกิจกรรม`}
        label="รหัสผ่าน" type="password" confirmLabel="ยืนยัน" busy={pwBusy} error={pwError || undefined}
        onSubmit={(value) => void confirmUnlock(value)} onCancel={() => { if (!pwBusy) { setAsking(null); setPwError(""); } }} />}

      {selectedPlayer && (
        <Panel
          title={`ประวัติการเล่น · ${selectedPlayer.id} · ${selectedPlayer.firstName} ${selectedPlayer.lastName}`}
          description={`${selectedPlayer.school} · แต้มชัยชนะและผลต่างสะสมคิดรวมจากเกมแรกถึงเกมนั้น`}
          actions={<Button variant="secondary" size="sm" onClick={() => setSelectedId(null)}>ปิดประวัติ</Button>}
        >
          <PlayerHistoryTable card={rankingCard} players={players} playerId={selectedId!} scope={{ throughGame: selected, includeFinal: false }} />
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
  const { id } = useParams<{ id: string }>(); const { pending: navPending, navigate } = useNavigateWithPending();
  const cards = useTournamentStore((state) => state.cards); const auth = useTournamentStore((state) => state.auth); const loading = useTournamentStore((state) => state.loading);
  const submitResult = useTournamentStore((state) => state.submitResult); const reviewResults = useTournamentStore((state) => state.reviewResults);
  const reopenResults = useTournamentStore((state) => state.reopenResults); const publishResults = useTournamentStore((state) => state.publishResults);
  const overrideResult = useTournamentStore((state) => state.overrideResult);
  const applyPenalty = useTournamentStore((state) => state.applyPenalty);
  const revokePenalty = useTournamentStore((state) => state.revokePenalty);
  const swapPlayers = useTournamentStore((state) => state.swapPlayers);
  const unpairCurrentPairing = useTournamentStore((state) => state.unpairCurrentPairing);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const terminatePublicationHolds = useTournamentStore((state) => state.terminatePublicationHolds);
  const publishNextPairing = useTournamentStore((state) => state.publishNextPairing);
  const verifyPassword = useTournamentStore((state) => state.verifyPassword);
  const startFinal = useTournamentStore((state) => state.startFinal);
  const submitFinalResult = useTournamentStore((state) => state.submitFinalResult);
  const setFinalWinner = useTournamentStore((state) => state.setFinalWinner);
  const publishFinal = useTournamentStore((state) => state.publishFinal);
  const card = selectCard(cards, id); const [busy, setBusy] = useState(false);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [activeGame, setActiveGame] = useState<number>();
  const [unpairOpen, setUnpairOpen] = useState(false);
  const [publicationHolds, setPublicationHolds] = useState<string[]>();
  const [actionError, setActionError] = useState("");
  const [byeMatch, setByeMatch] = useState<Pairing>();
  const [byeScore, setByeScore] = useState("");
  const [byePassword, setByePassword] = useState("");
  const [byeError, setByeError] = useState("");
  const [byeBusy, setByeBusy] = useState(false);
  const forceBye = useTournamentStore((state) => state.forceBye);
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
  const configuredGames = resultBlockGames(card);
  const activeGames = editableResultGames(card);
  const pairResultBlock = activeGames.length > 1;
  const displayedGame = activeGames.includes(activeGame ?? 0) ? activeGame : activeGames[0];
  const blockLabel = activeGames.length === 1 ? `เกม ${activeGames[0]}` : `เกม ${activeGames[0]}–${activeGames[activeGames.length - 1]}`;
  const currentSnapshot = card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.some((game) => activeGames.includes(game)));
  const pairings = currentSnapshot?.pairings.filter((pairing) => activeGames.includes(pairing.gameNumber ?? card.currentGame)) ?? [];
  const resultCollection = card.runtimeStage === "RESULT_COLLECTION"; const reviewing = card.runtimeStage === "RESULT_REVIEW";
  const allComplete = blockCompletion(pairings, activeGames, card.currentGame, pairResultBlock).complete;
  const pairingsForGame = (gameNumber: number) => pairings.filter((pairing) => (pairing.gameNumber ?? card.currentGame) === gameNumber);
  const sourcePairings = pairResultBlock ? pairingsForGame(activeGames[0]) : [];
  const sourceComplete = sourcePairings.length > 0 && sourcePairings.every((pair) => isVoidPairing(pair) || isRecordedPairing(pair));
  const destinationPairingComplete = pairResultBlock && sourceComplete;
  const legacySourcePublished = configuredGames.length > activeGames.length;
  const destinationPairingPublished = legacySourcePublished ||
    (pairResultBlock && pairingsForGame(activeGames[1]).some((pair) => pair.pairingPublished));
  const maxDiffForGame = (gameNumber: number) => card.games.find((game) => game.number === gameNumber)?.maxDiff ?? 350;
  // Both operators can inspect published blocks. Historical edits require a director.
  const isDirector = canManageTournament(auth);
  const currentKey = activeGames.join("-");
  const scheduledBlocks = allResultBlocks(card);
  const selectableBlocks = [...scheduledBlocks.filter((block) => block[0] < card.currentGame
    && card.snapshots.some(snapshot => snapshot.confirmedAt && snapshot.gameNumbers.includes(block[0]))),
    ...(legacySourcePublished ? [[card.currentGame]] : []), activeGames];
  const effectiveKey = viewKey && selectableBlocks.some((block) => block.join("-") === viewKey) ? viewKey : currentKey;
  const selectedBlock = selectableBlocks.find((block) => block.join("-") === effectiveKey) ?? activeGames;
  const viewingCurrent = effectiveKey === currentKey;
  const blockLabelOf = (block: number[]) => block.length === 2 ? `เกม ${block[0]} - เกม ${block[1]}` : `เกม ${block[0]}`;
  const publishedPairingsForGame = (game: number) => {
    const snapshot = card.snapshots.find((item) => Boolean(item.confirmedAt) && item.gameNumbers.includes(game));
    return (snapshot?.pairings ?? []).filter((pairing) => (pairing.gameNumber ?? game) === game);
  };

  const saveResult = (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => submitResult(id, pairing.id, scoreOne, scoreTwo, editExisting);
  const openBye = (pairing: Pairing) => {
    setByeScore(""); setByePassword(""); setByeError(""); setByeMatch(pairing);
  };
  const submitBye = async () => {
    const player = byeMatch?.playerOneId ?? byeMatch?.playerTwoId;
    const score = Number(byeScore);
    if (!byeMatch || !player || !Number.isInteger(score) || score < 1 || score > 1500 || !byePassword) {
      setByeError("กรอกคะแนนตั้งแต่ 1 ถึง 1500 และรหัสผ่านผู้อำนวยการ"); return;
    }
    setByeBusy(true); setByeError("");
    try { await forceBye(id, byeMatch.id, player, score, byePassword); setByeMatch(undefined); setByePassword(""); }
    catch (error) { setByeError(error instanceof Error ? error.message : "บันทึกผลบายไม่สำเร็จ"); }
    finally { setByeBusy(false); }
  };
  const beginReview = async () => { setBusy(true); try { await reviewResults(id); } catch (error) { await appDialog.alert(error instanceof Error ? error.message : "เปิดหน้าตรวจผลไม่สำเร็จ", "เปิดตรวจผลไม่สำเร็จ", true); } finally { setBusy(false); } };
  const publishDestinationPairing = async () => {
    if (destinationPairingPublished) return;
    if (!destinationPairingComplete) {
      await appDialog.alert(`คู่แข่งขันเกม ${activeGames[1]} ยังสร้างไม่ครบ ต้องกรอกผลเกม ${activeGames[0]} ให้ครบก่อน`, "ยังเผยแพร่คู่แข่งขันไม่ได้", true);
      return;
    }
    if (!await appDialog.confirm(`เผยแพร่คู่แข่งขันเกม ${activeGames[1]} ให้ผู้ชมเห็นตอนนี้?`, {
      title: "เผยแพร่คู่แข่งขัน",
      confirmLabel: "เผยแพร่คู่แข่งขัน",
    })) return;
    setBusy(true);
    try { await publishNextPairing(id); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "เผยแพร่คู่แข่งขันไม่สำเร็จ", "เผยแพร่คู่แข่งขันไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    const held = (card.screeningPool ?? []).map((hold) => hold.player);
    if (held.length) { setActionError(""); setPublicationHolds(held); return; }
    if (!await appDialog.confirm(`เผยแพร่ผล ${blockLabel}? ข้อมูลจะขึ้นหน้าภาพรวม และการแก้ไขภายหลังต้องใช้โหมดแก้ผลย้อนหลัง`, {
      title: "เผยแพร่ผลการแข่งขัน",
      confirmLabel: "เผยแพร่ผล",
    })) return;
    const finalGame = activeGames[activeGames.length - 1] === card.games.length; setBusy(true);
    try { await publishResults(id); navigate(finalGame ? `/cards/${id}` : `/cards/${id}/tables`); }
    catch (error) {
      if (error instanceof ApiError && error.code === "SCREENING_POOL_PENDING") {
        await syncCard(id);
        const current = selectCard(useTournamentStore.getState().cards, id);
        const changed = current?.screeningPool?.map(hold => hold.player) ?? [];
        if (changed.length) { setActionError(""); setPublicationHolds(changed); }
        else await appDialog.alert(error.message, "มีผู้เล่นค้างในถังคัดชั่วคราว", true);
      } else await appDialog.alert(error instanceof Error ? error.message : "เผยแพร่ผลไม่สำเร็จ", "เผยแพร่ผลไม่สำเร็จ", true);
    } finally { setBusy(false); }
  };
  const resolvePublicationHolds = async (password: string) => {
    if (!publicationHolds) return;
    setBusy(true); setActionError("");
    try { await terminatePublicationHolds(id, publicationHolds, password); setPublicationHolds(undefined); }
    catch (error) {
      if (error instanceof ApiError && error.code === "SCREENING_POOL_PENDING") {
        await syncCard(id);
        const current = selectCard(useTournamentStore.getState().cards, id);
        const remaining = current?.screeningPool?.map(hold => hold.player) ?? [];
        setPublicationHolds(remaining.length ? remaining : undefined);
      }
      setActionError(error instanceof Error ? error.message : "ถอนผู้เล่นไม่สำเร็จ");
    }
    finally { setBusy(false); }
  };
  // Director edit-pairing during result collection. The swap verifies the password itself, so a
  // wrong one returns 403 + BAD_PASSWORD from that request rather than from a pre-flight.
  const onSwapPairing = async (gameNumber: number, a: string, b: string, password: string): Promise<boolean> => {
    try { await swapPlayers(id, a, b, password, false, gameNumber); return true; }
    catch (error) {
      const message = error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ";
      if (!message.includes("SCHOOL_CONFLICT")) throw error;
      if (!await appDialog.confirm(message.replace("SCHOOL_CONFLICT: ", ""), {
        title: "พบผู้เล่นสถาบันเดียวกัน",
        confirmLabel: "ยืนยันการสลับ",
      })) return false;
      await swapPlayers(id, a, b, password, true, gameNumber);
      return true;
    }
  };
  const onUnpairing = async (password: string) => {
    setBusy(true); setActionError("");
    try { await unpairCurrentPairing(id, password); setUnpairOpen(false); navigate(`/cards/${id}/tables`); }
    catch (error) { setActionError(error instanceof Error ? error.message : "ยกเลิกการจับคู่ไม่สำเร็จ"); }
    finally { setBusy(false); }
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
  const blockPicker = <SelectMenu appearance="prototype" ariaLabel="เลือกเกม" value={effectiveKey}
    options={selectableBlocks.map((block) => ({ value: block.join("-"), label: `${blockLabelOf(block)}${block.join("-") === currentKey ? " · ปัจจุบัน" : ""}` }))}
    onChange={(value) => { setEditUnlocked(false); setViewKey(value); }} />;
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

  if (!resultCollection && !reviewing) return <div className={`director-score${isDirector ? "" : " staff-score"}`}>
    <div className="page-head"><div className="ttl"><span className="eyebrow">{card.name} · {card.division} · {operatorStageLabels[card.runtimeStage]}</span><h1>ผลการแข่งขัน</h1></div>
      {isDirector && (card.runtimeStage === "TABLE_PAIRING" || card.runtimeStage === "PAIRING_PREVIEW") && <div className="actions"><Link className="btn btn--primary" prefetch={false} href={`/cards/${id}/tables`}>ไปหน้าโต๊ะแข่งขัน <ArrowRight className="i" size={14} /></Link></div>}</div>
    <GamesBrowse card={card} players={playerMap} canEdit={isDirector} onOverride={(matchId, scoreOne, scoreTwo) => overrideResult(id, matchId, scoreOne, scoreTwo)} onRevokePenalty={withdrawPenalty} />
  </div>;

  return (
    <div className={`director-score${isDirector ? "" : " staff-score"}`}>
      <div className="page-head">
        <div className="ttl"><h1>{reviewing ? (isDirector ? "ตรวจผลการแข่งขัน" : "ผู้อำนวยการกำลังตรวจผล") : <span className="sr">ผลการแข่งขัน</span>}</h1></div>
        {isDirector && (resultCollection
          ? <div className="actions">
              {viewingCurrent && !destinationPairingPublished && pairings.some((pair) => !isVoidPairing(pair)) && !pairings.some(isRecordedPairing) &&
                <Button variant="secondary" className="btn btn--secondary" disabled={busy} onClick={() => { setActionError(""); setUnpairOpen(true); }}><Undo2 className="i" size={14} />Unpairing</Button>}
              {pairResultBlock && !destinationPairingPublished && (
                <Button variant="secondary" className="btn btn--secondary" disabled={busy || !viewingCurrent || !destinationPairingComplete} onClick={() => void publishDestinationPairing()}
                  title={destinationPairingComplete ? `เผยแพร่ Pairing เกม ${activeGames[1]} ไปยังหน้าภาพรวม` : `ต้องให้ Pairing เกม ${activeGames[1]} สร้างครบก่อน`}>
                  <Megaphone className="i" size={14} />เผยแพร่คู่แข่งขัน เกม {activeGames[1]}
                </Button>
              )}
              {blockPicker}
              <Button variant="success" className="btn btn--success" disabled={!viewingCurrent || !allComplete || busy} onClick={beginReview}
                title={!viewingCurrent ? "เลือกเกมปัจจุบันก่อนตรวจผล" : allComplete ? undefined : "ต้องบันทึกผลให้ครบทุกคู่ก่อน"}><Eye className="i" size={14} />ตรวจผล <ArrowRight className="i" size={14} /></Button>
            </div>
          : <div className="actions"><Button className="btn btn--secondary" variant="secondary" disabled={busy} onClick={() => void reopenResults(id)}><ArrowLeft className="i" size={14} />กลับไปแก้ไข</Button>
            <Button className="btn btn--publish" disabled={busy} onClick={publish}>{navPending ? <LoaderCircle className="i spin" size={14} /> : <Globe className="i" size={14} />}เผยแพร่ผล {blockLabel}</Button></div>)}
      </div>
      {!isDirector && resultCollection && selectableBlocks.length > 1 && <div className="actions">{blockPicker}</div>}
      {resultCollection && !viewingCurrent ? (
        isDirector && editUnlocked ? <OverrideEditor key={effectiveKey} block={selectedBlock} pairingsForGame={publishedPairingsForGame} players={playerMap} onCommit={(matchId, scoreOne, scoreTwo) => overrideResult(id, matchId, scoreOne, scoreTwo)} onRevokePenalty={withdrawPenalty} onDone={() => setEditUnlocked(false)} /> : <>
          <div className="notice notice--warning"><p><strong>ผลย้อนหลัง · {blockLabelOf(selectedBlock)}</strong>{isDirector && <span>ต้องยืนยันรหัสผ่านก่อนแก้ไข</span>}</p>
            {isDirector && <Button className="btn btn--secondary" variant="secondary" onClick={() => { setPwError(""); setPwOpen(true); }}><LockKeyhole className="i" size={13} />ยืนยันรหัสผ่านเพื่อแก้ไข</Button>}
          </div>
          {selectedBlock.map((gameNumber) => <section className="panel director-grid-panel" key={gameNumber} aria-label={`ผล เกม ${gameNumber} (ย้อนหลัง)`}>
              {selectedBlock.length > 1 && <div className="panel-head"><h2>เกม {gameNumber}</h2></div>}
              <ResultViewGrid pairings={publishedPairingsForGame(gameNumber)} players={playerMap} />
            </section>)}
        </>
      ) : resultCollection ? <>
        {pairResultBlock && <div className="block-game-buttons" role="group" aria-label="เลือกเกมในชุดนี้">
          {activeGames.map((game) => <button type="button" className="btn btn--sm btn--secondary" key={game}
            aria-pressed={displayedGame === game} onClick={() => setActiveGame(game)}>เกม {game}</button>)}
        </div>}
        {activeGames.map((gameNumber) => {
          const gamePairings = pairingsForGame(gameNumber);
          const maxDiff = maxDiffForGame(gameNumber);
          const isDestination = pairResultBlock && gameNumber === activeGames[1];
          const tables = [...new Set([...gamePairings.map((pair) => pair.tableNumber),
            ...(isDestination ? sourcePairings.map((pair) => pair.tableNumber) : [])])].sort((a,b) => a-b);
          const slots: EntrySlot[] = tables.map((tableNumber) => {
            const pairing = gamePairings.find((pair) => pair.tableNumber === tableNumber);
            const group = Math.floor((tableNumber - 1) / 2);
            const sources = sourcePairings.filter((pair) => Math.floor((pair.tableNumber - 1) / 2) === group);
            const ready = !isDestination || sourceComplete || (sources.length > 0
              && sources.every((pair) => isVoidPairing(pair) || isRecordedPairing(pair)));
            const isBye = oneOnly(pairing) && (ready || Boolean(pairing?.resultType) || Boolean(pairing?.manualPairing));
            return { tableNumber, pairing, isBye, waiting: isDestination && !ready && !pairing?.voided,
              isVoid: Boolean(pairing?.voided) || (ready && isVoidPairing(pairing)) };
          });
          const pairingEdit = isDirector ? {
            onSwap: (a: string, b: string, password: string) => onSwapPairing(gameNumber, a, b, password),
            swapDisabled: !gamePairings.some((pair) => pair.playerOneId || pair.playerTwoId),
            seats: card.slotLabel === "SEAT",
          } : undefined;
          if (slots.length === 0) return <Panel key={gameNumber}><EmptyState icon={<Gamepad2 size={25} />} title={`เกม ${gameNumber} ยังไม่มีคู่แข่งขัน`} description="ยืนยันคู่แข่งขันเกมนี้ก่อนจึงจะกรอกผลได้" /></Panel>;
          return <section className="panel director-grid-panel" key={gameNumber} aria-label="ผลการแข่งขัน" hidden={gameNumber !== displayedGame}>
            {pairResultBlock && <div className="panel-head"><h2>เกม {gameNumber}</h2></div>}
            <ResultEntryGrid gameNumber={gameNumber} codePrefix={card.codePrefix ?? card.players[0]?.id.match(/^[A-Za-z]+/)?.[0] ?? "P"} slots={slots} players={playerMap} maxDiff={maxDiff} storageKey={`${id}:${gameNumber}`} onSubmit={saveResult} onPenalty={isDirector ? openPenalty : undefined} onRevokePenalty={isDirector ? withdrawPenalty : undefined} onForceBye={isDirector && isDestination ? openBye : undefined} pairingEdit={pairingEdit} />
          </section>;
        })}
      </> : (
        <>{activeGames.map((gameNumber) => {
          return <section className="panel director-grid-panel" key={gameNumber} aria-label="ตรวจผลการแข่งขัน">
            {pairResultBlock && <div className="panel-head"><h2>เกม {gameNumber}</h2></div>}
            <ResultViewGrid pairings={pairingsForGame(gameNumber)} players={playerMap} />
          </section>;
        })}</>
      )}
      <PromptDialog appearance="prototype" open={unpairOpen} title="ยืนยัน Unpairing" label="รหัสผ่านผู้อำนวยการ" type="password"
        description="ระบบจะยกเลิกคู่ปัจจุบันและกลับไปหน้าสร้างคู่แข่งขัน" danger busy={busy} error={actionError}
        confirmLabel="ยืนยัน Unpairing" onSubmit={onUnpairing} onCancel={() => setUnpairOpen(false)} />
      <PromptDialog appearance="prototype" open={Boolean(publicationHolds)} title={`มีผู้เล่นค้างในถังคัดชั่วคราว ${publicationHolds?.length ?? 0} คน`}
        label="รหัสผ่านผู้อำนวยการ" type="password" busy={busy} danger error={actionError}
        description="ถอนผู้เล่นเหล่านี้เพื่อกลับมาตรวจและเผยแพร่ผลการแข่งขัน" confirmLabel="ถอนผู้เล่นออก"
        onSubmit={resolvePublicationHolds} onCancel={() => setPublicationHolds(undefined)}>
        <ul className="publication-hold-list">{publicationHolds?.map((code) => {
          const player = playerMap.get(code);
          return <li key={code}><b className="code">{code}</b> {player?.firstName} {player?.lastName}</li>;
        })}</ul>
      </PromptDialog>
      <PromptDialog
        appearance="prototype"
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

      <ConfirmDialog appearance="prototype" open={Boolean(byeMatch)}
        title={`ให้บาย · เกม ${byeMatch?.gameNumber ?? ""} คู่ ${byeMatch?.tableNumber ?? ""}`}
        description={`${byeMatch?.playerOneId ?? byeMatch?.playerTwoId ?? ""} จะชนะบาย ผู้เล่นที่เข้ามาทีหลังจะรอจัดคู่แยก`}
        confirmLabel="ยืนยันและบันทึกผลบาย" busy={byeBusy} error={byeError || undefined}
        onConfirm={() => void submitBye()} onCancel={() => { if (!byeBusy) { setByeMatch(undefined); setByePassword(""); } }}>
        <label className="form-label" htmlFor="force-bye-score">คะแนนผู้เล่น</label>
        <input className="input" id="force-bye-score" type="number" min={1} max={1500} value={byeScore}
          onChange={(event) => setByeScore(event.target.value)} />
        <label className="form-label" htmlFor="force-bye-password">รหัสผ่านผู้อำนวยการ</label>
        <FreshSecretInput className="input" id="force-bye-password" value={byePassword}
          onChange={(event) => setByePassword(event.target.value)} />
      </ConfirmDialog>

      <ConfirmDialog
        appearance="prototype"
        open={penaltyMatch !== null}
        eyebrow="ลงดาบ"
        icon={<PenaltySword size={20} />}
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
    </div>
  );
}
