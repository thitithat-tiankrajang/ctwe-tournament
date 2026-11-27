"use client";

import { Crown, LoaderCircle, LockKeyhole, Save, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { editField, FINAL_MAX_SCORE, FINAL_MIN_SCORE, finalSlotDraftKey, parseFinalScore, gameDraftDirty, reconcileGameDrafts, reconcileSummaryDraft, savedText, summaryDraftDirty, type GameDrafts, type SummaryDraft } from "@/ui/components/final-draft";
import type { FinalSlot, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { appDialog } from "@/application/ui/dialog";
import { useUnsavedChangesWarning } from "@/application/ui/use-unsaved-changes-warning";
import { Panel } from "@/ui/components/page";
import { ScoreInput } from "@/ui/components/score-input";

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

      <div className="final-board-matches">{final.slots.map((slot) => (
        <FinalSlotCard
          key={finalSlotDraftKey(card.id, slot)}
          slot={slot}
          name={name}
          school={id => players.get(id)?.school ?? ""}
          editable={editable}
          editPassword={editPassword ?? undefined}
          onSubmitGame={onSubmitGame}
          onSetWinner={onSetWinner}
          onOpenHistory={onSlotHistory ? () => onSlotHistory(slot) : undefined}
        />
      ))}</div>

      <Panel title="สรุปผลรอบชิงชนะเลิศ">
        <div className="panel-padding">
          {placement.length === 0 ? <p className="muted">ยังไม่ได้สรุปผู้ชนะของคู่ชิง</p> : (
            <table className="data-table final-summary" aria-label="สรุปผลรอบชิงชนะเลิศ">
              <thead><tr><th scope="col" className="numeric">อันดับ</th><th scope="col">ผู้เล่น</th><th scope="col" className="numeric">ชนะ</th><th scope="col" className="numeric">แพ้</th><th scope="col" className="numeric">Total diff</th></tr></thead>
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

function FinalSlotCard({ slot, name, school, editable, editPassword, onSubmitGame, onSetWinner, onOpenHistory }: {
  slot: FinalSlot;
  name: NameFn;
  school: (id: string) => string;
  editable: boolean;
  editPassword?: string;
  onSubmitGame?: (slot: number, gameIndex: number, scoreOne: number, scoreTwo: number, password?: string) => Promise<void>;
  onSetWinner?: (slot: number, winnerId: string, winnerWins: number, winnerLosses: number, totalDiff: number, password?: string) => Promise<void>;
  onOpenHistory?: () => void;
}) {
  const [gameDrafts, setGameDrafts] = useState<GameDrafts>(() => reconcileGameDrafts({}, slot.games));
  const [summaryDraft, setSummaryDraft] = useState<SummaryDraft>(() => reconcileSummaryDraft(undefined, slot));
  const [savingGames, setSavingGames] = useState<ReadonlySet<number>>(() => new Set());
  const [savingSummary, setSavingSummary] = useState(false);
  const summary = editable ? {
    winnerId: summaryDraft.winnerId.value,
    wins: summaryDraft.wins.value,
    losses: summaryDraft.losses.value,
    diff: summaryDraft.diff.value,
  } : {
    winnerId: savedText(slot.winnerId),
    wins: savedText(slot.winnerWins),
    losses: savedText(slot.winnerLosses),
    diff: savedText(slot.totalDiff),
  };

  // Warn before the tab closes while a typed score or summary hasn't been saved yet.
  const gamesDirty = gameDraftDirty(gameDrafts, slot.games);
  const summaryDirty = summaryDraftDirty(summaryDraft, slot);
  useUnsavedChangesWarning(editable && (gamesDirty || summaryDirty));

  // A replaced card (own save response, another operator over SSE, a refresh) only updates fields
  // the operator has not typed over, so an in-flight save can never erase a newer draft.
  useEffect(() => {
    setGameDrafts((previous) => reconcileGameDrafts(previous, slot.games));
  }, [slot.games]);

  const { winnerId, winnerWins, winnerLosses, totalDiff } = slot;
  useEffect(() => {
    setSummaryDraft((previous) => reconcileSummaryDraft(previous, { winnerId, winnerWins, winnerLosses, totalDiff }));
  }, [winnerId, winnerWins, winnerLosses, totalDiff]);

  // Once the board stops being editable (published, or the unlock lapsed) every draft is dropped, so
  // read-only cells show only saved values and a later unlock starts from what is saved.
  useEffect(() => {
    if (editable) return;
    setGameDrafts(reconcileGameDrafts({}, slot.games));
    setSummaryDraft(reconcileSummaryDraft(undefined, { winnerId, winnerWins, winnerLosses, totalDiff }));
  }, [editable, slot.games, winnerId, winnerWins, winnerLosses, totalDiff]);

  const setScore = (gameIndex: number, field: "one" | "two", value: string) => {
    const saved = slot.games.find((game) => game.gameIndex === gameIndex);
    const savedValue = savedText(field === "one" ? saved?.scoreOne : saved?.scoreTwo);
    setGameDrafts((prev) => {
      const current = prev[gameIndex] ?? reconcileGameDrafts({}, saved ? [saved] : [])[gameIndex];
      return { ...prev, [gameIndex]: { ...current, [field]: editField(current?.[field], value, savedValue) } };
    });
  };
  const setSummaryField = (field: keyof SummaryDraft, value: string) =>
    setSummaryDraft((prev) => ({ ...prev, [field]: editField(prev[field], value, prev[field].base) }));

  const outcome = (oneText: string, twoText: string) => {
    const one = parseFinalScore(oneText); const two = parseFinalScore(twoText);
    if (one == null || two == null) return null;
    if (one === two) return { label: "เสมอ · 0", diff: 0 };
    const winner = one > two ? slot.playerOneId : slot.playerTwoId;
    return { label: `${name(winner)} +${Math.abs(one - two)}`, diff: Math.abs(one - two) };
  };

  const saveGame = async (gameIndex: number) => {
    const entry = gameDrafts[gameIndex];
    if (!entry) return;
    const draft = { one: entry.one.value, two: entry.two.value };
    const one = parseFinalScore(draft.one); const two = parseFinalScore(draft.two);
    if (one == null || two == null) {
      await appDialog.alert(`คะแนนต้องเป็นจำนวนเต็มระหว่าง ${FINAL_MIN_SCORE} ถึง ${FINAL_MAX_SCORE}`, "บันทึกเกมรอบชิงไม่ได้", true);
      return;
    }
    setSavingGames((prev) => new Set(prev).add(gameIndex));
    try { await onSubmitGame?.(slot.slot, gameIndex, one, two, editPassword); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ", "บันทึกไม่สำเร็จ", true); }
    finally { setSavingGames((prev) => { const next = new Set(prev); next.delete(gameIndex); return next; }); }
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
    <Panel title={slotTitle(slot.slot)} className="final-entry-match">
      <div className="final-slot">
        <div className="final-entry-players">{[slot.playerOneId, slot.playerTwoId].map(id => <div key={id} data-winner={slot.winnerId === id}>
          <span className="code">{id}</span><strong>{playerHeader(id)}</strong><small title={school(id)}>{school(id)}</small>
        </div>)}</div>
        <table className="final-slot-table" aria-label={`ผลรายเกม ${slotTitle(slot.slot)}`}>
          <thead>
            <tr><th scope="col">เกม</th><th scope="col" title={name(slot.playerOneId)}>{slot.playerOneId}</th><th scope="col" title={name(slot.playerTwoId)}>{slot.playerTwoId}</th><th scope="col">ผลเกม</th>{editable && <th scope="col">บันทึก</th>}</tr>
          </thead>
          <tbody>
            {slot.games.map((game) => {
              const entry = gameDrafts[game.gameIndex];
              const draft = editable && entry
                ? { one: entry.one.value, two: entry.two.value }
                : { one: savedText(game.scoreOne), two: savedText(game.scoreTwo) };
              const saving = savingGames.has(game.gameIndex);
              const fill = outcome(draft.one, draft.two);
              return (
                <tr key={game.gameIndex}>
                  <td className="numeric"><strong>เกม {game.gameIndex}</strong></td>
                  <td><ScoreCell editable={editable} value={draft.one} onChange={(value) => setScore(game.gameIndex, "one", value)} onOpenHistory={onOpenHistory} /></td>
                  <td><ScoreCell editable={editable} value={draft.two} onChange={(value) => setScore(game.gameIndex, "two", value)} onOpenHistory={onOpenHistory} /></td>
                  <td className={fill && fill.diff > 0 ? "final-fill-diff final-fill-diff--win" : "final-fill-diff"}>{fill?.label ?? "—"}</td>
                  {editable && <td><Button size="sm" variant="success" disabled={saving} onClick={() => void saveGame(game.gameIndex)}>{saving ? <LoaderCircle className="loading-spinner" size={13} /> : <Save size={13} />}บันทึก</Button></td>}
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="final-slot-summary" aria-label={`สรุปผู้ชนะ ${slotTitle(slot.slot)}`}>
          <header><Crown size={18} /><strong>สรุปผลผู้ชนะ</strong></header>
          <div className="final-summary-form">
            <label>ผู้ชนะ<select className="select" disabled={!editable} value={summary.winnerId} onChange={(event) => setSummaryField("winnerId", event.target.value)}><option value="">เลือกผู้ชนะ</option><option value={slot.playerOneId}>{name(slot.playerOneId)}</option><option value={slot.playerTwoId}>{name(slot.playerTwoId)}</option></select></label>
            <label>ชนะ<ScoreInput className="input" disabled={!editable} type="number" min={0} inputMode="numeric" value={summary.wins} onChange={(event) => setSummaryField("wins", event.target.value)} /></label>
            <label>แพ้<ScoreInput className="input" disabled={!editable} type="number" min={0} inputMode="numeric" value={summary.losses} onChange={(event) => setSummaryField("losses", event.target.value)} /></label>
            <label>Total diff<ScoreInput className="input" disabled={!editable} type="text" inputMode="text" value={summary.diff} onChange={(event) => {
              if (/^-?\d*$/.test(event.target.value)) setSummaryField("diff", event.target.value);
            }} /></label>
            {editable
              ? <Button size="sm" variant="success" disabled={savingSummary} onClick={() => void saveSummary()}>{savingSummary ? <LoaderCircle className="loading-spinner" size={13} /> : <Save size={13} />}บันทึกสรุปผล</Button>
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
    ? <ScoreInput className="input final-score" type="text" inputMode="text" value={value} onChange={(event) => {
      if (/^-?\d*$/.test(event.target.value)) onChange(event.target.value);
    }} />
    : onOpenHistory
      ? <button type="button" className="final-score-readonly" onClick={onOpenHistory}>{value || "—"}</button>
      : <span className="final-score-readonly final-score-readonly--static">{value || "—"}</span>;
}
