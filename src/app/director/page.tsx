"use client";

import { KeyRound, LockKeyhole, Trash2, Trophy, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { isDirector } from "@/domain/tournament/roles";
import type { ManagedUser, Tournament } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardCreateForm } from "@/ui/components/card-create-form";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { PromptDialog } from "@/ui/components/prompt-dialog";

interface ConfirmState { title: string; description: string; confirmLabel: string; danger?: boolean; run: () => Promise<unknown>; }
interface PromptState { title: string; label: string; placeholder?: string; type?: "text" | "password"; confirmLabel: string; minLength?: number; run: (value: string) => Promise<unknown>; }

export default function DirectorConsolePage() {
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const listStaff = useTournamentStore((state) => state.listStaff);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const createStaff = useTournamentStore((state) => state.createStaff);
  const setAccountEnabled = useTournamentStore((state) => state.setAccountEnabled);
  const resetAccountPassword = useTournamentStore((state) => state.resetAccountPassword);
  const deleteStaff = useTournamentStore((state) => state.deleteStaff);
  const grantStaffTournament = useTournamentStore((state) => state.grantStaffTournament);
  const revokeStaffTournament = useTournamentStore((state) => state.revokeStaffTournament);
  const router = useRouter();

  const [staff, setStaff] = useState<ManagedUser[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [busy, setBusy] = useState(false);
  const [sUser, setSUser] = useState("");
  const [sPass, setSPass] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");

  const refresh = useCallback(async () => {
    if (!isDirector(auth)) return;
    try {
      const [s, t] = await Promise.all([listStaff(), loadTournaments()]);
      setStaff(s);
      setTournaments(t);
    } catch { /* surfaced via store.error */ }
  }, [auth, listStaff, loadTournaments]);

  useEffect(() => { void refresh(); }, [refresh]);

  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "เกิดข้อผิดพลาด";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const submitConfirm = async () => {
    if (!confirm) return;
    setDialogBusy(true); setDialogError("");
    try { await confirm.run(); await refresh(); setConfirm(null); }
    catch (error) { setDialogError(errorMessage(error)); }
    finally { setDialogBusy(false); }
  };
  const submitPrompt = async (value: string) => {
    if (!prompt) return;
    setDialogBusy(true); setDialogError("");
    try { await prompt.run(value); await refresh(); setPrompt(null); }
    catch (error) { setDialogError(errorMessage(error)); }
    finally { setDialogBusy(false); }
  };
  const closeDialogs = () => { if (!dialogBusy) { setConfirm(null); setPrompt(null); setDialogError(""); } };

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!isDirector(auth)) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับผู้อำนวยการเท่านั้น" description="หน้านี้ใช้จัดการบัญชีเจ้าหน้าที่กรอกผล (Staff)" /></div>;
  }

  return (
    <>
      <PageHeader eyebrow="Director console" title="ผู้อำนวยการ" description="จัดการบัญชีเจ้าหน้าที่กรอกผลของคุณ — staff ทำได้เฉพาะกรอกผลและลงทะเบียนผู้เล่นตามขั้นตอน" actions={<Badge tone="info">DIRECTOR</Badge>} />

      <Panel title="รายการแข่งขันของคุณ" description="รายการที่ผู้ดูแลระบบมอบหมายให้คุณ">
        <div className="panel-padding" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tournaments.length === 0 && <p className="muted">ยังไม่ได้รับมอบหมายรายการแข่งขัน — ติดต่อผู้ดูแลระบบ</p>}
          {tournaments.map((t) => <Badge key={t.id} tone="info"><Trophy size={13} /> {t.name} · {t.cardCount} การ์ด</Badge>)}
        </div>
      </Panel>

      <div style={{ marginTop: 18 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>สร้างการ์ดการแข่งขัน (Card)</h2>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 14 }}>ผู้อำนวยการสร้างการ์ดได้ที่นี่ — เลือกรายการแข่งขัน (tournament) ที่จะสร้างการ์ดเข้าไป</p>
        <CardCreateForm tournaments={tournaments} onCreated={(id, tour) => { setActiveTournament(tour); router.push(`/cards/${id}/players`); }} />
      </div>

      <Panel title="เพิ่มเจ้าหน้าที่ (Staff)" description="staff จะกรอกผลได้ทุกการ์ดในรายการแข่งขันของคุณ">
        <div className="panel-padding form-grid">
          <div className="form-field">
            <label className="form-label" htmlFor="s-user">ชื่อผู้ใช้</label>
            <input className="input" id="s-user" value={sUser} placeholder="staff01" onChange={(e) => setSUser(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-pass">รหัสผ่าน (อย่างน้อย 8 ตัว)</label>
            <input className="input" id="s-pass" type="password" value={sPass} onChange={(e) => setSPass(e.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <Button disabled={busy || sUser.trim().length < 3 || sPass.length < 8} onClick={() => act(async () => {
            await createStaff(sUser.trim(), sPass);
            setSUser(""); setSPass("");
          })}><UserPlus size={16} />สร้างเจ้าหน้าที่</Button>
        </div>
      </Panel>

      <Panel title="เจ้าหน้าที่ของคุณ" description="">
        <div className="panel-padding" style={{ display: "grid", gap: 8 }}>
          {staff.length === 0 && <p className="muted">ยังไม่มีเจ้าหน้าที่</p>}
          {staff.map((s) => (
            <div key={s.username} className="notice" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ display: "flex", alignItems: "center", gap: 8 }}><Users size={15} />{s.username} {!s.enabled && <Badge tone="warning">ปิดใช้งาน</Badge>}</strong>
                <span style={{ display: "flex", gap: 6 }}>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => setAccountEnabled("staff", s.username, !s.enabled))}>{s.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}</Button>
                  <Button variant="secondary" size="sm" disabled={busy} title="ตั้งรหัสผ่านใหม่" onClick={() => { setDialogError(""); setPrompt({ title: `ตั้งรหัสผ่านใหม่ · ${s.username}`, label: "รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)", type: "password", placeholder: "อย่างน้อย 8 ตัวอักษร", minLength: 8, confirmLabel: "บันทึกรหัสผ่าน", run: (p) => resetAccountPassword("staff", s.username, p) }); }}><KeyRound size={14} /></Button>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm({ title: `ลบเจ้าหน้าที่ ${s.username}?`, description: "บัญชีเจ้าหน้าที่นี้จะถูกลบอย่างถาวร", confirmLabel: "ลบถาวร", danger: true, run: () => deleteStaff(s.username) })}><Trash2 size={14} /></Button>
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>รายการแข่งขันของเจ้าหน้าที่ (เลือกได้ 1 รายการ — เห็นทุก card ในรายการนั้น):</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
                  {tournaments.length === 0 && <span className="muted" style={{ fontSize: 13 }}>คุณยังไม่ได้รับมอบหมายรายการแข่งขัน</span>}
                  {tournaments.map((t) => {
                    const granted = s.tournamentIds.includes(t.id);
                    return (
                      <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="radio" name={`staff-tour-${s.username}`} checked={granted} disabled={busy} onChange={() => act(() => grantStaffTournament(s.username, t.id))} />{t.name}
                      </label>
                    );
                  })}
                  {tournaments.length > 0 && (
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="radio" name={`staff-tour-${s.username}`} checked={s.tournamentIds.length === 0} disabled={busy} onChange={() => { const current = s.tournamentIds[0]; if (current) void act(() => revokeStaffTournament(s.username, current)); }} />ไม่กำหนด
                    </label>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.confirmLabel ?? "ยืนยัน"}
        danger={confirm?.danger}
        busy={dialogBusy}
        error={dialogError || undefined}
        onConfirm={() => void submitConfirm()}
        onCancel={closeDialogs}
      />
      <PromptDialog
        open={prompt !== null}
        title={prompt?.title ?? ""}
        label={prompt?.label ?? ""}
        placeholder={prompt?.placeholder}
        type={prompt?.type}
        confirmLabel={prompt?.confirmLabel ?? "ยืนยัน"}
        minLength={prompt?.minLength}
        busy={dialogBusy}
        error={dialogError || undefined}
        onSubmit={(value) => void submitPrompt(value)}
        onCancel={closeDialogs}
      />
    </>
  );
}
