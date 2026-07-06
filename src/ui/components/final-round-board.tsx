"use client";

import { Crown, LoaderCircle, Trophy } from "lucide-react";
import { useState } from "react";
import type { FinalSlot, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { appDialog } from "@/application/ui/dialog";
import { Panel } from "@/ui/components/page";

const slotTitle = (slot: number) => (slot === 0 ? "ชิงอันดับ 1 - 2" : "ชิงอันดับ 3 - 4");
const winnerPlace = (slot: number) => (slot === 0 ? 1 : 3);
const loserPlace = (slot: number) => (slot === 0 ? 2 : 4);

type NameFn = (id: string | null) => string;

/**
 * Final-round board: one horizontal table per bracket pairing (players as rows, games as columns,
 * last row = manual winner pick), plus a summary table that maps each pairing's chosen winner to a
 * placement per the card's final template. The system records per-game scores (winner = higher score,
 * no max diff) but never auto-decides the series — that is the manual "สรุปผู้ชนะ" pick.
 */
export function FinalRoundBoard({ card, readOnly = false, canManage = false, onSubmitGame, onSetWinner, onPublish }: {
  card: TournamentCard;
  readOnly?: boolean;
  canManage?: boolean;
  onSubmitGame?: (slot: number, gameIndex: number, scoreOne: number, scoreTwo: number) => Promise<void>;
  onSetWinner?: (slot: number, winnerId: string) => Promise<void>;
  onPublish?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const final = card.finalRound;
  if (!final) return null;

  const players = new Map(card.players.map((player) => [player.id, player]));
  const name: NameFn = (id) => { const player = id ? players.get(id) : undefined; return player ? `${player.firstName} ${player.lastName}` : (id ?? "—"); };
  const locked = readOnly || card.runtimeStage === "FINAL_PUBLISHED";
  const allDecided = final.slots.every((slot) => slot.winnerId);

  const placement = final.slots.flatMap((slot) => {
    if (!slot.winnerId) return [];
    const loserId = slot.winnerId === slot.playerOneId ? slot.playerTwoId : slot.playerOneId;
    return [{ place: winnerPlace(slot.slot), playerId: slot.winnerId }, { place: loserPlace(slot.slot), playerId: loserId }];
  }).sort((a, b) => a.place - b.place);

  return (
    <div className="final-board">
      {final.slots.map((slot) => (
        <FinalSlotCard key={slot.slot} slot={slot} name={name} locked={locked} onSubmitGame={onSubmitGame} onSetWinner={onSetWinner} />
      ))}

      <Panel title="สรุปผลรอบชิงชนะเลิศ" description={card.finalType === "CHAMPION_AND_THIRD" ? "ชิงที่ 1 และ 3 — อันดับมาจากผู้ชนะที่สรุปของแต่ละคู่" : "ชิงที่ 1 — อันดับมาจากผู้ชนะที่สรุปของคู่ชิง"}>
        <div className="panel-padding">
          {placement.length === 0 ? <p className="muted">ยังไม่ได้สรุปผู้ชนะของคู่ชิง</p> : (
            <table className="data-table final-summary">
              <thead><tr><th className="numeric">อันดับ</th><th>ผู้เล่น</th></tr></thead>
              <tbody>{placement.map((entry) => (
                <tr key={entry.place}><td className="numeric"><Badge tone={entry.place === 1 ? "success" : "info"}>ที่ {entry.place}</Badge></td><td>{name(entry.playerId)}</td></tr>
              ))}</tbody>
            </table>
          )}
          {!locked && canManage && (
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

function FinalSlotCard({ slot, name, locked, onSubmitGame, onSetWinner }: {
  slot: FinalSlot;
  name: NameFn;
  locked: boolean;
  onSubmitGame?: (slot: number, gameIndex: number, scoreOne: number, scoreTwo: number) => Promise<void>;
  onSetWinner?: (slot: number, winnerId: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<number, { one: string; two: string }>>(() =>
    Object.fromEntries(slot.games.map((game) => [game.gameIndex, { one: game.scoreOne?.toString() ?? "", two: game.scoreTwo?.toString() ?? "" }])));
  const setScore = (gameIndex: number, field: "one" | "two", value: string) =>
    setDrafts((prev) => ({ ...prev, [gameIndex]: { ...(prev[gameIndex] ?? { one: "", two: "" }), [field]: value } }));

  const save = async (gameIndex: number) => {
    const draft = drafts[gameIndex];
    if (!draft || draft.one.trim() === "" || draft.two.trim() === "") return;
    const one = Number(draft.one); const two = Number(draft.two);
    if (!Number.isInteger(one) || !Number.isInteger(two) || one < 0 || two < 0) return;
    const game = slot.games.find((entry) => entry.gameIndex === gameIndex);
    if (game && game.scoreOne === one && game.scoreTwo === two) return;
    try { await onSubmitGame?.(slot.slot, gameIndex, one, two); } catch (error) { await appDialog.alert(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ", "บันทึกไม่สำเร็จ", true); }
  };

  return (
    <Panel title={slotTitle(slot.slot)} description={`${name(slot.playerOneId)}  พบ  ${name(slot.playerTwoId)}`}>
      <div className="final-slot-wrap">
        <table className="final-slot-table">
          <thead>
            <tr><th>ผู้เล่น</th>{slot.games.map((game) => <th key={game.gameIndex} className="numeric">เกม {game.gameIndex}</th>)}</tr>
          </thead>
          <tbody>
            {([slot.playerOneId, slot.playerTwoId] as const).map((playerId, rowIndex) => (
              <tr key={playerId}>
                <td className="final-slot-player">{name(playerId)}</td>
                {slot.games.map((game) => {
                  const isWin = game.winnerId === playerId;
                  const field = rowIndex === 0 ? "one" : "two";
                  return (
                    <td key={game.gameIndex} className={isWin ? "final-cell--win" : undefined}>
                      {locked
                        ? ((rowIndex === 0 ? game.scoreOne : game.scoreTwo) ?? "—")
                        : <input className="input final-score" type="number" min={0} inputMode="numeric" aria-label={`คะแนน ${name(playerId)} เกม ${game.gameIndex}`}
                            value={drafts[game.gameIndex]?.[field] ?? ""} onChange={(event) => setScore(game.gameIndex, field, event.target.value)} onBlur={() => void save(game.gameIndex)} />}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="final-slot-decide">
              <td>สรุปผู้ชนะ</td>
              <td colSpan={slot.games.length}>
                {locked
                  ? <strong>{slot.winnerId ? `${name(slot.winnerId)} ชนะ` : "ยังไม่สรุป"}</strong>
                  : (
                    <div className="final-decide">
                      {([slot.playerOneId, slot.playerTwoId] as const).map((playerId) => (
                        <label key={playerId} className={`final-decide__opt${slot.winnerId === playerId ? " final-decide__opt--on" : ""}`}>
                          <input type="radio" name={`final-winner-${slot.slot}`} checked={slot.winnerId === playerId} onChange={() => void onSetWinner?.(slot.slot, playerId)} />
                          <Crown size={14} />{name(playerId)} ชนะ
                        </label>
                      ))}
                    </div>
                  )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
