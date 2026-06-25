"use client";

import { KeyRound, LockKeyhole, Plus, Shield, Trash2, Trophy, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { isAdmin } from "@/domain/tournament/roles";
import type { ManagedUser, Tournament } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

export default function AdminConsolePage() {
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const store = useTournamentStore();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [directors, setDirectors] = useState<ManagedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [tName, setTName] = useState("");
  const [dUser, setDUser] = useState("");
  const [dPass, setDPass] = useState("");
  const [dTournaments, setDTournaments] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!isAdmin(auth)) return;
    try {
      const [t, d] = await Promise.all([store.loadTournaments(), store.listDirectors()]);
      setTournaments(t);
      setDirectors(d);
    } catch { /* surfaced via store.error */ }
  }, [auth, store]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : "เกิดข้อผิดพลาด"); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!isAdmin(auth)) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับผู้ดูแลระบบเท่านั้น" description="หน้านี้ใช้จัดการรายการแข่งขันและบัญชีผู้อำนวยการ (Director)" /></div>;
  }

  const toggleDTournament = (id: string) =>
    setDTournaments((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);

  return (
    <>
      <PageHeader eyebrow="Platform admin" title="ผู้ดูแลระบบ" description="สร้างรายการแข่งขัน สร้างบัญชีผู้อำนวยการ และกำหนดสิทธิ์ให้แต่ละ tournament" actions={<Badge tone="warning">ADMIN ONLY</Badge>} />

      <Panel title="รายการแข่งขัน (Tournaments)" description="เฉพาะผู้ดูแลระบบเท่านั้นที่สร้าง/ลบรายการแข่งขันได้">
        <div className="panel-padding" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="form-field" style={{ flex: 1, minWidth: 240 }}>
            <label className="form-label" htmlFor="t-name">ชื่อรายการแข่งขัน</label>
            <input className="input" id="t-name" value={tName} placeholder="เช่น CTWE 2026" onChange={(e) => setTName(e.target.value)} />
          </div>
          <Button disabled={busy || tName.trim().length === 0} onClick={() => act(async () => { await store.createTournament(tName.trim()); setTName(""); })}><Plus size={16} />สร้าง Tournament</Button>
        </div>
        <div className="panel-padding" style={{ display: "grid", gap: 12 }}>
          {tournaments.length === 0 && <p className="muted">ยังไม่มีรายการแข่งขัน</p>}
          {tournaments.map((t) => (
            <div key={t.id} className="notice" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ display: "flex", alignItems: "center", gap: 8 }}><Trophy size={16} />{t.name}</strong>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Badge>{t.cardCount} การ์ด</Badge>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => window.confirm(`ลบ "${t.name}" และการ์ดทั้งหมดในรายการนี้?`) && void act(() => store.deleteTournament(t.id))}><Trash2 size={14} /></Button>
                </span>
              </div>
              <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <span className="muted" style={{ fontSize: 13 }}>ผู้อำนวยการ:</span>
                {t.directors.length === 0 && <span className="muted" style={{ fontSize: 13 }}>— ยังไม่ได้กำหนด —</span>}
                {t.directors.map((d) => (
                  <Badge key={d} tone="info">{d}
                    <button aria-label={`ถอด ${d}`} className="chip-remove" disabled={busy} onClick={() => act(() => store.unassignDirector(t.id, d))}>×</button>
                  </Badge>
                ))}
                <select className="select" style={{ maxWidth: 220 }} value="" disabled={busy} onChange={(e) => e.target.value && void act(() => store.assignDirector(t.id, e.target.value))}>
                  <option value="">+ เพิ่มผู้อำนวยการ…</option>
                  {directors.filter((d) => !t.directors.includes(d.username)).map((d) => <option key={d.username} value={d.username}>{d.username}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="บัญชีผู้อำนวยการ (Directors)" description="ผู้อำนวยการจัดการ staff และดำเนินการแข่งขันใน tournament ที่ได้รับมอบหมาย">
        <div className="panel-padding form-grid">
          <div className="form-field">
            <label className="form-label" htmlFor="d-user">ชื่อผู้ใช้</label>
            <input className="input" id="d-user" value={dUser} placeholder="director01" onChange={(e) => setDUser(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="d-pass">รหัสผ่าน (อย่างน้อย 8 ตัว)</label>
            <input className="input" id="d-pass" type="password" value={dPass} onChange={(e) => setDPass(e.target.value)} />
          </div>
        </div>
        <div className="panel-padding" style={{ paddingTop: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>มอบหมาย tournament (เลือกได้หลายรายการ):</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {tournaments.map((t) => (
              <label key={t.id} className="checkbox-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={dTournaments.includes(t.id)} onChange={() => toggleDTournament(t.id)} />{t.name}
              </label>
            ))}
          </div>
          <div className="form-actions" style={{ paddingLeft: 0 }}>
            <Button disabled={busy || dUser.trim().length < 3 || dPass.length < 8} onClick={() => act(async () => {
              await store.createDirector(dUser.trim(), dPass, dTournaments);
              setDUser(""); setDPass(""); setDTournaments([]);
            })}><UserPlus size={16} />สร้างผู้อำนวยการ</Button>
          </div>
        </div>
        <div className="panel-padding" style={{ display: "grid", gap: 8 }}>
          {directors.length === 0 && <p className="muted">ยังไม่มีบัญชีผู้อำนวยการ</p>}
          {directors.map((d) => (
            <div key={d.username} className="notice" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <strong style={{ display: "flex", alignItems: "center", gap: 8 }}><Shield size={15} />{d.username} {!d.enabled && <Badge tone="warning">ปิดใช้งาน</Badge>}</strong>
              <span style={{ display: "flex", gap: 6 }}>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => store.setAccountEnabled("directors", d.username, !d.enabled))}>{d.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { const p = window.prompt("รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)"); if (p) void act(() => store.resetAccountPassword("directors", d.username, p)); }}><KeyRound size={14} /></Button>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => window.confirm(`ลบผู้อำนวยการ ${d.username} และ staff ทั้งหมดของเขา?`) && void act(() => store.deleteDirector(d.username))}><Trash2 size={14} /></Button>
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
