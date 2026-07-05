"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole, RefreshCw, Shuffle, Undo2 } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { canManageTournament } from "@/domain/tournament/roles";
import type { Pairing, Player } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { pairingRuleForGame } from "@/ui/components/game-flow";
import { CustomCombobox } from "@/ui/components/institution-combobox";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { PairingGrid, RankingGrid } from "@/ui/components/standings-grids";

export default function TablesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const generatePairings = useTournamentStore((state) => state.generatePairings);
  const confirmPairing = useTournamentStore((state) => state.confirmPairingPreview);
  const swapPlayers = useTournamentStore((state) => state.swapPlayers);
  const verifyPassword = useTournamentStore((state) => state.verifyPassword);
  const undoPairing = useTournamentStore((state) => state.undoPairing);
  const card = selectCard(cards, id);
  const [firstId, setFirstId] = useState("");
  const [secondId, setSecondId] = useState("");
  const [pairingPassword, setPairingPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [browseGame, setBrowseGame] = useState<number | null>(null);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  // Pairing/tables is the director's work. Result-entry staff enter results on the games page;
  // admins and public viewers only watch the overview.
  if (!canManageTournament(auth)) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับผู้อำนวยการเท่านั้น" description="การจับคู่และโต๊ะแข่งขันเป็นงานของผู้อำนวยการ เจ้าหน้าที่กรอกผลทำงานที่หน้าผลการแข่งขัน" action={<Link href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
  if (!card) return <CardNotFound />;

  const players = new Map(card.players.map((player) => [player.id, player]));
  const playerOptions = card.players.map((player) => ({
    value: player.id,
    label: `${player.id} · ${player.firstName} ${player.lastName}`,
    detail: player.school,
  }));
  const canGenerate = card.runtimeStage === "TABLE_PAIRING";
  const preview = card.runtimeStage === "PAIRING_PREVIEW";
  const manualGameOne = preview && card.currentGame === 1;
  const currentSnapshot = card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.includes(card.currentGame));
  const currentPairings = currentSnapshot?.pairings.filter((pairing) => pairing.gameNumber === card.currentGame) ?? [];
  const gameOnePairs: Pairing[] = manualGameOne
    ? card.tables
        .flatMap((table) => { const pairs: { one: string; two: string }[] = []; for (let i = 0; i + 1 < table.playerIds.length; i += 2) pairs.push({ one: table.playerIds[i], two: table.playerIds[i + 1] }); return pairs; })
        .map((pair, index) => ({ id: `g1-${index + 1}`, gameNumber: 1, tableNumber: index + 1, playerOneId: pair.one, playerTwoId: pair.two }))
    : [];
  const previewPairings = manualGameOne ? gameOnePairs : currentPairings;
  const publishedSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const latestResultGame = Math.max(0, ...publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const latestResultSnapshot = publishedSnapshots.find((snapshot) => snapshot.gameNumbers.includes(latestResultGame));
  const latestRanking = latestResultGame > 0 ? rankingAfterGame({ ...card, snapshots: publishedSnapshots }, latestResultGame) : [];
  const pairingActive = canGenerate || preview;
  const browseGames = [...new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers))].sort((a, b) => a - b);
  const selectedBrowseGame = browseGame && browseGames.includes(browseGame) ? browseGame : (browseGames[browseGames.length - 1] ?? 0);
  const browseSnapshot = publishedSnapshots.find((snapshot) => snapshot.gameNumbers.includes(selectedBrowseGame));
  const browsePairings = browseSnapshot?.pairings.filter((pairing) => (pairing.gameNumber ?? selectedBrowseGame) === selectedBrowseGame) ?? [];

  const generate = async () => {
    setBusy(true);
    try { await generatePairings(id); }
    catch (error) { window.alert(error instanceof Error ? error.message : "สร้าง pairing ไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const swap = async () => {
    if (!firstId || !secondId || firstId === secondId) return window.alert("เลือกรหัสผู้เล่น 2 คนที่ต่างกัน");
    if (!pairingPassword) return window.alert("กรอกรหัสผ่านเพื่อยืนยันการแก้ไข pairing");
    setBusy(true);
    try {
      if (!await verifyPassword(pairingPassword)) {
        window.alert("รหัสผ่านไม่ถูกต้อง");
        return;
      }
      await swapPlayers(id, firstId, secondId, pairingPassword, false);
      setFirstId(""); setSecondId(""); setPairingPassword("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ";
      if (message.includes("SCHOOL_CONFLICT") && window.confirm(`${message.replace("SCHOOL_CONFLICT: ", "")}\n\nยืนยันสลับต่อหรือไม่?`)) {
        await swapPlayers(id, firstId, secondId, pairingPassword, true);
        setFirstId(""); setSecondId(""); setPairingPassword("");
      } else if (!message.includes("SCHOOL_CONFLICT")) window.alert(message);
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!window.confirm(`ยืนยัน pairing เกม ${card.currentGame}? หลังจากนี้${card.currentGame === 1 ? "จะสลับโต๊ะไม่ได้และ" : ""}จะเข้าสู่การกรอกผล`)) return;
    setBusy(true);
    try { await confirmPairing(id); router.push(`/cards/${id}/games`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "ยืนยัน pairing ไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!window.confirm(`ลบ Pairing preview เกม ${card.currentGame} และกลับไปสร้าง Pairing เกมนี้ใหม่? ผลและ Ranking ของเกมก่อนหน้าจะไม่เปลี่ยนแปลง`)) return;
    const password = window.prompt("กรอกรหัสผ่านผู้อำนวยการเพื่อยืนยันการยกเลิกการจับคู่");
    if (!password) return;
    setBusy(true);
    try { await undoPairing(id, password); }
    catch (error) { window.alert(error instanceof Error ? error.message : "ยกเลิกการจับคู่ไม่สำเร็จ"); }
    finally { setBusy(false); }
  };
  const canUndo = canManageTournament(auth) && preview;

  return (
    <>
      <PageHeader eyebrow={`${card.name} · ${card.runtimeStage}`} title={`โต๊ะแข่งขัน · เกม ${card.currentGame}`} description={`${pairingRuleForGame(card, card.currentGame)} · ปรับ/สลับคู่ผู้เล่นได้ก่อนยืนยัน`} actions={<>{canUndo && <Button variant="secondary" onClick={undo} disabled={busy}><Undo2 size={16} />Un-pairing</Button>}{canGenerate ? <Button onClick={generate} disabled={busy}><Shuffle size={16} />Pairing เกม {card.currentGame}</Button> : preview ? <Button variant="success" onClick={confirm} disabled={busy || previewPairings.length === 0}>Finish pairing <ArrowRight size={16} /></Button> : <Link href={`/cards/${id}/games`}><Button>ไปหน้าผลการแข่งขัน <ArrowRight size={16} /></Button></Link>}</>} />

      {!pairingActive ? (
        browseGames.length === 0 ? (
          <Panel><EmptyState icon={<Shuffle size={25} />} title="ยังไม่มีเกมที่เผยแพร่" description="Pairing และอันดับแต่ละเกมจะปรากฏที่นี่หลังเจ้าหน้าที่ Publish ผล" /></Panel>
        ) : (
          <Panel
            title={`Pairing เกม ${selectedBrowseGame}`}
            description="เลือกเกมเพื่อดูคู่แข่งขันที่เผยแพร่แล้ว"
            actions={
              <div className="overview-game-select">
                <label htmlFor="tables-browse-game">เลือกเกม</label>
                <select id="tables-browse-game" className="select" value={selectedBrowseGame} onChange={(event) => setBrowseGame(Number(event.target.value))}>{browseGames.map((game) => <option key={game} value={game}>เกม {game}</option>)}</select>
              </div>
            }
          >
            <PairingGrid pairings={browsePairings} players={players} storageKey={`${id}:tables:browse-pairing`} resetKey={String(selectedBrowseGame)} />
          </Panel>
        )
      ) : (
        <>
      {canGenerate && <Panel><EmptyState icon={<Shuffle size={25} />} title={`พร้อมสร้าง pairing เกม ${card.currentGame}`} description={card.currentGame === 1 ? "ระบบจะจัดกลุ่ม 4 คนต่อโต๊ะและลดการพบผู้เล่นโรงเรียนเดียวกัน" : `ใช้กติกา ${pairingRuleForGame(card, card.currentGame)} จากผลที่ publish แล้ว`} action={<Button onClick={generate} disabled={busy}><Shuffle size={16} />เริ่ม Pairing</Button>} /></Panel>}

      {preview && (
        <>
          <Panel title="สลับ/ปรับคู่ผู้เล่น" description="เลือกผู้เล่นสองคนเพื่อสลับตำแหน่งกัน · ปรับได้ทุกเกมก่อนยืนยัน ระบบจะเตือนหากทำให้โรงเรียนเดียวกันแข่งกัน">
            <div className="panel-padding swap-controls">
              <div className="form-field">
                <label className="form-label" htmlFor="swap-first">ผู้เล่นคนที่ 1</label>
                <CustomCombobox id="swap-first" value={firstId} onChange={(value) => setFirstId(value.toUpperCase())} options={playerOptions.filter((option) => option.value !== secondId)} disabled={busy} placeholder="ค้นหารหัส ชื่อ หรือสถาบัน" caption="เลือกผู้เล่นคนที่ 1" emptyMessage="ไม่พบผู้เล่น" listLabel="รายชื่อผู้เล่นคนที่ 1" openButtonLabel="เปิดรายชื่อผู้เล่นคนที่ 1" closeButtonLabel="ปิดรายชื่อผู้เล่นคนที่ 1" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="swap-second">ผู้เล่นคนที่ 2</label>
                <CustomCombobox id="swap-second" value={secondId} onChange={(value) => setSecondId(value.toUpperCase())} options={playerOptions.filter((option) => option.value !== firstId)} disabled={busy} placeholder="ค้นหารหัส ชื่อ หรือสถาบัน" caption="เลือกผู้เล่นคนที่ 2" emptyMessage="ไม่พบผู้เล่น" listLabel="รายชื่อผู้เล่นคนที่ 2" openButtonLabel="เปิดรายชื่อผู้เล่นคนที่ 2" closeButtonLabel="ปิดรายชื่อผู้เล่นคนที่ 2" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="pairing-password">รหัสผ่านยืนยัน</label>
                <input id="pairing-password" className="input" type="password" autoComplete="current-password" value={pairingPassword} onChange={(event) => setPairingPassword(event.target.value)} placeholder="รหัสผ่านบัญชีของคุณ" disabled={busy} />
              </div>
              <Button onClick={swap} disabled={busy || !players.has(firstId) || !players.has(secondId) || !pairingPassword}><RefreshCw size={16} />ยืนยันการสลับ</Button>
            </div>
          </Panel>

          <Panel title={`Pairing preview · ${previewPairings.length} คู่`} description="คู่แข่งขันของเกมนี้ก่อนยืนยัน · เลขที่นั่งนับจากบนลงล่าง (คู่ 1 = ที่นั่ง 1,2)">
            <PairingGrid pairings={previewPairings} players={players} storageKey={`${id}:tables:preview`} />
          </Panel>
        </>
      )}

      {latestResultGame > 0 && (
        <Panel title={`อันดับล่าสุด · หลังจบเกม ${latestResultGame}`} description={`คะแนนชัยชนะและผลต่างสะสม${latestResultSnapshot?.confirmedAt ? ` · เผยแพร่เมื่อ ${new Date(latestResultSnapshot.confirmedAt).toLocaleString("th-TH")}` : ""}`}>
          <RankingGrid ranked={latestRanking} storageKey={`${id}:tables:latest-ranking`} resetKey={String(latestResultGame)} />
        </Panel>
      )}
        </>
      )}
    </>
  );
}
