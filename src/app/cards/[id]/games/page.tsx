"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Calculator, Check, Edit3, Eye, Gamepad2, LoaderCircle, LockKeyhole, Save, Search, ToggleRight, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { GameFlow, pairingRuleForGame } from "@/ui/components/game-flow";
import { CustomCombobox } from "@/ui/components/institution-combobox";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

interface CalculatedOutcome {
  resultType: "WIN" | "DRAW";
  winnerId?: string;
  calculatedDiff: number;
}

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

function calculateOutcome(scoreOne: string, scoreTwo: string, maxDiff: number, playerOneId: string, playerTwoId: string): CalculatedOutcome | null {
  if (scoreOne.trim() === "" || scoreTwo.trim() === "") return null;
  const one = Number(scoreOne); const two = Number(scoreTwo);
  if (!Number.isInteger(one) || !Number.isInteger(two) || one < 0 || two < 0 || one > 1_000_000_000 || two > 1_000_000_000) return null;
  if (one === two) return { resultType: "DRAW", calculatedDiff: 0 };
  return { resultType: "WIN", winnerId: one > two ? playerOneId : playerTwoId, calculatedDiff: Math.min(Math.abs(one - two), maxDiff) };
}

function outcomeLabel(outcome: CalculatedOutcome | null, players: Map<string, Player>) {
  if (!outcome) return "รอคะแนนครบ";
  if (outcome.resultType === "DRAW") return "เสมอ · +1 WP ทั้งคู่ · Diff 0";
  const winner = players.get(outcome.winnerId ?? "");
  return `${winner?.id ?? "—"} ชนะ · +2 WP · Diff ±${outcome.calculatedDiff}`;
}

function ResultRow({ pairing, players, maxDiff, onSubmit }: {
  pairing: Pairing;
  players: Map<string, Player>;
  maxDiff: number;
  onSubmit: (scoreOne: number, scoreTwo: number, editExisting: boolean) => Promise<void>;
}) {
  const one = players.get(pairing.playerOneId); const two = players.get(pairing.playerTwoId);
  const saved = isRecorded(pairing);
  const [scoreOne, setScoreOne] = useState(pairing.scoreOne?.toString() ?? "");
  const [scoreTwo, setScoreTwo] = useState(pairing.scoreTwo?.toString() ?? "");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const outcome = calculateOutcome(scoreOne, scoreTwo, maxDiff, pairing.playerOneId, pairing.playerTwoId);

  useEffect(() => {
    if (enabled) return;
    setScoreOne(pairing.scoreOne?.toString() ?? "");
    setScoreTwo(pairing.scoreTwo?.toString() ?? "");
  }, [enabled, pairing.scoreOne, pairing.scoreTwo]);

  const save = async () => {
    if (!outcome) return;
    setSaving(true);
    try {
      await onSubmit(Number(scoreOne), Number(scoreTwo), saved);
      setEnabled(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "บันทึกผลไม่สำเร็จ");
    } finally { setSaving(false); }
  };

  return (
    <div className={`result-entry-row${enabled ? " result-entry-row--enabled" : ""}`}>
      <div className="result-entry-match"><strong>คู่ {pairing.tableNumber}</strong><small>Max {maxDiff}</small></div>
      <div className="result-entry-player"><b>{one?.id}</b><strong>{one?.firstName} {one?.lastName}</strong><small>{one?.school}</small></div>
      <input aria-label={`คะแนน ${one?.id}`} className="result-score-input" type="number" min={0} max={1_000_000_000} value={scoreOne} disabled={!enabled || saving} onChange={(event) => setScoreOne(event.target.value)} />
      <div className={`result-calculation result-calculation--${outcome?.resultType?.toLowerCase() ?? "pending"}`}><Calculator size={15} /><span>{outcomeLabel(outcome, players)}</span></div>
      <input aria-label={`คะแนน ${two?.id}`} className="result-score-input" type="number" min={0} max={1_000_000_000} value={scoreTwo} disabled={!enabled || saving} onChange={(event) => setScoreTwo(event.target.value)} />
      <div className="result-entry-player result-entry-player--right"><b>{two?.id}</b><strong>{two?.firstName} {two?.lastName}</strong><small>{two?.school}</small></div>
      <div className="result-entry-actions">
        {saved && !enabled && <Badge tone="success">บันทึกแล้ว</Badge>}
        {enabled ? <Button size="sm" variant="success" disabled={saving || !outcome} onClick={() => void save()}>{saving ? <LoaderCircle className="loading-spinner" size={14} /> : <Save size={14} />}บันทึก</Button>
          : <Button size="sm" variant="secondary" onClick={() => setEnabled(true)}>{saved ? <Edit3 size={14} /> : <ToggleRight size={14} />}{saved ? "Edit" : "Enable"}</Button>}
      </div>
    </div>
  );
}

function QuickResultForm({ pairings, players, maxDiff, onSubmit }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  maxDiff: number;
  onSubmit: (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => Promise<void>;
}) {
  const [firstId, setFirstId] = useState(""); const [secondId, setSecondId] = useState("");
  const [firstScore, setFirstScore] = useState(""); const [secondScore, setSecondScore] = useState("");
  const [enabled, setEnabled] = useState(false); const [saving, setSaving] = useState(false);
  const first = players.get(firstId); const second = players.get(secondId);
  const pairing = pairings.find((item) => (item.playerOneId === firstId && item.playerTwoId === secondId) || (item.playerOneId === secondId && item.playerTwoId === firstId));
  const saved = pairing ? isRecorded(pairing) : false;
  const outcome = calculateOutcome(firstScore, secondScore, maxDiff, firstId, secondId);
  const options = useMemo(() => [...players.values()].map((player) => ({ value: player.id, label: `${player.id} · ${player.firstName} ${player.lastName}`, detail: player.school })), [players]);

  useEffect(() => {
    if (!pairing || !saved) { setFirstScore(""); setSecondScore(""); return; }
    const direct = pairing.playerOneId === firstId;
    setFirstScore((direct ? pairing.scoreOne : pairing.scoreTwo)?.toString() ?? "");
    setSecondScore((direct ? pairing.scoreTwo : pairing.scoreOne)?.toString() ?? "");
  }, [firstId, pairing, saved, secondId]);

  const save = async () => {
    if (!pairing || !outcome) return;
    const direct = pairing.playerOneId === firstId;
    setSaving(true);
    try {
      await onSubmit(pairing, Number(direct ? firstScore : secondScore), Number(direct ? secondScore : firstScore), saved);
      setFirstId(""); setSecondId(""); setFirstScore(""); setSecondScore(""); setEnabled(false);
    } catch (error) { window.alert(error instanceof Error ? error.message : "บันทึกผลไม่สำเร็จ"); }
    finally { setSaving(false); }
  };

  return (
    <Panel title="กรอกผลด้วยรหัสผู้เล่น" description="ค้นหารหัส ชื่อ หรือสถาบัน ระบบจะตรวจว่าทั้งสองคนเป็นคู่แข่งขันในเกมนี้">
      <div className="quick-result-form panel-padding">
        <div className="quick-result-side">
          <label className="form-label" htmlFor="quick-player-one">ผู้เล่นฝ่ายที่ 1</label>
          <CustomCombobox id="quick-player-one" value={firstId} onChange={(value) => { setFirstId(value.toUpperCase()); setEnabled(false); }} options={options.filter((option) => option.value !== secondId)} placeholder="รหัส ชื่อ หรือสถาบัน" caption="เลือกผู้เล่นฝ่ายที่ 1" listLabel="ผู้เล่นฝ่ายที่ 1" />
          <div className="quick-player-detail">{first ? <><strong>{first.firstName} {first.lastName}</strong><span>{first.id} · {first.school}</span></> : <span>กรอกรหัสเพื่อแสดงข้อมูล</span>}</div>
        </div>
        <input aria-label="คะแนนผู้เล่นฝ่ายที่ 1" className="result-score-input result-score-input--large" type="number" min={0} max={1_000_000_000} value={firstScore} disabled={!enabled || saving} onChange={(event) => setFirstScore(event.target.value)} />
        <div className="quick-result-center"><Search size={17} /><strong>{pairing ? `พบคู่ที่ ${pairing.tableNumber}` : first && second ? "สองคนนี้ไม่ได้พบกันในเกมนี้" : "เลือกผู้เล่น 2 คน"}</strong><span>{pairing ? outcomeLabel(outcome, players) : `Max diff เกมนี้ ${maxDiff}`}</span></div>
        <input aria-label="คะแนนผู้เล่นฝ่ายที่ 2" className="result-score-input result-score-input--large" type="number" min={0} max={1_000_000_000} value={secondScore} disabled={!enabled || saving} onChange={(event) => setSecondScore(event.target.value)} />
        <div className="quick-result-side">
          <label className="form-label" htmlFor="quick-player-two">ผู้เล่นฝ่ายที่ 2</label>
          <CustomCombobox id="quick-player-two" value={secondId} onChange={(value) => { setSecondId(value.toUpperCase()); setEnabled(false); }} options={options.filter((option) => option.value !== firstId)} placeholder="รหัส ชื่อ หรือสถาบัน" caption="เลือกผู้เล่นฝ่ายที่ 2" listLabel="ผู้เล่นฝ่ายที่ 2" />
          <div className="quick-player-detail">{second ? <><strong>{second.firstName} {second.lastName}</strong><span>{second.id} · {second.school}</span></> : <span>กรอกรหัสเพื่อแสดงข้อมูล</span>}</div>
        </div>
        <div className="quick-result-actions">
          {enabled ? <Button variant="success" disabled={saving || !pairing || !outcome} onClick={() => void save()}>{saving ? <LoaderCircle className="loading-spinner" size={15} /> : <Save size={15} />}บันทึกผล</Button>
            : <Button disabled={!pairing} onClick={() => setEnabled(true)}>{saved ? <Edit3 size={15} /> : <ToggleRight size={15} />}{saved ? "Edit ผลนี้" : "Enable กรอกคะแนน"}</Button>}
        </div>
      </div>
    </Panel>
  );
}

function ResultArchive({ card, players }: { card: TournamentCard; players: Map<string, Player> }) {
  const [selectedGame, setSelectedGame] = useState<number | null>(null);
  const retainCurrentResults = card.runtimeStage === "RESULT_COLLECTION" || card.runtimeStage === "RESULT_REVIEW";
  const snapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt) || (retainCurrentResults && snapshot.gameNumbers.includes(card.currentGame)));
  if (snapshots.length === 0) return null;
  const latestGame = Math.max(...snapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const gameNumber = selectedGame && snapshots.some((snapshot) => snapshot.gameNumbers.includes(selectedGame)) ? selectedGame : latestGame;
  const snapshot = snapshots.find((item) => item.gameNumbers.includes(gameNumber));
  const pairings = snapshot?.pairings.filter((pairing) => pairing.gameNumber === gameNumber) ?? [];
  const game = card.games.find((item) => item.number === gameNumber);
  const archiveCard = { ...card, snapshots };

  return (
    <Panel title="ผลการแข่งขันที่บันทึกไว้ตามเกม" description="ดูผลเกมปัจจุบันและผลที่ Publish แล้วได้จาก bar เดียวกัน ข้อมูลเดิมจะไม่หายเมื่อ workflow เดินต่อ">
      <div className="panel-padding archive-game-flow"><GameFlow card={archiveCard} selectedGame={gameNumber} onSelect={setSelectedGame} mode="results" /></div>
      <div className="archive-rule-summary"><strong>เกม {gameNumber} · {pairingRuleForGame(card, gameNumber)} · Max diff {game?.maxDiff}</strong><span>{snapshot?.confirmedAt ? `Publish เมื่อ ${new Date(snapshot.confirmedAt).toLocaleString("th-TH")}` : "กำลังกรอก/Review ผล"}</span></div>
      <div className="dense-table-wrap archive-table-wrap"><table className="data-table review-results"><thead><tr><th className="numeric">คู่</th><th>ผู้เล่น 1</th><th className="numeric">คะแนน</th><th>ผู้เล่น 2</th><th className="numeric">คะแนน</th><th>ผล</th><th className="numeric">Diff</th></tr></thead><tbody>{pairings.map((pairing) => { const one = players.get(pairing.playerOneId); const two = players.get(pairing.playerTwoId); const winner = players.get(pairing.winnerId ?? ""); const recorded = pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined; return <tr key={pairing.id}><td className="numeric">{pairing.tableNumber}</td><td><strong>{one?.firstName} {one?.lastName}</strong><small className="table-subline">{one?.id} · {one?.school}</small></td><td className="numeric score-review">{pairing.scoreOne ?? "—"}</td><td><strong>{two?.firstName} {two?.lastName}</strong><small className="table-subline">{two?.id} · {two?.school}</small></td><td className="numeric score-review">{pairing.scoreTwo ?? "—"}</td><td>{!recorded ? <Badge tone="info">รอกรอกผล</Badge> : pairing.resultType === "DRAW" ? <Badge tone="warning">เสมอ</Badge> : <Badge tone="success">{winner?.id} ชนะ</Badge>}</td><td className="numeric">{!recorded ? "—" : pairing.resultType === "DRAW" ? "0" : `±${pairing.calculatedDiff}`}</td></tr>; })}</tbody></table></div>
    </Panel>
  );
}

export default function GamesPage() {
  const { id } = useParams<{ id: string }>(); const router = useRouter();
  const cards = useTournamentStore((state) => state.cards); const auth = useTournamentStore((state) => state.auth); const loading = useTournamentStore((state) => state.loading);
  const submitResult = useTournamentStore((state) => state.submitResult); const reviewResults = useTournamentStore((state) => state.reviewResults);
  const reopenResults = useTournamentStore((state) => state.reopenResults); const publishResults = useTournamentStore((state) => state.publishResults);
  const card = selectCard(cards, id); const [busy, setBusy] = useState(false);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  if (!isStaff) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="บุคคลทั่วไปดูเฉพาะผลที่ publish แล้วจากหน้าภาพรวม" action={<Link href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
  if (!card) return <CardNotFound />;

  const playerMap = new Map(card.players.map((player) => [player.id, player]));
  const currentGame = card.games.find((game) => game.number === card.currentGame);
  const maxDiff = currentGame?.maxDiff ?? 350;
  const currentSnapshot = card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.includes(card.currentGame));
  const pairings = currentSnapshot?.pairings.filter((pairing) => pairing.gameNumber === card.currentGame) ?? [];
  const resultCollection = card.runtimeStage === "RESULT_COLLECTION"; const reviewing = card.runtimeStage === "RESULT_REVIEW";
  const completedCount = pairings.filter(isRecorded).length; const allComplete = pairings.length > 0 && completedCount === pairings.length;

  const saveResult = (pairing: Pairing, scoreOne: number, scoreTwo: number, editExisting: boolean) => submitResult(id, pairing.id, scoreOne, scoreTwo, editExisting);
  const beginReview = async () => { setBusy(true); try { await reviewResults(id); } catch (error) { window.alert(error instanceof Error ? error.message : "เปิดหน้า review ไม่สำเร็จ"); } finally { setBusy(false); } };
  const publish = async () => {
    if (!window.confirm(`ยืนยัน Publish ผลเกม ${card.currentGame}? ข้อมูลจะขึ้นหน้าภาพรวมและแก้ไขไม่ได้`)) return;
    const finalGame = card.currentGame === card.games.length; setBusy(true);
    try { await publishResults(id); router.push(finalGame ? `/cards/${id}` : `/cards/${id}/tables`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "Publish ผลไม่สำเร็จ"); } finally { setBusy(false); }
  };

  if (!resultCollection && !reviewing) return <><PageHeader eyebrow={`${card.name} · ${card.runtimeStage}`} title="ผลการแข่งขัน" description="ข้อมูลเกมก่อนหน้าดูย้อนหลังได้ด้านล่าง ส่วนการกรอกผลจะเปิดเมื่อยืนยัน pairing เกมปัจจุบัน" /><Panel><EmptyState icon={card.runtimeStage === "FINAL_PUBLISHED" ? <Trophy size={25} /> : <Gamepad2 size={25} />} title={card.runtimeStage === "FINAL_PUBLISHED" ? "ประกาศผลการแข่งขันแล้ว" : "ยังไม่ถึงขั้นตอนกรอกผลเกมปัจจุบัน"} description={card.runtimeStage === "PAIRING_PREVIEW" || card.runtimeStage === "TABLE_PAIRING" ? "กลับไปสร้างและยืนยัน pairing ก่อน" : "ตรวจสอบขั้นตอนปัจจุบันจากหน้าภาพรวม"} action={<Link href={card.runtimeStage === "FINAL_PUBLISHED" ? `/cards/${id}` : `/cards/${id}/tables`}><Button>{card.runtimeStage === "FINAL_PUBLISHED" ? "ดูผลรวม" : "ไปหน้าโต๊ะ"}</Button></Link>} /></Panel><ResultArchive card={card} players={playerMap} /></>;

  return (
    <>
      <PageHeader eyebrow={`${card.name} · เกม ${card.currentGame} · Max diff ${maxDiff}`} title={reviewing ? "Review ผลการแข่งขัน" : "กรอกผลการแข่งขัน"} description={reviewing ? "ตรวจคะแนน ผลชนะ/เสมอ และ diff ก่อน Publish" : "ทุกแถวเริ่มจากสถานะ Disabled ต้องกด Enable หรือ Edit ก่อนบันทึก ระบบคำนวณผลให้จากคะแนน"} actions={resultCollection ? <Button variant="success" disabled={!allComplete || busy} onClick={beginReview}><Eye size={16} />Review ผล <ArrowRight size={16} /></Button> : <div className="page-actions"><Button variant="secondary" disabled={busy} onClick={() => void reopenResults(id)}><ArrowLeft size={16} />กลับไปแก้ไข</Button><Button variant="success" disabled={busy} onClick={publish}>{card.currentGame === card.games.length ? <Trophy size={16} /> : <Check size={16} />}Finish & Publish</Button></div>} />
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ต้อง Enable และบันทึกครบทุกคู่</strong><span>{completedCount} จาก {pairings.length} คู่บันทึกแล้ว · ผลเกมจะเผยแพร่หลัง Finish หน้า Review เท่านั้น</span></p></div>

      {resultCollection ? <>
        <QuickResultForm pairings={pairings} players={playerMap} maxDiff={maxDiff} onSubmit={saveResult} />
        <Panel title={`ผลเกม ${card.currentGame}`} description={`${completedCount} จาก ${pairings.length} คู่บันทึกแล้ว · Win +2 / Draw +1 / Loss +0`} actions={<Badge tone={allComplete ? "success" : "warning"}>{allComplete ? "พร้อม Review" : "กำลังกรอก"}</Badge>}>
          <div className="result-entry-wrap"><div className="result-entry-header"><span>คู่</span><span>ฝ่ายที่ 1</span><span>คะแนน</span><span>ระบบคำนวณ</span><span>คะแนน</span><span>ฝ่ายที่ 2</span><span>สถานะ</span></div>{pairings.map((pairing) => <ResultRow key={pairing.id} pairing={pairing} players={playerMap} maxDiff={maxDiff} onSubmit={(one, two, edit) => saveResult(pairing, one, two, edit)} />)}</div>
        </Panel>
      </> : (
        <Panel title={`Review เกม ${card.currentGame}`} description={`${pairings.length} คู่ · Maximum Difference ${maxDiff}`}>
          <div className="dense-table-wrap"><table className="data-table review-results"><thead><tr><th>คู่</th><th>ผู้เล่น 1</th><th className="numeric">คะแนน</th><th>ผู้เล่น 2</th><th className="numeric">คะแนน</th><th>ผลที่คำนวณ</th><th className="numeric">Diff</th></tr></thead><tbody>{pairings.map((pairing) => { const one = playerMap.get(pairing.playerOneId); const two = playerMap.get(pairing.playerTwoId); const winner = playerMap.get(pairing.winnerId ?? ""); return <tr key={pairing.id}><td className="numeric">{pairing.tableNumber}</td><td><strong>{one?.firstName} {one?.lastName}</strong><small className="table-subline">{one?.id} · {one?.school}</small></td><td className="numeric score-review">{pairing.scoreOne}</td><td><strong>{two?.firstName} {two?.lastName}</strong><small className="table-subline">{two?.id} · {two?.school}</small></td><td className="numeric score-review">{pairing.scoreTwo}</td><td><Badge tone={pairing.resultType === "DRAW" ? "warning" : "success"}>{pairing.resultType === "DRAW" ? "เสมอ · +1 WP ทั้งคู่" : `${winner?.id} · ${winner?.firstName} ชนะ`}</Badge></td><td className="numeric">{pairing.resultType === "DRAW" ? "0" : `±${pairing.calculatedDiff}`}</td></tr>; })}</tbody></table></div>
        </Panel>
      )}
      <ResultArchive card={card} players={playerMap} />
    </>
  );
}
