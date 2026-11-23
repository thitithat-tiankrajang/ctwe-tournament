"use client";

import { Copy, ExternalLink, FileDown, KeyRound, ListChecks, Lock, LockKeyhole, Settings2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { isAdmin } from "@/domain/tournament/roles";
import type { ManagedUser, PublicSnapshotStatus, ShutdownReadiness, Tournament } from "@/domain/tournament/types";
import { copyText } from "@/lib/clipboard";
import { ArchiveList } from "@/ui/components/archive-list";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { EmptyState } from "@/ui/components/page";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { PromptDialog } from "@/ui/components/prompt-dialog";
import { RealtimeSettingsPanel } from "@/ui/components/realtime-settings-panel";
import { SportColorsPanel } from "@/ui/components/sport-colors-panel";
import { ACKNOWLEDGMENT_REV, SnapshotPublicationPanel } from "@/ui/components/snapshot-publication-panel";
import { ShutdownReadinessPanel } from "@/ui/components/shutdown-readiness-panel";

interface ConfirmState { title: string; description: string; confirmLabel: string; danger?: boolean; run: () => Promise<unknown>; }
interface PromptState { title: string; description?: string; label: string; placeholder?: string; type?: "text" | "password"; confirmLabel: string; minLength?: number; danger?: boolean; confirmationPhrase?: string; confirmationLabel?: string; secondaryConfirmLabel?: string; runSecondary?: (value: string) => Promise<unknown>; run: (value: string) => Promise<unknown>; }

export default function AdminConsolePage() {
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const archives = useTournamentStore((state) => state.archives);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
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
  const approveSnapshot = useTournamentStore((state) => state.approveSnapshot);
  const retractSnapshot = useTournamentStore((state) => state.retractSnapshot);
  const shelveTournament = useTournamentStore((state) => state.shelveTournament);

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  /** Snapshot state per tournament, reported by each row's panel — read by the close dialog (§4.6). */
  const [snapshotStates, setSnapshotStates] = useState<Record<string, PublicSnapshotStatus>>({});
  const [directors, setDirectors] = useState<ManagedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCreateTournament, setShowCreateTournament] = useState(false);
  const [showCreateDirector, setShowCreateDirector] = useState(false);
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

  // Depend on the BOOLEAN, not the auth object. `ensureSessionAlive()` runs on every window focus
  // and stores a fresh AuthState object even when nothing changed; depending on `auth` here made
  // this callback — and therefore the effect below — new on every focus, refetching tournaments,
  // directors and archives each time. Measured: 7 requests per refocus.
  const isAdminUser = isAdmin(auth);
  const refresh = useCallback(async () => {
    if (!isAdminUser) return;
    try {
      const [t, d] = await Promise.all([loadTournaments(), listDirectors(), loadArchives()]);
      setTournaments(t);
      setDirectors(d);
    } catch { /* surfaced via store.error */ }
  }, [isAdminUser, listDirectors, loadArchives, loadTournaments]);

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
  const submitPrompt = async (value: string, secondary = false) => {
    if (!prompt) return;
    const action = secondary ? prompt.runSecondary : prompt.run;
    if (!action) return;
    setDialogBusy(true); setDialogError("");
    try { await action(value); await refresh(); setPrompt(null); }
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
    // Architecture §4.6: CLOSED cannot gate a credential-free CDN object, so the two controls are
    // surfaced together rather than pretending closing the link hides a published snapshot. The
    // dialog says so plainly and offers the combined action in one click.
    const publiclyVisible = !open && snapshotStates[t.id]?.state === "PUBLISHED";
    setDialogError("");
    setPrompt({
      title: `${open ? "เปิด" : "ปิด"}การใช้งานลิงก์`,
      description: publiclyVisible
        ? `ทัวร์นาเมนต์นี้มีฉบับเผยแพร่สาธารณะอยู่ — การปิดลิงก์จะไม่ลบฉบับเผยแพร่ ต้องการถอนการเผยแพร่ด้วยหรือไม่?`
        : `ยืนยัน${open ? "เปิด" : "ปิด"}ลิงก์ของ "${t.name}" — ใส่รหัสผ่านผู้ดูแลระบบเพื่อยืนยัน`,
      label: "รหัสผ่านผู้ดูแลระบบ",
      type: "password",
      confirmLabel: publiclyVisible ? "ปิดลิงก์อย่างเดียว" : open ? "เปิดลิงก์" : "ปิดลิงก์",
      secondaryConfirmLabel: publiclyVisible ? "ปิดลิงก์และถอนการเผยแพร่" : undefined,
      runSecondary: publiclyVisible
        ? async (password: string) => {
            await setTournamentStatus(t.id, open, password);
            const retracted = await retractSnapshot(t.id);
            setSnapshotStates((current) => ({ ...current, [t.id]: retracted }));
          }
        : undefined,
      run: (password) => setTournamentStatus(t.id, open, password),
    });
  };

  /**
   * ⚠️ Excel Export & Purge — exports to .xlsx and then PERMANENTLY DELETES the tournament's data.
   * This is not "publishing" anything: it is the delete path. Two guards before it runs — the admin
   * retypes the tournament name, and re-enters their password (the backend verifies both).
   */
  const exportAndPurge = (t: Tournament) => {
    setDialogError("");
    setPrompt({
      title: `ส่งออก Excel แล้วลบ "${t.name}" ถาวร?`,
      description: `ระบบจะเก็บเป็นไฟล์ Excel แล้วลบข้อมูลทั้งหมด (${t.cardCount} การ์ด) ออกจากฐานข้อมูลอย่างถาวร — กู้คืนไม่ได้ ไฟล์ Excel ยังดาวน์โหลดได้ภายหลัง`,
      label: "รหัสผ่านผู้ดูแลระบบ",
      type: "password",
      confirmLabel: "ส่งออกและลบถาวร",
      danger: true,
      confirmationPhrase: t.name,
      confirmationLabel: "พิมพ์ชื่อรายการแข่งขันให้ตรงเพื่อยืนยันการลบ",
      run: (password) => archiveTournament(t.id, password, t.name),
    });
  };

  /**
   * Approve public publication (architecture §4.1 step one). Reuses the same two guards as the purge
   * dialog — retype the name, re-enter the password — because this is the other decision in this
   * console that cannot be taken back. The acknowledgment text itself is shown in the row's panel,
   * above the button that opens this dialog, and its revision travels with the approval.
   */
  const approvePublication = (t: Tournament, onDone: (status: PublicSnapshotStatus) => void) => {
    setDialogError("");
    setPrompt({
      title: `อนุมัติเผยแพร่ "${t.name}" สู่สาธารณะ?`,
      description: "การเผยแพร่เป็นการถาวรและเรียกคืนไม่ได้ — โปรดอ่านข้อตกลงในแถวรายการก่อนยืนยัน การอนุมัติมีอายุ 7 วัน และจะใช้ไม่ได้ทันทีหากข้อมูลการ์ดเปลี่ยนแปลง",
      label: "รหัสผ่านผู้ดูแลระบบ",
      type: "password",
      confirmLabel: "ยืนยันการอนุมัติ",
      confirmationPhrase: t.name,
      confirmationLabel: "พิมพ์ชื่อรายการแข่งขันให้ตรงเพื่อยืนยัน",
      run: async (password) => onDone(await approveSnapshot(t.id, password, t.name, ACKNOWLEDGMENT_REV)),
    });
  };

  /**
   * Shelving says "this tournament will never be published", which is what lets a shutdown proceed
   * without its results ever becoming public (architecture §19.1). Reversible, but deliberate — so
   * it takes the same password re-auth as every other tournament-level state change here.
   */
  const shelveForShutdown = (tournamentId: string, name: string, onDone: (readiness: ShutdownReadiness) => void) => {
    setDialogError("");
    setPrompt({
      title: `ระบุว่า "${name}" จะไม่ถูกเผยแพร่?`,
      description: "รายการนี้จะไม่ค้างเงื่อนไขการปิดระบบอีกต่อไป ผลการแข่งขันจะไม่ถูกเผยแพร่สู่สาธารณะ — ย้อนกลับได้ภายหลัง",
      label: "รหัสผ่านผู้ดูแลระบบ",
      type: "password",
      confirmLabel: "ยืนยัน",
      run: async (password) => onDone(await shelveTournament(tournamentId, password)),
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
      <div className="page-head"><div className="ttl"><span className="eyebrow">Platform admin</span><h1>ผู้ดูแลระบบ</h1></div></div>
      <SportColorsPanel tournaments={tournaments} />
      <section className="panel">
        <div className="panel-head"><h2>รายการแข่งขัน (Tournaments)</h2><span className="actions">
          <button type="button" className="btn btn--sm btn--primary" aria-expanded={showCreateTournament}
            onClick={() => setShowCreateTournament(!showCreateTournament)}>สร้างรายการแข่งขัน</button>
        </span></div>
        {showCreateTournament && <form className="panel-body" onSubmit={(event) => {
          event.preventDefault();
          if (!slugValid || !tName.trim()) return;
          void act(async () => {
            await createTournament(tName.trim(), tSlug);
            setTName(""); setTSlug(""); setShowCreateTournament(false);
          });
        }}>
          <div className="form-row">
            <div className="field"><label htmlFor="t-name">ชื่อรายการแข่งขัน</label>
              <input className="input" id="t-name" value={tName} placeholder="เช่น CTWE 2026" onChange={(event) => setTName(event.target.value)} required /></div>
            <div className="field"><label htmlFor="t-slug">ลิงก์เข้าชม</label>
              <input className="input" id="t-slug" value={tSlug} placeholder="เช่น ctwe-2026"
                onChange={(event) => setTSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required /></div>
            <button type="submit" className="btn btn--primary" disabled={busy || !tName.trim() || !slugValid}>สร้างรายการแข่งขัน</button>
          </div>
          <p className="meta">ใช้ a-z, 0-9 และขีดกลางคั่นคำ 3–64 ตัวอักษร ลิงก์นี้แก้ไขหลังสร้างไม่ได้</p>
        </form>}
        {tournaments.length === 0 ? <p className="panel-body meta">ยังไม่มีรายการแข่งขัน</p> : <div className="gscroll"><table aria-label="รายการแข่งขันของระบบ" className="dt prototype-admin-table">
          <thead><tr><th scope="col">รายการ</th><th scope="col">ลิงก์สาธารณะ</th><th scope="col">ฉบับสาธารณะ</th><th scope="col">เครื่องมือ</th></tr></thead>
          <tbody>{tournaments.map((tour) => {
            const published = snapshotStates[tour.id]?.state === "PUBLISHED";
            return <tr key={tour.id}>
              <td><b>{tour.name}</b><div className="meta">{tour.cardCount} รุ่น</div></td>
              <td><div className="cellrow">
                <span className={`badge badge--${tour.status === "OPEN" ? "success" : "neutral"}`}>{tour.status === "OPEN" ? "เปิดอยู่" : "ปิดอยู่"}</span>
                <button type="button" className="btn btn--sm btn--secondary" disabled={busy} onClick={() => toggleStatus(tour)}>
                  {tour.status === "OPEN" ? "ปิดลิงก์" : "เปิดลิงก์"}<Lock className="i" size={12} />
                </button>
              </div></td>
              <td><div className="cellrow"><span className={`badge badge--${published ? "success" : "neutral"}`}>
                {published ? "เผยแพร่แล้ว" : "ยังไม่เผยแพร่"}
              </span></div>
                <details className="prototype-console-details">
                  <summary>จัดการฉบับเผยแพร่</summary>
                  <SnapshotPublicationPanel tournament={tour} busy={busy} onApprove={approvePublication} onError={(message) => toast.error(message)}
                    onStatus={(id, status) => setSnapshotStates((current) => ({ ...current, [id]: status }))} />
                </details>
              </td>
              <td><div className="cellrow">
                <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void copyLink(tour.accessToken)}><Copy className="i" size={12} />คัดลอกลิงก์</button>
                <a className="btn btn--sm btn--ghost" href={tournamentLink(tour.accessToken)} target="_blank" rel="noreferrer"><ExternalLink className="i" size={12} />เปิดหน้า viewer</a>
                <Link className="btn btn--sm btn--ghost" href="/cards" prefetch={false} onClick={() => setActiveTournament({ id: tour.id, name: tour.name })}><ListChecks className="i" size={12} />ตรวจการ์ด</Link>
                <a className="btn btn--sm btn--ghost" href="#shutdown-readiness"><Settings2 className="i" size={12} />ความพร้อมปิดระบบ</a>
                <button type="button" className="btn btn--sm btn--penalty" disabled={busy} onClick={() => exportAndPurge(tour)}><FileDown className="i" size={12} />เก็บเข้าคลัง<Lock className="i" size={12} /></button>
              </div>
                <details className="prototype-console-details">
                  <summary>ผู้อำนวยการ</summary>
                  <div className="cellrow">
                    {tour.directors.map((username) => <span className="badge badge--info" key={username}>{username}<button type="button" className="chip-remove"
                      aria-label={`ถอด ${username}`} disabled={busy} onClick={() => act(() => unassignDirector(tour.id, username))}>×</button></span>)}
                    <select className="select console-select" aria-label={`เพิ่มผู้อำนวยการสำหรับ ${tour.name}`} value="" disabled={busy}
                      onChange={(event) => { if (event.target.value) void act(() => assignDirector(tour.id, event.target.value)); }}>
                      <option value="">+ เพิ่มผู้อำนวยการ…</option>
                      {directors.filter((director) => !tour.directors.includes(director.username)).map((director) =>
                        <option key={director.username} value={director.username}>{director.username}</option>)}
                    </select>
                  </div>
                </details>
              </td>
            </tr>;
          })}</tbody>
        </table></div>}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>ไฟล์ Excel ที่ส่งออกแล้ว</h2></div>
        <ArchiveList archives={archives} onDelete={(archive) => setConfirm({ title: `ลบไฟล์ Excel “${archive.tournamentName}”?`,
          description: "ไฟล์ Excel นี้จะถูกลบอย่างถาวร", confirmLabel: "ลบถาวร", danger: true, run: () => deleteArchive(archive.id) })} />
      </section>

      <section className="panel">
        <div className="panel-head"><h2>บัญชีผู้อำนวยการ (Directors)</h2><span className="actions"><button className="btn btn--sm btn--primary" type="button"
          aria-expanded={showCreateDirector} onClick={() => setShowCreateDirector(!showCreateDirector)}>เพิ่มผู้อำนวยการ</button></span></div>
        {showCreateDirector && <form className="panel-body" onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await createDirector(dUser.trim(), dPass, dTournaments);
            setDUser(""); setDPass(""); setDTournaments([]); setShowCreateDirector(false);
          });
        }}>
          <div className="form-row">
            <div className="field"><label htmlFor="d-user">ชื่อผู้ใช้</label>
              <input className="input" id="d-user" value={dUser} onChange={(event) => setDUser(event.target.value)} required /></div>
            <div className="field"><label htmlFor="d-pass">รหัสผ่าน</label>
              <FreshSecretInput className="input" id="d-pass" value={dPass} onChange={(event) => setDPass(event.target.value)} required /></div>
          </div>
          <fieldset className="fs"><legend>รายการแข่งขัน</legend><div className="chip-list">
            {tournaments.map((tour) => <label className="checkbox-chip" key={tour.id}>
              <input type="checkbox" checked={dTournaments.includes(tour.id)} onChange={() => toggleDTournament(tour.id)} />{tour.name}
            </label>)}
          </div></fieldset>
          <div className="form-row prototype-form-end"><button className="btn btn--primary" type="submit" disabled={busy || dUser.trim().length < 3 || dPass.length < 8}>เพิ่มผู้อำนวยการ</button></div>
        </form>}
        {directors.length === 0 ? <p className="panel-body meta">ยังไม่มีบัญชีผู้อำนวยการ</p> : <div className="gscroll"><table aria-label="บัญชีผู้อำนวยการ" className="dt"><tbody>
          {directors.map((director) => <tr key={director.username}>
            <td><b>{director.username}</b>{!director.enabled && <span className="badge badge--warning">ปิดใช้งาน</span>}</td>
            <td className="meta">{director.tournamentIds.length} รายการแข่งขัน</td>
            <td className="n"><div className="cellrow prototype-form-end">
              <button type="button" className="btn btn--sm btn--secondary" disabled={busy}
                onClick={() => act(() => setAccountEnabled("directors", director.username, !director.enabled))}>{director.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button>
              <button type="button" className="btn btn--sm btn--secondary" disabled={busy} aria-label={`ตั้งรหัสผ่านใหม่ให้ ${director.username}`}
                onClick={() => { setDialogError(""); setPrompt({ title: `ตั้งรหัสผ่านใหม่ · ${director.username}`,
                  label: "รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)", type: "password", minLength: 8, confirmLabel: "บันทึกรหัสผ่าน",
                  run: (password) => resetAccountPassword("directors", director.username, password) }); }}><KeyRound className="i" size={14} /></button>
              <button type="button" className="btn btn--sm btn--penalty" disabled={busy} aria-label={`ลบ ${director.username}`}
                onClick={() => setConfirm({ title: `ลบผู้อำนวยการ ${director.username}?`, description: "บัญชีผู้อำนวยการและ Staff ของบัญชีนี้จะถูกลบถาวร",
                  confirmLabel: "ลบถาวร", danger: true, run: () => deleteDirector(director.username) })}><Trash2 className="i" size={14} /></button>
            </div></td>
          </tr>)}
        </tbody></table></div>}
      </section>

      <RealtimeSettingsPanel />
      <div id="shutdown-readiness"><ShutdownReadinessPanel busy={busy} onShelve={shelveForShutdown} onError={(message) => toast.error(message)} /></div>

      <ConfirmDialog appearance="prototype"
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
      <PromptDialog appearance="prototype"
        open={prompt !== null}
        title={prompt?.title ?? ""}
        description={prompt?.description}
        label={prompt?.label ?? ""}
        placeholder={prompt?.placeholder}
        type={prompt?.type}
        confirmLabel={prompt?.confirmLabel ?? "ยืนยัน"}
        minLength={prompt?.minLength}
        danger={prompt?.danger}
        confirmationPhrase={prompt?.confirmationPhrase}
        confirmationLabel={prompt?.confirmationLabel}
        busy={dialogBusy}
        error={dialogError || undefined}
        secondaryConfirmLabel={prompt?.secondaryConfirmLabel}
        onSecondarySubmit={prompt?.runSecondary ? (value) => void submitPrompt(value, true) : undefined}
        onSubmit={(value) => void submitPrompt(value)}
        onCancel={closeDialogs}
      />
    </>
  );
}
