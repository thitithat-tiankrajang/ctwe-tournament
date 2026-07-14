"use client";

import { AlertTriangle, LoaderCircle, UserPlus2, X } from "lucide-react";
import { useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import type { TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";

/**
 * Director-only "ลงทะเบียนเพิ่ม": reopen player registration after it was finished, allowed until
 * the FIRST game-1 result is saved. Before any game-1 pairing exists (TABLE_PAIRING) the finish is
 * reverted directly; once the pairing is previewed or published, confirming requires the
 * director's password because the game-1 pairing will be discarded. Renders nothing when the card
 * is not in that window (registration still open, past game 1, or a game-1 result already saved).
 */
export function ReopenRegistration({ card }: { card: TournamentCard }) {
  const reopenRegistration = useTournamentStore((state) => state.reopenRegistration);
  const verifyPassword = useTournamentStore((state) => state.verifyPassword);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pairingExists = card.runtimeStage === "PAIRING_PREVIEW" || card.runtimeStage === "RESULT_COLLECTION";
  const anyGameOneResult = card.snapshots.some((snapshot) => snapshot.pairings.some((pairing) => Boolean(pairing.resultType)));
  const eligible = card.currentGame === 1
    && (card.runtimeStage === "TABLE_PAIRING" || pairingExists)
    && card.status !== "FINISHED" && card.status !== "CLOSED"
    && !anyGameOneResult;
  if (!eligible) return null;

  const reopenBeforePairing = async () => {
    if (!await appDialog.confirm("ระบบจะยกเลิกการจบการลงทะเบียน และเปิดให้เพิ่มผู้เล่นต่อจากรายชื่อเดิม รหัสผู้เล่นเดิมไม่เปลี่ยนแปลง", {
      title: "ลงทะเบียนเพิ่ม",
      confirmLabel: "ลงทะเบียนเพิ่ม",
    })) return;
    setBusy(true);
    try {
      await reopenRegistration(card.id);
    } catch (failure) {
      await appDialog.alert(failure instanceof Error ? failure.message : "ลงทะเบียนเพิ่มไม่สำเร็จ", "ลงทะเบียนเพิ่มไม่สำเร็จ", true);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setPassword("");
    setError("");
    setDialogOpen(false);
  };

  const confirmDiscardPairing = async () => {
    if (!password) { setError("กรอกรหัสผ่านผู้อำนวยการ"); return; }
    setBusy(true); setError("");
    try {
      if (!await verifyPassword(password)) { setError("รหัสผ่านไม่ถูกต้อง"); return; }
      await reopenRegistration(card.id, password);
      setPassword("");
      setDialogOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ลงทะเบียนเพิ่มไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => { if (pairingExists) { setDialogOpen(true); } else { void reopenBeforePairing(); } }}>
        {busy && !dialogOpen ? <LoaderCircle className="loading-spinner" size={16} /> : <UserPlus2 size={16} />}ลงทะเบียนเพิ่ม
      </Button>

      {dialogOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
          <section
            className="confirm-dialog confirm-dialog--danger"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reopen-registration-title"
            aria-describedby="reopen-registration-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div className="confirm-dialog__icon"><AlertTriangle size={20} /></div>
              <div><span>ผู้อำนวยการเท่านั้น</span><h2 id="reopen-registration-title">ลงทะเบียนเพิ่ม</h2></div>
              <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={busy} onClick={close}><X size={18} /></button>
            </header>
            <p id="reopen-registration-description">ขณะนี้ผลประกบคู่เกมแรกได้ออกมาแล้ว ต้องการจะยืนยันที่จะลงทะเบียนเพิ่มหรือไม่ หากยืนยัน เราจะยกเลิกผลประกบคู่เกมแรก</p>
            <label className="form-label" htmlFor="reopen-registration-password">รหัสผ่านผู้อำนวยการ</label>
            <FreshSecretInput
              className="input"
              id="reopen-registration-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void confirmDiscardPairing(); } }}
              placeholder="รหัสผ่านบัญชีของคุณ"
            />
            {error && <div className="confirm-dialog__error" role="alert">{error}</div>}
            <footer>
              <Button variant="secondary" disabled={busy} onClick={close}>ยกเลิก</Button>
              <Button variant="danger" disabled={busy} onClick={() => void confirmDiscardPairing()}>
                {busy && <LoaderCircle className="loading-spinner" size={16} />}{busy ? "กำลังทำรายการ…" : "ยืนยันลงทะเบียนเพิ่ม"}
              </Button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
