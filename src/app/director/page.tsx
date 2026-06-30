"use client";

import { KeyRound, LockKeyhole, Trash2, Trophy, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTournamentStore } from "@/application/tournament/store";
import { isDirector } from "@/domain/tournament/roles";
import type { ManagedUser, Tournament } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardCreateForm } from "@/ui/components/card-create-form";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

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

  const refresh = useCallback(async () => {
    if (!isDirector(auth)) return;
    try {
      const [s, t] = await Promise.all([listStaff(), loadTournaments()]);
      setStaff(s);
      setTournaments(t);
    } catch { /* surfaced via store.error */ }
  }, [auth, listStaff, loadTournaments]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : "เกิดข้อผิดพลาด"); }
    finally { setBusy(false); }
  };

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
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => { const p = window.prompt("รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)"); if (p) void act(() => resetAccountPassword("staff", s.username, p)); }}><KeyRound size={14} /></Button>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => window.confirm(`ลบเจ้าหน้าที่ ${s.username}?`) && void act(() => deleteStaff(s.username))}><Trash2 size={14} /></Button>
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>เข้าถึงรายการแข่งขัน (ติ๊กแล้วเห็นทุก card ในรายการนั้น):</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
                  {tournaments.length === 0 && <span className="muted" style={{ fontSize: 13 }}>คุณยังไม่ได้รับมอบหมายรายการแข่งขัน</span>}
                  {tournaments.map((t) => {
                    const granted = s.tournamentIds.includes(t.id);
                    return (
                      <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={granted} disabled={busy} onChange={() => act(() => granted ? revokeStaffTournament(s.username, t.id) : grantStaffTournament(s.username, t.id))} />{t.name}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
