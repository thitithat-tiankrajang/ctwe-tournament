"use client";

import { Crown, LoaderCircle, LockKeyhole, Save, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FinalSlot, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { appDialog } from "@/application/ui/dialog";
import { Panel } from "@/ui/components/page";

const slotTitle = (slot: number) => (slot === 0 ? "ชิงอันดับ 1 - 2" : "ชิงอันดับ 3 - 4");
const winnerPlace = (slot: number) => (slot === 0 ? 1 : 3);
const loserPlace = (slot: number) => (slot === 0 ? 2 : 4);

type NameFn = (id: string | null) => string;

export function FinalRoundBoard({ card, readOnly = false, canManage = false, onSubmitGame, onSetWinner, onPublish, onUnlockPublishedEdit, onSlotHistory }: {
  card: TournamentCard;
  readOnly?: boolean;
  canManage?: boolean;
  onSubmitGame?: (slot: number, gameIndex: number, scoreOne: number, scoreTwo: number, password?: string) => Promise<void>;
  onSetWinner?: (slot: number, winnerId: string, winnerWins: number, winnerLosses: number, totalDiff: number, password?: string) => Promise<void>;
  onPublish?: () => Promise<void>;
  onUnlockPublishedEdit?: () => Promise<string | null>;
  onSlotHistory?: (slot: FinalSlot) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editPassword, setEditPassword] = useState<string | null>(null);
  const final = card.finalRound;
  if (!final) return null;

  const players = new Map(card.players.map((player) => [player.id, player]));
  const name: NameFn = (id) => {
    const player = id ? players.get(id) : undefined;
    return player ? `${player.firstName} ${player.lastName}` : (id ?? "—");
  };
  const published = card.runtimeStage === "FINAL_PUBLISHED";
  const editable = !readOnly && (!published || Boolean(editPassword));
  const canUnlock = !readOnly && published && canManage && Boolean(onUnlockPublishedEdit) && !editPassword;
  const allDecided = final.slots.every((slot) =>
    slot.winnerId && slot.winnerWins != null && slot.winnerLosses != null && slot.totalDiff != null);

  const placement = final.slots.flatMap((slot) => {
    if (!slot.winnerId) return [];
    const loserId = slot.winnerId === slot.playerOneId ? slot.playerTwoId : slot.playerOneId;
    return [
      { place: winnerPlace(slot.slot), playerId: slot.winnerId, wins: slot.winnerWins, losses: slot.winnerLosses, totalDiff: slot.totalDiff },
      { place: loserPlace(slot.slot), playerId: loserId, wins: slot.winnerLosses, losses: slot.winnerWins, totalDiff: slot.totalDiff == null ? null : -slot.totalDiff },
    ];
  }).sort((a, b) => a.place - b.place);

  const unlock = async () => {
    const password = await onUnlockPublishedEdit?.();
    if (password) setEditPassword(password);
  };

  return (
    <div className="final-board">
      {canUnlock && (
        <div className="final-edit-unlock">
          <LockKeyhole size={18} />
          <span>ประกาศผลรอบชิงแล้ว — ผู้อำนวยการต้องยืนยันรหัสผ่านก่อนแก้ไข</span>
          <Button size="sm" variant="secondary" onClick={() => void unlock()}><LockKeyhole size={14} />ยืนยันเพื่อแก้ไข</Button>
        </div>
      )}

      {final.slots.map((slot) => (
        <FinalSlotCard
          key={slot.slot}
          slot={slot}
          name={name}
          editable={editable}
          editPassword={editPassword ?? undefined}
          onSubmitGame={onSubmitGame}
          onSetWinner={onSetWinner}
          onOpenHistory={onSlotHistory ? () => onSlotHistory(slot) : undefined}
        />
      ))}

      <Panel title="สรุปผลรอบชิงชนะเลิศ" description={card.finalType === "CHAMPION_AND_THIRD" ? "ชิงที่ 1 และ 3 — summary เป็นค่าที่เจ้าหน้าที่กรอกเอง" : "ชิงที่ 1 — summary เป็นค่าที่เจ้าหน้าที่กรอกเอง"}>
        <div className="panel-padding">
          {placement.length === 0 ? <p className="muted">ยังไม่ได้สรุปผู้ชนะของคู่ชิง</p> : (
            <table className="data-table final-summary">
              <thead><tr><th className="numeric">อันดับ</th><th>ผู้เล่น</th><th className="numeric">ชนะ</th><th className="numeric">แพ้</th><th className="numeric">Total diff</th></tr></thead>
              <tbody>{placement.map((entry) => (
                <tr key={entry.place}>
                  <td className="numeric"><Badge tone={entry.place === 1 ? "success" : "info"}>ที่ {entry.place}</Badge></td>
                  <td>{name(entry.playerId)}</td>
                  <td className="numeric">{entry.wins ?? "—"}</td>
                  <td className="numeric">{entry.losses ?? "—"}</td>
                  <td className="numeric">{entry.totalDiff == null ? "—" : `${entry.totalDiff > 0 ? "+" : ""}${entry.totalDiff}`}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {card.runtimeStage === "FINAL_COLLECTION" && canManage && (
            <div className="form-actions" style={{ paddingLeft: 0 }}>
              <Button disabled={!allDecided || busy} onClick={async () => { setBusy(true); try { await onPublish?.(); } catch (error) { await appDialog.alert(error instanceof Error ? error.message : "เผยแพร่ไม่สำเร็จ", "เผยแพร่ไม่สำเร็จ", true); } finally { setBusy(false); } }}>
                {busy ? <LoaderCircle className="loading-spinner" size={16} /> : <Trophy size={16} />}Finish &amp; Publish รอบชิง
              </Button>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function FinalSlotCard({ slot, name, editable, editPassword, onSubmitGame, onSetWinner, onOpenHistory }: {
  slot: FinalSlot;
  name: NameFn;
  editable: boolean;
  editPassword?: string;
  onSubmitGame?: (slot: number, gameIndex: number, scoreOne: number, scoreTwo: number, password?: string) => Promise<void>;
  onSetWinner?: (slot: number, winnerId: string, winnerWins: number, winnerLosses: number, totalDiff: number, password?: string) => Promise<void>;
  onOpenHistory?: () => void;
}) {
  const [gameDrafts, setGameDrafts] = useState<Record<number, { one: string; two: string }>>({});
  const [summary, setSummary] = useState({
    winnerId: slot.winnerId ?? "",
    wins: slot.winnerWins?.toString() ?? "",
    losses: slot.winnerLosses?.toString() ?? "",
    diff: slot.totalDiff?.toString() ?? "",
  });
  const [savingGame, setSavingGame] = useState<number | null>(null);
  const [savingSummary, setSavingSummary] = useState(false);

  useEffect(() => {
    setGameDrafts(Object.fromEntries(slot.games.map((game) => [game.gameIndex, {
      one: game.scoreOne?.toString() ?? "",
      two: game.scoreTwo?.toString() ?? "",
    }])));
  }, [slot.games]);

  useEffect(() => {
    setSummary({
      winnerId: slot.winnerId ?? "",
      wins: slot.winnerWins?.toString() ?? "",
      losses: slot.winnerLosses?.toString() ?? "",
      diff: slot.totalDiff?.toString() ?? "",
    });
  }, [slot.playerOneId, slot.winnerId, slot.winnerWins, slot.winnerLosses, slot.totalDiff]);

  const setScore = (gameIndex: number, field: "one" | "two", value: string) =>
    setGameDrafts((prev) => ({ ...prev, [gameIndex]: { ...(prev[gameIndex] ?? { one: "", two: "" }), [field]: value } }));

  const outcome = (oneText: string, twoText: string) => {
    const one = Number(oneText); const two = Number(twoText);
    if (!Number.isInteger(one) || !Number.isInteger(two) || one < 0 || two < 0) return null;
    if (one === two) return { label: "เสมอ · 0", diff: 0 };
    const winner = one > two ? slot.playerOneId : slot.playerTwoId;
    return { label: `${name(winner)} +${Math.abs(one - two)}`, diff: Math.abs(one - two) };
  };

  const saveGame = async (gameIndex: number) => {
    const draft = gameDrafts[gameIndex];
    if (!draft) return;
    const one = Number(draft.one); const two = Number(draft.two);
    if (!Number.isInteger(one) || !Number.isInteger(two) || one < 0 || two < 0) {
      await appDialog.alert("คะแนนต้องเป็นจำนวนเต็ม ≥ 0", "บันทึกเกมรอบชิงไม่ได้", true);
      return;
    }
    setSavingGame(gameIndex);
    try { await onSubmitGame?.(slot.slot, gameIndex, one, two, editPassword); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ", "บันทึกไม่สำเร็จ", true); }
    finally { setSavingGame(null); }
  };

  const summaryReady = useMemo(() => {
    const wins = Number(summary.wins); const losses = Number(summary.losses); const diff = Number(summary.diff);
    return Boolean(summary.winnerId)
      && Number.isInteger(wins) && wins >= 0
      && Number.isInteger(losses) && losses >= 0
      && Number.isInteger(diff);
  }, [summary]);

  const saveSummary = async () => {
    if (!summaryReady) {
      await appDialog.alert("กรุณากรอกผู้ชนะ จำนวนเกมชนะ/แพ้ และ Total diff ให้ครบ", "สรุปผลยังไม่ครบ", true);
      return;
    }
    setSavingSummary(true);
    try { await onSetWinner?.(slot.slot, summary.winnerId, Number(summary.wins), Number(summary.losses), Number(summary.diff), editPassword); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "บันทึกสรุปไม่สำเร็จ", "บันทึกสรุปไม่สำเร็จ", true); }
    finally { setSavingSummary(false); }
  };
  const playerHeader = (playerId: string) => onOpenHistory
    ? <button type="button" className="final-player-link" onClick={onOpenHistory}>{name(playerId)}</button>
    : name(playerId);

  return (
    <Panel title={slotTitle(slot.slot)} description={`${name(slot.playerOneId)}  พบ  ${name(slot.playerTwoId)}`}>
      <div className="final-slot">
        <table className="final-slot-table">
          <thead>
            <tr><th>เกม</th><th>{playerHeader(slot.playerOneId)}</th><th>{playerHeader(slot.playerTwoId)}</th><th>fill-diff</th>{editable && <th>save</th>}</tr>
          </thead>
          <tbody>
            {slot.games.map((game) => {
              const draft = gameDrafts[game.gameIndex] ?? { one: "", two: "" };
              const fill = outcome(draft.one, draft.two);
              return (
                <tr key={game.gameIndex}>
                  <td className="numeric"><strong>เกม {game.gameIndex}</strong></td>
                  <td><ScoreCell editable={editable} value={draft.one} onChange={(value) => setScore(game.gameIndex, "one", value)} onOpenHistory={onOpenHistory} /></td>
                  <td><ScoreCell editable={editable} value={draft.two} onChange={(value) => setScore(game.gameIndex, "two", value)} onOpenHistory={onOpenHistory} /></td>
                  <td className={fill && fill.diff > 0 ? "final-fill-diff final-fill-diff--win" : "final-fill-diff"}>{fill?.label ?? "—"}</td>
                  {editable && <td><Button size="sm" variant="success" disabled={savingGame === game.gameIndex} onClick={() => void saveGame(game.gameIndex)}>{savingGame === game.gameIndex ? <LoaderCircle className="loading-spinner" size={13} /> : <Save size={13} />}Save</Button></td>}
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="final-slot-summary" aria-label={`สรุปผู้ชนะ ${slotTitle(slot.slot)}`}>
          <header><Crown size={18} /><strong>สรุปผลผู้ชนะ</strong><span>กรอกเองทั้งหมด</span></header>
          <div className="final-summary-form">
            <label>ผู้ชนะ<select className="select" disabled={!editable} value={summary.winnerId} onChange={(event) => setSummary((prev) => ({ ...prev, winnerId: event.target.value }))}><option value="">เลือกผู้ชนะ</option><option value={slot.playerOneId}>{name(slot.playerOneId)}</option><option value={slot.playerTwoId}>{name(slot.playerTwoId)}</option></select></label>
            <label>ชนะ<input className="input" disabled={!editable} type="number" min={0} inputMode="numeric" value={summary.wins} onChange={(event) => setSummary((prev) => ({ ...prev, wins: event.target.value }))} /></label>
            <label>แพ้<input className="input" disabled={!editable} type="number" min={0} inputMode="numeric" value={summary.losses} onChange={(event) => setSummary((prev) => ({ ...prev, losses: event.target.value }))} /></label>
            <label>Total diff<input className="input" disabled={!editable} type="number" inputMode="numeric" value={summary.diff} onChange={(event) => setSummary((prev) => ({ ...prev, diff: event.target.value }))} /></label>
            {editable
              ? <Button size="sm" variant="success" disabled={savingSummary} onClick={() => void saveSummary()}>{savingSummary ? <LoaderCircle className="loading-spinner" size={13} /> : <Save size={13} />}Save summary</Button>
              : onOpenHistory && <button type="button" className="final-history-link" onClick={onOpenHistory}>ดูประวัติรอบชิง</button>}
          </div>
        </section>
      </div>
    </Panel>
  );
}

function ScoreCell({ editable, value, onChange, onOpenHistory }: {
  editable: boolean;
  value: string;
  onChange: (value: string) => void;
  onOpenHistory?: () => void;
}) {
  return editable
    ? <input className="input final-score" type="number" min={0} inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} />
    : onOpenHistory
      ? <button type="button" className="final-score-readonly" onClick={onOpenHistory}>{value || "—"}</button>
      : <span className="final-score-readonly final-score-readonly--static">{value || "—"}</span>;
}
