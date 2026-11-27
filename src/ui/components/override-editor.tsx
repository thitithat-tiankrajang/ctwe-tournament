"use client";

import { SaveAll, ShieldCheck, Undo2 } from "lucide-react";
import { useState } from "react";
import type { Pairing, Player } from "@/domain/tournament/types";
import { appDialog } from "@/application/ui/dialog";
import { useUnsavedChangesWarning } from "@/application/ui/use-unsaved-changes-warning";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { ScoreInput } from "@/ui/components/score-input";
import { MAX_SCORE, MIN_SCORE, ResultViewGrid } from "@/ui/components/result-entry-grid";

const validScore = (value: string) => /^-?\d+$/.test(value) && Number(value) >= MIN_SCORE && Number(value) <= MAX_SCORE;

/**
 * Director backdated-result editor: edits are buffered (not saved per keystroke). "บันทึกการแก้ไขทั้งหมด"
 * opens a log-style confirm of every change; on confirm it commits each via `onCommit` (overrideResult,
 * which recalculates standings + is public), then exits edit mode. Re-editing requires the password again.
 */
export function OverrideEditor({ block, pairingsForGame, players, onCommit, onRevokePenalty, onDone }: {
  block: number[];
  pairingsForGame: (game: number) => Pairing[];
  players: Map<string, Player>;
  onCommit: (matchId: string, scoreOne: number, scoreTwo: number) => Promise<void>;
  onRevokePenalty?: (pairing: Pairing) => void;
  onDone: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, { one: string; two: string }>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);

  const items = block.flatMap((game) => pairingsForGame(game).filter((pairing) => pairing.playerOneId || pairing.playerTwoId).map((pairing) => ({ game, pairing })));
  const savedScores = (pairing: Pairing) => ({
    one: pairing.playerOneId ? pairing.scoreOne?.toString() ?? "" : "0",
    two: pairing.playerTwoId ? pairing.scoreTwo?.toString() ?? "" : "0",
  });
  const draftOf = (pairing: Pairing) => edits[pairing.id] ?? savedScores(pairing);
  const setScore = (pairing: Pairing, field: "one" | "two", value: string) =>
    setEdits((prev) => ({ ...prev, [pairing.id]: { ...(prev[pairing.id] ?? savedScores(pairing)), [field]: value } }));
  const validSide = (pairing: Pairing, side: "one" | "two", score: string) => validScore(score)
    && (Boolean(side === "one" ? pairing.playerTwoId : pairing.playerOneId) || Number(score) > 0);
  const nameOf = (id: string | null) => { const player = id ? players.get(id) : undefined; return player ? `${player.id} ${player.firstName} ${player.lastName}` : "—"; };

  const changes = items.flatMap(({ game, pairing }) => {
    const draft = edits[pairing.id];
    if (!draft) return [];
    const { one: oldOne, two: oldTwo } = savedScores(pairing);
    if ((draft.one === oldOne && draft.two === oldTwo) || !validSide(pairing, "one", draft.one) || !validSide(pairing, "two", draft.two)) return [];
    return [{ game, pairing, oldOne, oldTwo, newOne: draft.one, newTwo: draft.two }];
  });
  // Buffered edits only reach the server on the final confirm — guard against losing them.
  const dirty = items.some(({ pairing }) => {
    const saved = savedScores(pairing);
    const draft = draftOf(pairing);
    return draft.one !== saved.one || draft.two !== saved.two;
  });
  useUnsavedChangesWarning(dirty);
  const exitEditor = async () => {
    if (!dirty || await appDialog.confirm("คะแนนที่แก้ไว้จะไม่ถูกบันทึก", {
      title: "ออกจากโหมดแก้ไข?", confirmLabel: "ออกและทิ้งการแก้ไข",
    })) onDone();
  };

  const commit = async () => {
    setCommitting(true);
    try {
      for (const change of changes) await onCommit(change.pairing.id, Number(change.newOne), Number(change.newTwo));
      setEdits({}); setConfirmOpen(false); onDone();
    } catch (error) {
      await appDialog.alert(error instanceof Error ? error.message : "บันทึกการแก้ไขไม่สำเร็จ", "บันทึกไม่สำเร็จ", true);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <>
      <div className="notice notice--warning"><p><strong>ผลย้อนหลัง · เกม {block.join("–")}</strong><span>การแก้ไขมีผลต่ออันดับทันที</span></p>
        <button type="button" className="btn btn--secondary" disabled={committing} onClick={() => void exitEditor()}>ออกจากโหมดแก้ไข</button>
      </div>
      {block.map((game, index) => <section className="panel director-grid-panel" key={game} aria-label={`แก้ไขผลย้อนหลัง เกม ${game}`}>
        {block.length > 1 && <div className="panel-head"><h2>เกม {game}</h2></div>}
        <ResultViewGrid pairings={pairingsForGame(game)} players={players} renderScore={(pairing, side, fallback) => {
          if (pairing.resultType === "PENALTY") return side === "one" || !onRevokePenalty ? fallback : <button type="button" className="btn btn--sm btn--secondary dir-row-icon"
            title="ถอนดาบ" aria-label="ถอนดาบ" disabled={committing} onClick={() => onRevokePenalty(pairing)}><Undo2 size={15} /></button>;
          if (!(side === "one" ? pairing.playerOneId : pairing.playerTwoId) || pairing.resultWithdrawn) return fallback;
          const value = draftOf(pairing)[side];
          return <ScoreInput className="sc score-override-input" type="text" inputMode="text" aria-label={`คะแนนฝ่าย ${side === "one" ? 1 : 2} คู่ ${pairing.tableNumber}`}
            value={value} disabled={committing} onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => { if (/^-?\d*$/.test(event.target.value)) { event.currentTarget.removeAttribute("aria-invalid"); setScore(pairing, side, event.target.value); } }}
            onBlur={(event) => { if (!validSide(pairing, side, event.target.value)) event.currentTarget.setAttribute("aria-invalid", "true"); }} />;
        }} />
        {index === block.length - 1 && <div className="gmeta"><span className="acts">
          <button type="button" className="btn btn--sm btn--success" disabled={committing || changes.length === 0} onClick={() => setConfirmOpen(true)}><SaveAll className="i" size={13} />บันทึกการแก้ไขทั้งหมด</button>
        </span></div>}
      </section>)}

      <ConfirmDialog
        appearance="prototype"
        open={confirmOpen}
        eyebrow="ตรวจสอบก่อนเผยแพร่"
        icon={<ShieldCheck size={20} />}
        title={`ยืนยันการแก้ไขผล ${changes.length} รายการ`}
        description="รายการที่จะถูกบันทึกและเผยแพร่สาธารณะ · standing จะคำนวณใหม่ทุกเกม"
        confirmLabel="ยืนยันและเผยแพร่"
        className="dialog--wide"
        busy={committing}
        onConfirm={() => void commit()}
        onCancel={() => { if (!committing) setConfirmOpen(false); }}
      >
        <div className="gscroll">
          <table className="dt" aria-label="สรุปผลที่จะถูกแก้ไข">
            <thead><tr><th scope="col" className="numeric">เกม</th><th scope="col" className="numeric">คู่</th><th scope="col">ฝ่ายที่ 1</th><th scope="col">ฝ่ายที่ 2</th><th scope="col" className="numeric">เดิม</th><th scope="col" className="numeric">ใหม่</th></tr></thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.pairing.id}>
                  <td className="numeric">{change.game}</td>
                  <td className="numeric">{change.pairing.tableNumber}</td>
                  <td title={nameOf(change.pairing.playerOneId)}>{nameOf(change.pairing.playerOneId)}</td>
                  <td title={nameOf(change.pairing.playerTwoId)}>{nameOf(change.pairing.playerTwoId)}</td>
                  <td className="numeric">{change.oldOne || "—"} : {change.oldTwo || "—"}</td>
                  <td className="numeric"><strong>{change.newOne} : {change.newTwo}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ConfirmDialog>
    </>
  );
}
