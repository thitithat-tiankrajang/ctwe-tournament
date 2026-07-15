"use client";

import { Copy, ExternalLink, FileDown, KeyRound, Link2, Lock, LockKeyhole, LockOpen, Plus, Shield, Trash2, Trophy, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { isAdmin } from "@/domain/tournament/roles";
import type { ManagedUser, Tournament } from "@/domain/tournament/types";
import { copyText } from "@/lib/clipboard";
import { ArchiveList } from "@/ui/components/archive-list";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { PromptDialog } from "@/ui/components/prompt-dialog";
import { RealtimeSettingsPanel } from "@/ui/components/realtime-settings-panel";

interface ConfirmState { title: string; description: string; confirmLabel: string; danger?: boolean; run: () => Promise<unknown>; }
interface PromptState { title: string; description?: string; label: string; placeholder?: string; type?: "text" | "password"; confirmLabel: string; minLength?: number; run: (value: string) => Promise<unknown>; }

export default function AdminConsolePage() {
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const archives = useTournamentStore((state) => state.archives);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const listDirectors = useTournamentStore((state) => state.listDirectors);
  const loadArchives = useTournamentStore((state) => state.loadArchives);
  const createTournament = useTournamentStore((state) => state.createTournament);
  const archiveTournament = useTournamentStore((state) => state.archiveTournament);
  const deleteArchive = useTournamentStore((state) => state.deleteArchive);
  const assignDirector = useTournamentStore((state) => state.assignDirector);
  const unassignDirector = useTournamentStore((state) => state.unassignDirector);
  const createDirector = useTournamentStore((state) => state.createDirector);
  const setAccountEnabled = useTournamentStore((state) => state.setAccountEnabled);
  const resetAccountPassword = useTournamentStore((state) => state.resetAccountPassword);
  const deleteDirector = useTournamentStore((state) => state.deleteDirector);
  const setTournamentStatus = useTournamentStore((state) => state.setTournamentStatus);

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [directors, setDirectors] = useState<ManagedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [tName, setTName] = useState("");
  const [tSlug, setTSlug] = useState("");
  const [dUser, setDUser] = useState("");
  const [dPass, setDPass] = useState("");
  const [dTournaments, setDTournaments] = useState<string[]>([]);
  // Our own confirm/prompt modals replace window.confirm / window.prompt.
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");

  const refresh = useCallback(async () => {
    if (!isAdmin(auth)) return;
    try {
      const [t, d] = await Promise.all([loadTournaments(), listDirectors(), loadArchives()]);
      setTournaments(t);
      setDirectors(d);
    } catch { /* surfaced via store.error */ }
  }, [auth, listDirectors, loadArchives, loadTournaments]);

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

  // The link is the public entry to a tournament; opening/closing it requires the admin's password.
  // Legacy hex tokens also resolve under /tour/, so one link shape serves both generations.
  const tournamentLink = (token: string) =>
    typeof window === "undefined" ? `/tour/${token}` : `${window.location.origin}/tour/${token}`;
  // Viewer URL slug: lowercase letters/digits separated by single dashes, fixed after creation.
  const slugValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tSlug) && tSlug.length >= 3 && tSlug.length <= 64;
  const copyLink = async (token: string) => {
    const ok = await copyText(tournamentLink(token));
    if (ok) toast.success("คัดลอกลิงก์แล้ว"); else toast.error("คัดลอกไม่สำเร็จ — กดค้างที่ลิงก์เพื่อคัดลอกเอง");
  };
  const toggleStatus = (t: Tournament) => {
    const open = t.status !== "OPEN";
    setDialogError("");
    setPrompt({
      title: `${open ? "เปิด" : "ปิด"}การใช้งานลิงก์`,
      description: `ยืนยัน${open ? "เปิด" : "ปิด"}ลิงก์ของ "${t.name}" — ใส่รหัสผ่านผู้ดูแลระบบเพื่อยืนยัน`,
      label: "รหัสผ่านผู้ดูแลระบบ",
      type: "password",
      confirmLabel: open ? "เปิดลิงก์" : "ปิดลิงก์",
      run: (password) => setTournamentStatus(t.id, open, password),
    });
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
        <div className="panel-padding console-stack">
          <div className="console-inline-form">
            <div className="form-field">
              <label className="form-label" htmlFor="t-name">ชื่อรายการแข่งขัน</label>
              <input className="input" id="t-name" value={tName} placeholder="เช่น CTWE 2026" onChange={(e) => setTName(e.target.value)} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="t-slug">ลิงก์เข้าชม (ตั้งแล้วแก้ไม่ได้)</label>
              <input
                className="input"
                id="t-slug"
                value={tSlug}
                placeholder="เช่น bkk-th-ms-championship"
                onChange={(e) => setTSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              />
            </div>
            <Button disabled={busy || tName.trim().length === 0 || !slugValid} onClick={() => act(async () => { await createTournament(tName.trim(), tSlug); setTName(""); setTSlug(""); })}><Plus size={16} />สร้าง Tournament</Button>
          </div>
          <p className="console-note">
            ใช้ a-z, 0-9 และขีดกลางคั่นคำ (3-64 ตัวอักษร) · ลิงก์ถาวร แก้ไขไม่ได้หลังสร้าง
            {tSlug && (slugValid
              ? <> · ผู้ชมจะเข้าที่ <code>{tournamentLink(tSlug)}</code></>
              : <span className="console-note--error"> · รูปแบบลิงก์ยังไม่ถูกต้อง</span>)}
          </p>
        </div>
        <div className="panel-padding console-stack">
          {tournaments.length === 0 && <p className="muted">ยังไม่มีรายการแข่งขัน</p>}
          {tournaments.map((t) => (
            <div key={t.id} className="console-row">
              <div className="console-row__head">
                <strong className="console-row__title"><Trophy size={16} />{t.name}<Badge tone={t.status === "OPEN" ? "success" : "danger"}>{t.status === "OPEN" ? "ลิงก์เปิด" : "ลิงก์ปิด"}</Badge></strong>
                <span className="console-row__actions">
                  <Badge>{t.cardCount} การ์ด</Badge>
                  <Button variant="secondary" size="sm" disabled={busy} title={t.status === "OPEN" ? "ปิดลิงก์ (เข้าไม่ได้)" : "เปิดลิงก์ให้เข้าถึงได้"} onClick={() => toggleStatus(t)}>{t.status === "OPEN" ? <><Lock size={14} />ปิดลิงก์</> : <><LockOpen size={14} />เปิดลิงก์</>}</Button>
                  <Button variant="danger" size="sm" disabled={busy} title="เก็บเป็น Excel แล้วลบข้อมูลออกจากฐานข้อมูลถาวร" onClick={() => setConfirm({ title: `เก็บทัวร์นาเมนต์ "${t.name}" เข้าคลัง?`, description: `ระบบจะเก็บเป็นไฟล์ Excel แล้วลบข้อมูลทั้งหมด (${t.cardCount} การ์ด) ออกจากฐานข้อมูลอย่างถาวร — ไฟล์ยังดาวน์โหลดได้ภายหลัง`, confirmLabel: "เก็บเข้าคลัง", danger: true, run: () => archiveTournament(t.id) })}><FileDown size={14} /> เก็บเข้าคลัง</Button>
                </span>
              </div>
              <div className="console-row__meta">
                <span className="console-hint"><Link2 size={13} />ลิงก์เข้าถึง:</span>
                <code className="console-code">{tournamentLink(t.accessToken)}</code>
                <Button variant="ghost" size="sm" disabled={busy} title="คัดลอกลิงก์" onClick={() => void copyLink(t.accessToken)}><Copy size={14} />คัดลอก</Button>
                <a href={tournamentLink(t.accessToken)} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm" disabled={busy} title="เปิดหน้าสำหรับผู้ชมในแท็บใหม่"><ExternalLink size={14} />เปิดดู</Button></a>
                {t.status !== "OPEN" && <span className="console-note">· ลิงก์ปิดอยู่ ผู้เข้าจะเข้าไม่ได้จนกว่าจะเปิด</span>}
              </div>
              <div className="console-row__meta">
                <span className="console-hint">ผู้อำนวยการ:</span>
                {t.directors.length === 0 && <span className="console-hint">— ยังไม่ได้กำหนด —</span>}
                {t.directors.map((d) => (
                  <Badge key={d} tone="info">{d}
                    <button aria-label={`ถอด ${d}`} className="chip-remove" disabled={busy} onClick={() => act(() => unassignDirector(t.id, d))}>×</button>
                  </Badge>
                ))}
                <select className="select console-select" value="" disabled={busy} onChange={(e) => e.target.value && void act(() => assignDirector(t.id, e.target.value))}>
                  <option value="">+ เพิ่มผู้อำนวยการ…</option>
                  {directors.filter((d) => !t.directors.includes(d.username)).map((d) => <option key={d.username} value={d.username}>{d.username}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="คลังที่เก็บถาวร (Excel)" description="เฉพาะผู้ดูแลระบบเท่านั้นที่ดาวน์โหลดหรือลบไฟล์ Excel ที่เก็บถาวรได้">
        <div className="panel-padding">
          <ArchiveList archives={archives} onDelete={(archive) => setConfirm({ title: `ลบไฟล์เก็บถาวร "${archive.tournamentName}"?`, description: "ไฟล์ Excel นี้จะถูกลบอย่างถาวร — กู้คืนไม่ได้", confirmLabel: "ลบถาวร", danger: true, run: () => deleteArchive(archive.id) })} />
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
            <FreshSecretInput className="input" id="d-pass" value={dPass} onChange={(e) => setDPass(e.target.value)} />
          </div>
        </div>
        <div className="panel-padding panel-padding--flush-top">
          <span className="console-hint">มอบหมาย tournament (เลือกได้หลายรายการ):</span>
          <div className="chip-list">
            {tournaments.map((t) => (
              <label key={t.id} className="checkbox-chip">
                <input type="checkbox" checked={dTournaments.includes(t.id)} onChange={() => toggleDTournament(t.id)} />{t.name}
              </label>
            ))}
          </div>
          <div className="form-actions form-actions--flush">
            <Button disabled={busy || dUser.trim().length < 3 || dPass.length < 8} onClick={() => act(async () => {
              await createDirector(dUser.trim(), dPass, dTournaments);
              setDUser(""); setDPass(""); setDTournaments([]);
            })}><UserPlus size={16} />สร้างผู้อำนวยการ</Button>
          </div>
        </div>
        <div className="panel-padding console-stack">
          {directors.length === 0 && <p className="muted">ยังไม่มีบัญชีผู้อำนวยการ</p>}
          {directors.map((d) => (
            <div key={d.username} className="console-row">
              <div className="console-row__head">
                <strong className="console-row__title"><Shield size={15} />{d.username} {!d.enabled && <Badge tone="warning">ปิดใช้งาน</Badge>}</strong>
                <span className="console-row__actions">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => setAccountEnabled("directors", d.username, !d.enabled))}>{d.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}</Button>
                  <Button variant="secondary" size="sm" disabled={busy} title="ตั้งรหัสผ่านใหม่" onClick={() => { setDialogError(""); setPrompt({ title: `ตั้งรหัสผ่านใหม่ · ${d.username}`, label: "รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)", type: "password", placeholder: "อย่างน้อย 8 ตัวอักษร", minLength: 8, confirmLabel: "บันทึกรหัสผ่าน", run: (p) => resetAccountPassword("directors", d.username, p) }); }}><KeyRound size={14} /></Button>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm({ title: `ลบผู้อำนวยการ ${d.username}?`, description: "บัญชีผู้อำนวยการและ staff ทั้งหมดของเขาจะถูกลบอย่างถาวร", confirmLabel: "ลบถาวร", danger: true, run: () => deleteDirector(d.username) })}><Trash2 size={14} /></Button>
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* Infra tuning sits last — it is not part of the day-to-day tournament content flow. */}
      <RealtimeSettingsPanel />

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
        description={prompt?.description}
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
