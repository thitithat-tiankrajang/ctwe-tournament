"use client";

import { KeyRound, LockKeyhole, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { selectCardList, useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { isDirector } from "@/domain/tournament/roles";
import type { ManagedUser, Tournament } from "@/domain/tournament/types";
import { CardCreateForm } from "@/ui/components/card-create-form";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { EmptyState } from "@/ui/components/page";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { PromptDialog } from "@/ui/components/prompt-dialog";
import { SelectMenu } from "@/ui/components/select-menu";

interface ConfirmState { title: string; description: string; confirmLabel: string; danger?: boolean; run: () => Promise<unknown>; }
interface PromptState { title: string; label: string; placeholder?: string; type?: "text" | "password"; confirmLabel: string; minLength?: number; run: (value: string) => Promise<unknown>; }

export default function DirectorConsolePage() {
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const listStaff = useTournamentStore((state) => state.listStaff);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const cards = useTournamentStore((state) => state.cards);
  const summaries = useTournamentStore((state) => state.summaries);
  const deleteCard = useTournamentStore((state) => state.deleteCard);
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
  const [sTournament, setSTournament] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const activeCards = useMemo(() => selectCardList(cards, summaries).filter((card) =>
    card.tournamentId === activeTournament?.id && tournaments.some((tournament) => tournament.id === card.tournamentId),
  ), [cards, summaries, activeTournament?.id, tournaments]);

  // Depend on the BOOLEAN, not the auth object — the same defect P3-D1 fixed on /admin.
  // `ensureSessionAlive()` runs on every window focus and stores a fresh AuthState even when nothing
  // changed, so depending on `auth` here re-created this callback and re-fired the effect below,
  // refetching staff and tournaments each time. Measured: 4 requests per refocus.
  const isDirectorUser = isDirector(auth);
  const refresh = useCallback(async () => {
    if (!isDirectorUser) return;
    try {
      const [s, t] = await Promise.all([listStaff(), loadTournaments()]);
      setStaff(s);
      setTournaments(t);
    } catch { /* surfaced via store.error */ }
  }, [isDirectorUser, listStaff, loadTournaments]);

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
      <div className="page-head"><div className="ttl"><span className="eyebrow">คอนโซลผู้อำนวยการ</span><h1>ผู้อำนวยการ</h1></div></div>
      <section className="panel">
        <div className="panel-head"><h2>รายการแข่งขันของคุณ</h2></div>
        {tournaments.length === 0 ? <p className="panel-body meta">ยังไม่ได้รับมอบหมายรายการแข่งขัน</p> :
          <div className="gscroll"><table aria-label="รายการแข่งขันของคุณ" className="dt"><tbody>{tournaments.map((tour) => <tr key={tour.id}>
            <td><b>{tour.name}</b></td><td className="meta">{tour.cardCount} รุ่น</td>
            <td className="n"><button type="button" className="btn btn--sm btn--secondary" onClick={() => {
              setActiveTournament({ id: tour.id, name: tour.name });
              router.push("/cards");
            }}>จัดการ</button></td>
          </tr>)}</tbody></table></div>}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>เพิ่มเจ้าหน้าที่ (Staff)</h2></div>
        <form className="panel-body" onSubmit={(event) => {
          event.preventDefault();
          const username = sUser.trim();
          const selectedTournament = sTournament || activeTournament?.id || tournaments[0]?.id;
          void act(async () => {
            await createStaff(username, sPass);
            setSUser("");
            setSPass("");
            if (!selectedTournament) return;
            try {
              await grantStaffTournament(username, selectedTournament);
            } catch (failure) {
              await refresh();
              throw new Error(`สร้างบัญชีแล้ว แต่ยังมอบหมายรายการแข่งขันไม่สำเร็จ: ${errorMessage(failure)}`);
            }
          });
        }}>
          <div className="form-row">
            <div className="field"><label htmlFor="s-user">ชื่อผู้ใช้</label><input className="input" id="s-user" autoComplete="off"
              value={sUser} onChange={(event) => setSUser(event.target.value)} /></div>
            <div className="field"><label htmlFor="s-pass">รหัสผ่าน</label><FreshSecretInput className="input" id="s-pass" value={sPass} onChange={(event) => setSPass(event.target.value)} /></div>
            <div className="field"><span className="field__label">รายการแข่งขัน</span><SelectMenu className="sm--block" appearance="prototype" ariaLabel="รายการแข่งขัน"
              value={sTournament || activeTournament?.id || tournaments[0]?.id || ""} onChange={setSTournament}
              options={tournaments.map((tour) => ({ value: tour.id, label: tour.name }))} /></div>
            <button type="submit" className="btn btn--primary" disabled={busy || sUser.trim().length < 3 || sPass.length < 8}>เพิ่ม</button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>เจ้าหน้าที่ของคุณ</h2></div>
        {staff.length === 0 ? <p className="panel-body meta">ยังไม่มีเจ้าหน้าที่</p> :
          <div className="gscroll"><table aria-label="เจ้าหน้าที่ของคุณ" className="dt"><tbody>{staff.map((member) => {
            const assigned = member.tournamentIds[0] ?? "";
            return <tr key={member.username}>
              <td><b>{member.username}</b>{!member.enabled && <span className="badge badge--warning">ปิดใช้งาน</span>}</td>
              <td className="meta"><SelectMenu appearance="prototype" ariaLabel={`รายการแข่งขันของ ${member.username}`}
                value={assigned} onChange={(value) => {
                  if (busy || assigned === value) return;
                  if (value) void act(() => grantStaffTournament(member.username, value));
                  else if (assigned) void act(() => revokeStaffTournament(member.username, assigned));
                }} options={[{ value: "", label: "ยังไม่กำหนด" }, ...tournaments.map((tour) => ({ value: tour.id, label: tour.name, disabled: busy }))]} /></td>
              <td className="n"><div className="cellrow prototype-form-end">
                <button type="button" className="btn btn--sm btn--secondary" disabled={busy}
                  onClick={() => act(() => setAccountEnabled("staff", member.username, !member.enabled))}>{member.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button>
                <button type="button" className="btn btn--sm btn--secondary" disabled={busy} aria-label={`ตั้งรหัสผ่านใหม่ให้ ${member.username}`}
                  onClick={() => { setDialogError(""); setPrompt({ title: `ตั้งรหัสผ่านใหม่ · ${member.username}`, label: "รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)", type: "password", minLength: 8, confirmLabel: "บันทึกรหัสผ่าน", run: (password) => resetAccountPassword("staff", member.username, password) }); }}><KeyRound className="i" size={14} /></button>
                <button type="button" className="btn btn--sm btn--ghost" disabled={busy}
                  onClick={() => { setDialogError(""); setConfirm({ title: `ลบเจ้าหน้าที่ ${member.username}?`, description: "บัญชีเจ้าหน้าที่นี้จะถูกลบอย่างถาวร", confirmLabel: "ลบถาวร", danger: true, run: () => deleteStaff(member.username) }); }}>ลบบัญชี</button>
              </div></td>
            </tr>;
          })}</tbody></table></div>}
      </section>

      <CardCreateForm tournaments={tournaments} onCreated={(id, tour) => { setActiveTournament(tour); router.push(`/cards/${id}/players`); }} />

      {activeCards.length > 0 && <section className="panel console-card-management">
        <div className="panel-head"><h2>จัดการการ์ด</h2><span className="desc">{activeTournament?.name}</span></div>
        <div className="gscroll console-card-list"><table aria-label="จัดการการ์ด" className="dt">
          <thead><tr><th scope="col">กีฬา</th><th scope="col">รุ่น</th><th scope="col" className="n">จัดการ</th></tr></thead>
          <tbody>{activeCards.map((card) => <tr key={card.id}><td>{card.name}</td><td>{card.division}</td>
            <td className="n"><button type="button" className="btn btn--sm btn--penalty" disabled={busy}
              aria-label={`ลบการ์ด ${card.name} ${card.division}`} onClick={() => {
                setDialogError("");
                setConfirm({ title: `ลบการ์ด ${card.name} · ${card.division}?`,
                  description: "ผู้เล่น การจับคู่ ผลการแข่งขัน อันดับ และบันทึกกิจกรรมของการ์ดนี้จะถูกลบถาวร",
                  confirmLabel: "ลบการ์ด", danger: true, run: () => deleteCard(card.id) });
              }}><Trash2 className="i" size={14} />ลบการ์ด</button></td>
          </tr>)}</tbody>
        </table></div>
      </section>}

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
