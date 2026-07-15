"use client";

import { RotateCcw, UserMinus, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import type { TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { Panel } from "@/ui/components/page";

/**
 * Director-only terminate / restore of players in a running card (per card, password-confirmed).
 * Terminated players leave future pairings and standings; restoring charges each missed game as a
 * loss of the entered points. When the current pairing already exists, the restore dialog explains
 * the placement (case A/B/C) exactly as the backend will apply it.
 */
export function PlayerTermination({ card }: { card: TournamentCard }) {
  const terminatePlayers = useTournamentStore((state) => state.terminatePlayers);
  const restorePlayers = useTournamentStore((state) => state.restorePlayers);

  const active = useMemo(() => card.players.filter((p) => !p.terminated), [card.players]);
  const terminated = useMemo(() => card.players.filter((p) => p.terminated), [card.players]);

  const [mode, setMode] = useState<"terminate" | "restore" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");
  const [lossPoints, setLossPoints] = useState("100");
  const [unpair, setUnpair] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Case detection mirrors the backend so the dialog explains what will actually happen.
  const preview = card.snapshots.find((s) => !s.confirmedAt);
  const pairingExists = card.runtimeStage === "PAIRING_PREVIEW" || card.runtimeStage === "RESULT_COLLECTION";
  const anyResultInBlock = Boolean(preview?.pairings.some((p) => Boolean(p.resultType)));
  const restoreCase: "A" | "B" | "C" = !pairingExists ? "A" : !anyResultInBlock ? "B" : "C";

  const open = (next: "terminate" | "restore") => {
    setMode(next); setSelected(new Set()); setPassword(""); setLossPoints("100"); setUnpair(false); setError("");
  };
  const close = () => {
    if (busy) return;
    setPassword("");
    setMode(null);
  };
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    const ids = [...selected];
    if (ids.length === 0) { setError("เลือกผู้เล่นอย่างน้อย 1 คน"); return; }
    if (!password) { setError("กรอกรหัสผ่านผู้อำนวยการ"); return; }
    setBusy(true); setError("");
    try {
      if (mode === "terminate") {
        await terminatePlayers(card.id, ids, password);
      } else {
        const points = Number(lossPoints);
        if (!Number.isInteger(points) || points < 0) { setError("แต้มปรับแพ้ต้องเป็นจำนวนเต็ม ≥ 0"); setBusy(false); return; }
        await restorePlayers(card.id, ids, password, points, restoreCase === "B" && unpair);
      }
      setPassword("");
      setMode(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="ถอน / ดึงผู้เล่นกลับ (Terminate / Restore)"
      description="ผู้อำนวยการถอนผู้เล่นออกจากการแข่งขันเป็นหมู่ได้ และดึงกลับภายหลัง โดยเกมที่ผู้เล่นหายไปจะถูกปรับแพ้ตามแต้มที่กำหนด · ต้องยืนยันด้วยรหัสผ่าน"
    >
      <div className="panel-padding termination-actions">
        <Button variant="secondary" size="sm" disabled={active.length === 0} onClick={() => open("terminate")}>
          <UserMinus size={15} />ถอนผู้เล่น (Terminate)
        </Button>
        <Button variant="secondary" size="sm" disabled={terminated.length === 0} onClick={() => open("restore")}>
          <UserPlus size={15} />ดึงผู้เล่นกลับ ({terminated.length})
        </Button>
      </div>

      {terminated.length > 0 && (
        <div className="panel-padding termination-summary">
          <p>ผู้เล่นที่ถูกถอนออก <strong>{terminated.length} คน</strong> · เก็บประวัติเดิมไว้และดึงกลับได้</p>
          <div className="termination-chips">
            {terminated.map((p) => <span key={p.id}>{p.id} · {p.firstName} {p.lastName}</span>)}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={mode !== null}
        eyebrow="ผู้อำนวยการเท่านั้น"
        icon={mode === "terminate" ? <UserMinus size={20} /> : <RotateCcw size={20} />}
        title={mode === "terminate" ? "ถอนผู้เล่นออกจากการแข่งขัน" : "ดึงผู้เล่นกลับเข้าการแข่งขัน"}
        confirmLabel={mode === "terminate" ? `ถอน ${selected.size} คน` : `ดึงกลับ ${selected.size} คน`}
        busyLabel="กำลังทำรายการ…"
        danger={mode === "terminate"}
        busy={busy}
        error={error || undefined}
        className="termination-dialog"
        onConfirm={() => void submit()}
        onCancel={close}
      >
        <div className="termination-dialog__body">
          <div className="termination-picker__toolbar">
            <div><strong>เลือกผู้เล่น</strong><span>{selected.size} จาก {(mode === "terminate" ? active : terminated).length} คน</span></div>
            <div>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(new Set((mode === "terminate" ? active : terminated).map((p) => p.id)))}>เลือกทั้งหมด</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>ล้าง</Button>
            </div>
          </div>
          <div className="termination-picker">
            {(mode === "terminate" ? active : terminated).map((p) => (
              <label key={p.id} className={`termination-player${selected.has(p.id) ? " termination-player--selected" : ""}`}>
                <input type="checkbox" checked={selected.has(p.id)} disabled={busy} onChange={() => toggle(p.id)} />
                <span><strong>{p.id} · {p.firstName} {p.lastName}</strong><small>{p.school}</small></span>
              </label>
            ))}
          </div>

          {mode === "terminate" ? (
            <div className="notice notice--warning termination-notice"><p><strong>ผลเดิมจะยังอยู่ครบ</strong><span>ผู้เล่นที่ถอนจะไม่ถูกจับคู่เกมถัดไป หากยังมีคู่ที่ยังไม่กรอกผลในเกมปัจจุบัน ต้องบันทึกผลคู่นั้นก่อน</span></p></div>
          ) : (
            <div className="termination-restore-options">
            {restoreCase === "A" && <div className="notice notice--info"><p><span>ผู้เล่นเหล่านี้จะเข้าไปเล่นต่อในเกมที่ <strong>{card.currentGame}</strong> และผลการแข่งขันในเกมที่เขาหายไปจะถูกปรับแพ้เกมละแต้มที่กรอกด้านล่าง</span></p></div>}
            {restoreCase === "B" && (
              <>
                <div className="notice notice--warning"><p><span>Pairing เกมปัจจุบัน (เกม {card.currentGame}) ถูกสร้างขึ้นแล้ว ต้องการ <strong>un-pairing</strong> เพื่อนำผู้เล่นเหล่านี้เข้าสู่ pairing ปัจจุบันหรือไม่?</span></p></div>
                <div className="termination-radio-group">
                  <label><input type="radio" name="unpair" checked={unpair} disabled={busy} onChange={() => setUnpair(true)} /><span><strong>Un-pairing</strong><small>นำผู้เล่นเข้าเกมปัจจุบัน</small></span></label>
                  <label><input type="radio" name="unpair" checked={!unpair} disabled={busy} onChange={() => setUnpair(false)} /><span><strong>คง Pairing เดิม</strong><small>ปรับแพ้เกมนี้ แล้วเล่นเกมถัดไป</small></span></label>
                </div>
              </>
            )}
            {restoreCase === "C" && <div className="notice notice--warning"><p><span>Pairing เกมปัจจุบันมีการกรอกผลแล้ว จึง un-pairing ไม่ได้ · ผู้เล่นจะถูกปรับแพ้ในเกมที่ {card.currentGame} และเกมที่หายไป เกมละแต้มด้านล่าง แล้วกลับมาเล่นในเกมถัดไป</span></p></div>}
            <div className="form-field">
              <label className="form-label" htmlFor="loss-points">แต้มที่ปรับแพ้ต่อเกมที่หายไป</label>
              <input className="input termination-points" id="loss-points" type="number" min={0} value={lossPoints} disabled={busy} onChange={(e) => setLossPoints(e.target.value)} />
            </div>
          </div>
          )}

          <div className="form-field termination-password">
            <label className="form-label" htmlFor="term-password">รหัสผ่านผู้อำนวยการ</label>
            <FreshSecretInput className="input" id="term-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} placeholder="รหัสผ่านบัญชีของคุณ" />
          </div>
        </div>
      </ConfirmDialog>
    </Panel>
  );
}
