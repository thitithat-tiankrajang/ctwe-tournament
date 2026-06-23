"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Filter, LockKeyhole, RefreshCw, Shuffle, TableProperties } from "lucide-react";
import { useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import type { Pairing, Player, SeatingTable } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { GameFlow, pairingRuleForGame } from "@/ui/components/game-flow";
import { CustomCombobox } from "@/ui/components/institution-combobox";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

function containsPlayer(table: SeatingTable, players: Map<string, Player>, query: string) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return table.playerIds.some((id) => {
    const player = players.get(id);
    return `${id} ${player?.firstName} ${player?.lastName} ${player?.school}`.toLowerCase().includes(needle);
  });
}

function sameSchoolPair(table: SeatingTable, players: Map<string, Player>, seatIndex: number) {
  const opponentIndex = seatIndex % 2 === 0 ? seatIndex + 1 : seatIndex - 1;
  const player = players.get(table.playerIds[seatIndex]);
  const opponent = players.get(table.playerIds[opponentIndex]);
  return Boolean(player && opponent && player.school.toLowerCase() === opponent.school.toLowerCase());
}

export default function TablesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const generatePairings = useTournamentStore((state) => state.generatePairings);
  const confirmPairing = useTournamentStore((state) => state.confirmPairingPreview);
  const swapPlayers = useTournamentStore((state) => state.swapPlayers);
  const card = selectCard(cards, id);
  const [query, setQuery] = useState("");
  const [firstId, setFirstId] = useState("");
  const [secondId, setSecondId] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyGame, setHistoryGame] = useState<number | null>(null);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  if (!isStaff) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="ข้อมูล pairing ที่ยังไม่ publish เป็นข้อมูลภายใน" action={<Link href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
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
  const filteredTables = card.tables.filter((table) => containsPlayer(table, players, query));
  const filteredPairings = currentPairings.filter((pairing) => {
    if (!query) return true;
    const needle = query.toLowerCase();
    return [pairing.playerOneId, pairing.playerTwoId].some((playerId) => {
      const player = players.get(playerId);
      return `${playerId} ${player?.firstName} ${player?.lastName} ${player?.school}`.toLowerCase().includes(needle);
    });
  });
  const physicalTables = Array.from({ length: Math.ceil(filteredPairings.length / 2) }, (_, index) => filteredPairings.slice(index * 2, index * 2 + 2));
  const retainCurrentPairing = card.runtimeStage === "RESULT_COLLECTION" || card.runtimeStage === "RESULT_REVIEW";
  const pairingSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt) || (retainCurrentPairing && snapshot.gameNumbers.includes(card.currentGame)));
  const latestArchivedGame = Math.max(0, ...pairingSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const selectedHistoryGame = historyGame && pairingSnapshots.some((snapshot) => snapshot.gameNumbers.includes(historyGame)) ? historyGame : latestArchivedGame;
  const historySnapshot = pairingSnapshots.find((snapshot) => snapshot.gameNumbers.includes(selectedHistoryGame));
  const historyPairings = historySnapshot?.pairings.filter((pairing) => pairing.gameNumber === selectedHistoryGame) ?? [];
  const archiveCard = { ...card, snapshots: pairingSnapshots };

  const generate = async () => {
    setBusy(true);
    try { await generatePairings(id); }
    catch (error) { window.alert(error instanceof Error ? error.message : "สร้าง pairing ไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const swap = async () => {
    if (!firstId || !secondId || firstId === secondId) return window.alert("เลือกรหัสผู้เล่น 2 คนที่ต่างกัน");
    setBusy(true);
    try {
      await swapPlayers(id, firstId, secondId, false);
      setFirstId(""); setSecondId("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ";
      if (message.includes("SCHOOL_CONFLICT") && window.confirm(`${message.replace("SCHOOL_CONFLICT: ", "")}\n\nยืนยันสลับต่อหรือไม่?`)) {
        await swapPlayers(id, firstId, secondId, true);
        setFirstId(""); setSecondId("");
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

  return (
    <>
      <PageHeader eyebrow={`${card.name} · ${card.runtimeStage}`} title={`โต๊ะแข่งขัน · เกม ${card.currentGame}`} description={`${pairingRuleForGame(card, card.currentGame)} · ${card.currentGame === 1 ? "เกมแรกปรับตำแหน่งผู้เล่นได้ก่อนยืนยัน" : "ระบบจับคู่ตามกติกาของการ์ดและไม่อนุญาตให้สลับเอง"}`} actions={canGenerate ? <Button onClick={generate} disabled={busy}><Shuffle size={16} />Pairing เกม {card.currentGame}</Button> : preview ? <Button variant="success" onClick={confirm} disabled={busy || (manualGameOne ? card.tables.length === 0 : currentPairings.length === 0)}>Finish pairing <ArrowRight size={16} /></Button> : <Link href={`/cards/${id}/games`}><Button>ไปหน้าผลการแข่งขัน <ArrowRight size={16} /></Button></Link>} />

      {canGenerate && <Panel><EmptyState icon={<Shuffle size={25} />} title={`พร้อมสร้าง pairing เกม ${card.currentGame}`} description={card.currentGame === 1 ? "ระบบจะจัดกลุ่ม 4 คนต่อโต๊ะและลดการพบผู้เล่นโรงเรียนเดียวกัน" : `ใช้กติกา ${pairingRuleForGame(card, card.currentGame)} จากผลที่ publish แล้ว`} action={<Button onClick={generate} disabled={busy}><Shuffle size={16} />เริ่ม Pairing</Button>} /></Panel>}

      {preview && (
        <>
          <section className="player-filter-bar" style={{ gridTemplateColumns: "minmax(240px, 1fr) auto" }}><div className="compact-field"><label htmlFor="table-filter">ค้นหาโต๊ะด้วยรหัส ชื่อ หรือโรงเรียน</label><input id="table-filter" placeholder="เช่น P0042" value={query} onChange={(event) => setQuery(event.target.value)} /></div><Button variant="secondary" size="sm" onClick={() => setQuery("")}><Filter size={14} />ล้าง filter</Button></section>

          {manualGameOne && (
            <Panel title="สลับตำแหน่งผู้เล่น" description="เลือกผู้เล่นสองคนเพื่อสลับที่นั่ง ระบบจะเตือนหากทำให้โรงเรียนเดียวกันแข่งกัน">
              <div className="panel-padding swap-controls">
                <div className="form-field">
                  <label className="form-label" htmlFor="swap-first">ผู้เล่นคนที่ 1</label>
                  <CustomCombobox id="swap-first" value={firstId} onChange={(value) => setFirstId(value.toUpperCase())} options={playerOptions.filter((option) => option.value !== secondId)} disabled={busy} placeholder="ค้นหารหัส ชื่อ หรือสถาบัน" caption="เลือกผู้เล่นคนที่ 1" emptyMessage="ไม่พบผู้เล่น" listLabel="รายชื่อผู้เล่นคนที่ 1" openButtonLabel="เปิดรายชื่อผู้เล่นคนที่ 1" closeButtonLabel="ปิดรายชื่อผู้เล่นคนที่ 1" />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="swap-second">ผู้เล่นคนที่ 2</label>
                  <CustomCombobox id="swap-second" value={secondId} onChange={(value) => setSecondId(value.toUpperCase())} options={playerOptions.filter((option) => option.value !== firstId)} disabled={busy} placeholder="ค้นหารหัส ชื่อ หรือสถาบัน" caption="เลือกผู้เล่นคนที่ 2" emptyMessage="ไม่พบผู้เล่น" listLabel="รายชื่อผู้เล่นคนที่ 2" openButtonLabel="เปิดรายชื่อผู้เล่นคนที่ 2" closeButtonLabel="ปิดรายชื่อผู้เล่นคนที่ 2" />
                </div>
                <Button onClick={swap} disabled={busy || !players.has(firstId) || !players.has(secondId)}><RefreshCw size={16} />สลับที่</Button>
              </div>
            </Panel>
          )}

          {manualGameOne ? (
            <Panel title={`Pairing preview · ${filteredTables.length} จาก ${card.tables.length} โต๊ะ`} description="คู่แข่งขันคือที่นั่ง 1–2 และ 3–4 ภายในโต๊ะเดียวกัน">
              <div className="pairing-table-grid">{filteredTables.map((table) => <section className="physical-table" key={table.id}><header><strong>โต๊ะ {table.number}</strong><span>{table.playerIds.length} คน</span></header>{table.playerIds.map((playerId, index) => { const player = players.get(playerId); const conflict = sameSchoolPair(table, players, index); return <div className={`physical-player ${conflict ? "school-conflict" : ""}`} key={playerId}><span className="physical-player__position">{index + 1}</span><div><strong>{player?.firstName} {player?.lastName}</strong><small>{playerId} · {player?.school}</small></div>{conflict && <Badge tone="warning"><AlertTriangle size={12} />โรงเรียนซ้ำ</Badge>}</div>; })}</section>)}</div>
            </Panel>
          ) : (
            <Panel title={`System pairing preview · ${filteredPairings.length} คู่`} description="ดูได้อย่างเดียว การสลับด้วยมือถูกปิดตั้งแต่เกม 2">
              {physicalTables.length === 0 ? <EmptyState icon={<TableProperties size={24} />} title="ไม่พบ pairing" description="ลองล้างตัวกรอง" /> : <div className="pairing-table-grid">{physicalTables.map((matches, tableIndex) => <section className="physical-table" key={tableIndex}><header><strong>โต๊ะ {tableIndex + 1}</strong><span>{matches.length} คู่</span></header>{matches.map((pairing: Pairing) => <div className="physical-match" key={pairing.id}><span className="physical-match__label">คู่ {pairing.tableNumber}</span>{[pairing.playerOneId, pairing.playerTwoId].map((playerId, playerIndex) => { const player = players.get(playerId); return <div className="physical-player" key={playerId}><span className="physical-player__position">{playerIndex + 1}</span><div><strong>{player?.firstName} {player?.lastName}</strong><small>{playerId} · {player?.school}</small></div></div>; })}</div>)}</section>)}</div>}
            </Panel>
          )}
        </>
      )}

      {pairingSnapshots.length > 0 && (
        <Panel title="Pairing ที่บันทึกไว้ตามเกม" description="หลัง Finish pairing รายการคู่จะยังอยู่ในหน้านี้ทั้งระหว่างกรอกผลและหลัง Publish">
          <div className="panel-padding archive-game-flow"><GameFlow card={archiveCard} selectedGame={selectedHistoryGame} onSelect={setHistoryGame} mode="pairing" /></div>
          <div className="archive-rule-summary"><strong>เกม {selectedHistoryGame} · {pairingRuleForGame(card, selectedHistoryGame)}</strong><span>{historySnapshot?.confirmedAt ? `Publish เมื่อ ${new Date(historySnapshot.confirmedAt).toLocaleString("th-TH")}` : "Finish pairing แล้ว · รอ Publish ผล"}</span></div>
          <div className="dense-table-wrap archive-table-wrap"><table className="data-table archive-pairing-table"><thead><tr><th className="numeric">คู่</th><th>ผู้เล่น 1</th><th>ผู้เล่น 2</th><th>สถานะ</th></tr></thead><tbody>{historyPairings.map((pairing) => { const one = players.get(pairing.playerOneId); const two = players.get(pairing.playerTwoId); const winner = players.get(pairing.winnerId ?? ""); const recorded = pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined; return <tr key={pairing.id}><td className="numeric">{pairing.tableNumber}</td><td><strong>{one?.firstName} {one?.lastName}</strong><small className="table-subline">{one?.id} · {one?.school}</small></td><td><strong>{two?.firstName} {two?.lastName}</strong><small className="table-subline">{two?.id} · {two?.school}</small></td><td>{!recorded ? <Badge tone="info">ยืนยัน Pairing แล้ว</Badge> : pairing.resultType === "DRAW" ? <Badge tone="warning">เสมอ {pairing.scoreOne}-{pairing.scoreTwo}</Badge> : <Badge tone="success">{winner?.id} ชนะ {pairing.scoreOne}-{pairing.scoreTwo}</Badge>}</td></tr>; })}</tbody></table></div>
        </Panel>
      )}
    </>
  );
}
