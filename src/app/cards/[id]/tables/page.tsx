"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole, RefreshCw, Shuffle, Sparkles, Undo2 } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { canManageTournament } from "@/domain/tournament/roles";
import type { Pairing, Player } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { pairingRuleForGame } from "@/ui/components/game-flow";
import { CustomCombobox } from "@/ui/components/institution-combobox";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
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
  if (!canManageTournament(auth)) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับผู้อำนวยการเท่านั้น" description="การจับคู่และโต๊ะแข่งขันเป็นงานของผู้อำนวยการ เจ้าหน้าที่กรอกผลทำงานที่หน้าผลการแข่งขัน" action={<Link prefetch={false} href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
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
        .flatMap((table) => {
          const pairs: { one: string; two: string | null }[] = [];
          for (let i = 0; i < table.playerIds.length; i += 2)
            pairs.push({ one: table.playerIds[i], two: table.playerIds[i + 1] ?? null });
          return pairs;
        })
        .map((pair, index) => ({ id: `g1-${index + 1}`, gameNumber: 1, tableNumber: index + 1, playerOneId: pair.one, playerTwoId: pair.two }))
    : [];
  const previewPairings = manualGameOne ? gameOnePairs : currentPairings;
  const gibsonPairings = previewPairings.filter((pairing) =>
    pairing.playerOneGibsonized || pairing.playerTwoGibsonized);
  const gibsonPlayerIds = [...new Set(gibsonPairings.flatMap((pairing) => [
    pairing.playerOneGibsonized ? pairing.playerOneId : null,
    pairing.playerTwoGibsonized ? pairing.playerTwoId : null,
  ]).filter((playerId): playerId is string => Boolean(playerId)))];
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
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "สร้าง pairing ไม่สำเร็จ", "สร้าง Pairing ไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };

  const swap = async () => {
    if (!firstId || !secondId || firstId === secondId) {
      await appDialog.alert("เลือกรหัสผู้เล่น 2 คนที่ต่างกัน");
      return;
    }
    if (!pairingPassword) {
      await appDialog.alert("กรอกรหัสผ่านเพื่อยืนยันการแก้ไข pairing");
      return;
    }
    setBusy(true);
    try {
      if (!await verifyPassword(pairingPassword)) {
        await appDialog.alert("รหัสผ่านไม่ถูกต้อง", "ยืนยันตัวตนไม่สำเร็จ", true);
        return;
      }
      await swapPlayers(id, firstId, secondId, pairingPassword, false);
      setFirstId(""); setSecondId(""); setPairingPassword("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ";
      if (message.includes("SCHOOL_CONFLICT") && await appDialog.confirm(message.replace("SCHOOL_CONFLICT: ", ""), {
        title: "พบผู้เล่นสถาบันเดียวกัน",
        confirmLabel: "ยืนยันการสลับ",
      })) {
        try {
          await swapPlayers(id, firstId, secondId, pairingPassword, true);
          setFirstId(""); setSecondId(""); setPairingPassword("");
        } catch (retry) {
          await appDialog.alert(retry instanceof Error ? retry.message : "สลับผู้เล่นไม่สำเร็จ", "สลับผู้เล่นไม่สำเร็จ", true);
        }
      } else if (!message.includes("SCHOOL_CONFLICT")) {
        await appDialog.alert(message, "สลับผู้เล่นไม่สำเร็จ", true);
      }
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!await appDialog.confirm(`ยืนยัน pairing เกม ${card.currentGame}? หลังจากนี้${card.currentGame === 1 ? "จะสลับโต๊ะไม่ได้และ" : ""}จะเข้าสู่การกรอกผล`, {
      title: `ยืนยัน Pairing เกม ${card.currentGame}`,
      confirmLabel: "Finish pairing",
    })) return;
    setBusy(true);
    try { await confirmPairing(id); router.push(`/cards/${id}/games`); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "ยืนยัน pairing ไม่สำเร็จ", "ยืนยัน Pairing ไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!await appDialog.confirm(`ลบ Pairing preview เกม ${card.currentGame} และกลับไปสร้าง Pairing เกมนี้ใหม่? ผลและ Ranking ของเกมก่อนหน้าจะไม่เปลี่ยนแปลง`, {
      title: "สร้าง Pairing ใหม่",
      confirmLabel: "ดำเนินการต่อ",
      danger: true,
    })) return;
    const password = await appDialog.prompt("กรอกรหัสผ่านผู้อำนวยการเพื่อยืนยันการยกเลิกการจับคู่", {
      title: "ยืนยัน Un-pairing",
      label: "รหัสผ่านผู้อำนวยการ",
      type: "password",
      confirmLabel: "Un-pairing",
    });
    if (!password) return;
    setBusy(true);
    try { await undoPairing(id, password); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "ยกเลิกการจับคู่ไม่สำเร็จ", "Un-pairing ไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };
  const canUndo = canManageTournament(auth) && preview;
  const scrollToFirstGibsonPair = () => {
    const first = gibsonPairings[0];
    if (!first) return;
    const row = document.getElementById(`gibson-pair-${id}-${first.id}`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (row) {
      row.classList.remove("egrid-row--gibson-focus");
      void row.offsetWidth;
      row.classList.add("egrid-row--gibson-focus");
      window.setTimeout(() => row.classList.remove("egrid-row--gibson-focus"), 1600);
    }
  };

  return (
    <>
      <PageHeader eyebrow={`${card.name} · ${card.runtimeStage}`} title={`โต๊ะแข่งขัน · เกม ${card.currentGame}`} description={`${pairingRuleForGame(card, card.currentGame)} · ปรับ/สลับคู่ผู้เล่นได้ก่อนยืนยัน`} actions={<>{canUndo && <Button variant="secondary" onClick={undo} disabled={busy}><Undo2 size={16} />Un-pairing</Button>}{canGenerate ? <Button onClick={generate} disabled={busy}><Shuffle size={16} />Pairing เกม {card.currentGame}</Button> : preview ? <Button variant="success" onClick={confirm} disabled={busy || previewPairings.length === 0}>Finish pairing <ArrowRight size={16} /></Button> : <Link prefetch={false} href={`/cards/${id}/games`}><Button>ไปหน้าผลการแข่งขัน <ArrowRight size={16} /></Button></Link>}</>} />

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
          {gibsonPairings.length > 0 && (
            <button type="button" className="notice notice--warning gibson-notice" onClick={scrollToFirstGibsonPair}>
              <Sparkles size={19} />
              <p>
                <strong>มีผู้เล่น Gibsonized {gibsonPlayerIds.length} คนใน Pairing นี้</strong>
                <span>{gibsonPlayerIds.join(", ")} ถูกจัดไว้ในคู่ท้ายสุดและทำเครื่องหมายสีเหลือง · กดเพื่อไปยังคู่ดังกล่าว</span>
              </p>
              <ArrowRight size={17} />
            </button>
          )}
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
                <FreshSecretInput id="pairing-password" className="input" value={pairingPassword} onChange={(event) => setPairingPassword(event.target.value)} placeholder="รหัสผ่านบัญชีของคุณ" disabled={busy} />
              </div>
              <Button onClick={swap} disabled={busy || !players.has(firstId) || !players.has(secondId) || !pairingPassword}><RefreshCw size={16} />ยืนยันการสลับ</Button>
            </div>
          </Panel>

          <Panel title={`Pairing preview · ${previewPairings.length} คู่`} description="คู่แข่งขันของเกมนี้ก่อนยืนยัน · เลขที่นั่งนับจากบนลงล่าง (คู่ 1 = ที่นั่ง 1,2) · ผู้เล่น Gibsonized แสดงด้วยสีเหลือง">
            <PairingGrid pairings={previewPairings} players={players} storageKey={`${id}:tables:preview`} rowIdPrefix={`gibson-pair-${id}`} />
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
