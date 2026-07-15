"use client";

import { Save, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { Pairing, Player } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { appDialog } from "@/application/ui/dialog";
import { useUnsavedChangesWarning } from "@/application/ui/use-unsaved-changes-warning";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Panel } from "@/ui/components/page";

const validScore = (value: string) => value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1_000_000_000;

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
  onRevokePenalty: (pairing: Pairing) => void;
  onDone: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, { one: string; two: string }>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);

  const items = block.flatMap((game) => pairingsForGame(game).filter((pairing) => pairing.playerOneId && pairing.playerTwoId).map((pairing) => ({ game, pairing })));
  const draftOf = (pairing: Pairing) => edits[pairing.id] ?? { one: pairing.scoreOne?.toString() ?? "", two: pairing.scoreTwo?.toString() ?? "" };
  const setScore = (pairing: Pairing, field: "one" | "two", value: string) =>
    setEdits((prev) => ({ ...prev, [pairing.id]: { ...(prev[pairing.id] ?? { one: pairing.scoreOne?.toString() ?? "", two: pairing.scoreTwo?.toString() ?? "" }), [field]: value } }));
  const nameOf = (id: string | null) => { const player = id ? players.get(id) : undefined; return player ? `${player.id} ${player.firstName} ${player.lastName}` : "—"; };

  const changes = items.flatMap(({ game, pairing }) => {
    const draft = edits[pairing.id];
    if (!draft) return [];
    const oldOne = pairing.scoreOne?.toString() ?? ""; const oldTwo = pairing.scoreTwo?.toString() ?? "";
    if ((draft.one === oldOne && draft.two === oldTwo) || !validScore(draft.one) || !validScore(draft.two)) return [];
    return [{ game, pairing, oldOne, oldTwo, newOne: draft.one, newTwo: draft.two }];
  });
  // Buffered edits only reach the server on the final confirm — guard against losing them.
  useUnsavedChangesWarning(changes.length > 0);

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
      {block.map((game) => {
        const pairings = pairingsForGame(game);
        return (
          <Panel key={game} title={`แก้ไขผล เกม ${game} (ย้อนหลัง)`} description="แก้คะแนนได้หลายคู่ แล้วกด “บันทึกการแก้ไขทั้งหมด” ครั้งเดียว · standing จะคำนวณใหม่ตอนยืนยัน">
            <div className="dense-table-wrap">
              <table className="data-table">
                <thead><tr><th className="numeric">คู่</th><th>ฝ่ายที่ 1</th><th>ฝ่ายที่ 2</th><th className="numeric">เดิม</th><th className="numeric">คะแนน 1</th><th className="numeric">คะแนน 2</th></tr></thead>
                <tbody>
                  {pairings.length === 0 ? <tr><td colSpan={6} className="egrid-empty"><strong>ยังไม่มีผลที่เผยแพร่</strong></td></tr> : pairings.map((pairing) => {
                    const penalty = pairing.resultType === "PENALTY";
                    const draft = draftOf(pairing);
                    const dirty = !penalty && Boolean(edits[pairing.id]) && (draft.one !== (pairing.scoreOne?.toString() ?? "") || draft.two !== (pairing.scoreTwo?.toString() ?? ""));
                    return (
                      <tr key={pairing.id} className={penalty ? "egrid-row--locked egrid-row--penalty" : dirty ? "player-row--editing" : undefined}>
                        <td className="numeric">{pairing.tableNumber}</td>
                        <td title={nameOf(pairing.playerOneId)}>{nameOf(pairing.playerOneId)}</td>
                        <td title={nameOf(pairing.playerTwoId)}>{nameOf(pairing.playerTwoId)}</td>
                        <td className="numeric">{penalty ? <Badge tone="danger">ลงดาบ −{pairing.calculatedDiff ?? 0}</Badge> : <>{pairing.scoreOne ?? "—"} : {pairing.scoreTwo ?? "—"}</>}</td>
                        <td>{penalty ? <Badge tone="danger">ล็อก</Badge> : <input className="input" type="number" min={0} inputMode="numeric" aria-label={`คะแนนฝ่าย 1 คู่ ${pairing.tableNumber}`} value={draft.one} disabled={committing} onChange={(event) => setScore(pairing, "one", event.target.value)} />}</td>
                        <td>{penalty ? <Button size="sm" variant="secondary" disabled={committing} onClick={() => onRevokePenalty(pairing)}>ถอนดาบ</Button> : <input className="input" type="number" min={0} inputMode="numeric" aria-label={`คะแนนฝ่าย 2 คู่ ${pairing.tableNumber}`} value={draft.two} disabled={committing} onChange={(event) => setScore(pairing, "two", event.target.value)} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}

      <div className="form-actions">
        <Button variant="secondary" disabled={committing} onClick={onDone}><X size={16} />ออกจากโหมดแก้ไข</Button>
        <Button disabled={committing || changes.length === 0} onClick={() => setConfirmOpen(true)}><Save size={16} />บันทึกการแก้ไขทั้งหมด ({changes.length})</Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        eyebrow="ตรวจสอบก่อนเผยแพร่"
        icon={<ShieldCheck size={20} />}
        title={`ยืนยันการแก้ไขผล ${changes.length} รายการ`}
        description="รายการที่จะถูกบันทึกและเผยแพร่สาธารณะ · standing จะคำนวณใหม่ทุกเกม"
        confirmLabel="ยืนยันและเผยแพร่"
        className="confirm-dialog--wide"
        busy={committing}
        onConfirm={() => void commit()}
        onCancel={() => { if (!committing) setConfirmOpen(false); }}
      >
        <div className="dense-table-wrap">
          <table className="data-table">
            <thead><tr><th className="numeric">เกม</th><th className="numeric">คู่</th><th>ฝ่ายที่ 1</th><th>ฝ่ายที่ 2</th><th className="numeric">เดิม</th><th className="numeric">ใหม่</th></tr></thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.pairing.id}>
                  <td className="numeric">{change.game}</td>
                  <td className="numeric">{change.pairing.tableNumber}</td>
                  <td title={nameOf(change.pairing.playerOneId)}>{nameOf(change.pairing.playerOneId)}</td>
                  <td title={nameOf(change.pairing.playerTwoId)}>{nameOf(change.pairing.playerTwoId)}</td>
                  <td className="numeric">{change.oldOne || "—"} : {change.oldTwo || "—"}</td>
                  <td className="numeric"><Badge tone="success">{change.newOne} : {change.newTwo}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ConfirmDialog>
    </>
  );
}
