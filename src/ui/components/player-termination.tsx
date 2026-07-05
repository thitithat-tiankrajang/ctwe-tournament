"use client";

import { LoaderCircle, RotateCcw, UserMinus, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import type { Player, TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
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
  const close = () => { if (!busy) setMode(null); };
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
      setMode(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const label = (p: Player) => `${p.id} · ${p.firstName} ${p.lastName} · ${p.school}`;

  return (
    <Panel
      title="ถอน / ดึงผู้เล่นกลับ (Terminate / Restore)"
      description="ผู้อำนวยการถอนผู้เล่นออกจากการแข่งขันเป็นหมู่ได้ และดึงกลับภายหลัง โดยเกมที่ผู้เล่นหายไปจะถูกปรับแพ้ตามแต้มที่กำหนด · ต้องยืนยันด้วยรหัสผ่าน"
    >
      <div className="panel-padding" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Button variant="secondary" size="sm" disabled={active.length === 0} onClick={() => open("terminate")}>
          <UserMinus size={15} />ถอนผู้เล่น (Terminate)
        </Button>
        <Button variant="secondary" size="sm" disabled={terminated.length === 0} onClick={() => open("restore")}>
          <UserPlus size={15} />ดึงผู้เล่นกลับ ({terminated.length})
        </Button>
      </div>

      {terminated.length > 0 && (
        <div className="panel-padding" style={{ paddingTop: 0 }}>
          <p className="muted" style={{ fontSize: 13, marginBottom: 6 }}>ผู้เล่นที่ถูกถอนออก (เก็บไว้ ดึงกลับได้)</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {terminated.map((p) => <span key={p.id} style={{ fontSize: 13, padding: "3px 9px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--muted)" }}>{p.id} · {p.firstName} {p.lastName}</span>)}
          </div>
        </div>
      )}

      {mode && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" style={{ maxWidth: 560 }} onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <div className="confirm-dialog__icon">{mode === "terminate" ? <UserMinus size={20} /> : <RotateCcw size={20} />}</div>
              <div><span>ผู้อำนวยการเท่านั้น</span><h2>{mode === "terminate" ? "ถอนผู้เล่นออกจากการแข่งขัน" : "ดึงผู้เล่นกลับเข้าการแข่งขัน"}</h2></div>
            </header>

            <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 4, margin: "4px 0" }}>
              {(mode === "terminate" ? active : terminated).map((p) => (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                  <input type="checkbox" checked={selected.has(p.id)} disabled={busy} onChange={() => toggle(p.id)} />
                  {label(p)}
                </label>
              ))}
            </div>

            {mode === "terminate" ? (
              <p className="muted" style={{ fontSize: 13 }}>ผู้เล่นที่ถอนออกจะไม่ถูกจับคู่ในเกมถัดไป · ผลและอันดับของเกมที่ผ่านมายังคงอยู่ · หากผู้เล่นยังมีคู่ในเกมปัจจุบันที่ยังไม่กรอกผล ระบบจะไม่ให้ถอนจนกว่าจะกรอกผลคู่นั้นก่อน</p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {restoreCase === "A" && <div className="notice notice--info"><p><span>ผู้เล่นเหล่านี้จะเข้าไปเล่นต่อในเกมที่ <strong>{card.currentGame}</strong> และผลการแข่งขันในเกมที่เขาหายไปจะถูกปรับแพ้เกมละแต้มที่กรอกด้านล่าง</span></p></div>}
                {restoreCase === "B" && (
                  <>
                    <div className="notice notice--warning"><p><span>Pairing เกมปัจจุบัน (เกม {card.currentGame}) ถูกสร้างขึ้นแล้ว ต้องการ <strong>un-pairing</strong> เพื่อนำผู้เล่นเหล่านี้เข้าสู่ pairing ปัจจุบันหรือไม่?</span></p></div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}><input type="radio" name="unpair" checked={unpair} disabled={busy} onChange={() => setUnpair(true)} />Un-pairing แล้วนำเข้าเกมนี้</label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}><input type="radio" name="unpair" checked={!unpair} disabled={busy} onChange={() => setUnpair(false)} />ไม่ต้อง (ปรับแพ้เกมนี้ แล้วเล่นเกมถัดไป)</label>
                    </div>
                  </>
                )}
                {restoreCase === "C" && <div className="notice notice--warning"><p><span>Pairing เกมปัจจุบันมีการกรอกผลแล้ว จึง un-pairing ไม่ได้ · ผู้เล่นจะถูกปรับแพ้ในเกมที่ {card.currentGame} และเกมที่หายไป เกมละแต้มด้านล่าง แล้วกลับมาเล่นในเกมถัดไป</span></p></div>}
                <div className="form-field">
                  <label className="form-label" htmlFor="loss-points">แต้มที่ปรับแพ้ต่อเกมที่หายไป</label>
                  <input className="input" id="loss-points" type="number" min={0} style={{ maxWidth: 160 }} value={lossPoints} disabled={busy} onChange={(e) => setLossPoints(e.target.value)} />
                </div>
              </div>
            )}

            <div className="form-field" style={{ marginTop: 6 }}>
              <label className="form-label" htmlFor="term-password">รหัสผ่านผู้อำนวยการ</label>
              <input className="input" id="term-password" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} placeholder="รหัสผ่านบัญชีของคุณ" />
            </div>
            {error && <p className="form-error">{error}</p>}

            <footer>
              <Button variant="secondary" disabled={busy} onClick={close}>ยกเลิก</Button>
              <Button variant={mode === "terminate" ? "danger" : "primary"} disabled={busy} onClick={() => void submit()}>
                {busy ? <LoaderCircle className="loading-spinner" size={16} /> : mode === "terminate" ? <UserMinus size={16} /> : <UserPlus size={16} />}
                {busy ? "กำลังทำรายการ…" : mode === "terminate" ? `ถอน ${selected.size} คน` : `ดึงกลับ ${selected.size} คน`}
              </Button>
            </footer>
          </section>
        </div>
      )}
    </Panel>
  );
}
