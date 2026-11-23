"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowRight, LockKeyhole, Save, Trash2, Undo2, Upload, UserPlus } from "lucide-react";
import { useState } from "react";
import { appDialog } from "@/application/ui/dialog";
import { toast } from "@/application/ui/toast";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { comparePlayerCodes, matchesPlayerCode } from "@/domain/tournament/player-code";
import { canManageTournament, hasStaffAccess } from "@/domain/tournament/roles";
import { playerSchema, type PlayerForm } from "@/domain/tournament/schemas";
import type { Player } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { ExcelPlayerImport } from "@/ui/components/excel-player-import";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { InstitutionCombobox } from "@/ui/components/institution-combobox";
import { EmptyState } from "@/ui/components/page";
import { PairingToolButtons, canOpenScreening } from "@/ui/components/pairing-tool";
import { PlayerTermination } from "@/ui/components/player-termination";
import { ReopenRegistration } from "@/ui/components/reopen-registration";
import { useWorkspaceListFilter, WorkspaceListFilter, WorkspaceListToolbar } from "@/ui/components/workspace-list-filter";
import { useNavigateWithPending } from "@/ui/layout/use-navigate-with-pending";

const fields = { firstName: "ชื่อ", lastName: "นามสกุล", school: "โรงเรียน/สถาบัน" } as const;
const fieldKeys = Object.keys(fields) as (keyof PlayerForm)[];
const details = ({ firstName, lastName, school }: Player): PlayerForm => ({ firstName, lastName, school });
type Draft = { before: PlayerForm; after: PlayerForm; displayName: string };

const displayName = ({ firstName, lastName }: PlayerForm) => `${firstName} ${lastName}`;
const splitName = (value: string, previous?: PlayerForm) => {
  const full = value.trim();
  const originalFirst = previous?.firstName.trim();
  const originalLast = previous?.lastName.trim();
  if (originalFirst && full.startsWith(`${originalFirst} `)) return { firstName: originalFirst, lastName: full.slice(originalFirst.length).trim() };
  if (originalLast && full.endsWith(` ${originalLast}`)) return { firstName: full.slice(0, -(originalLast.length + 1)), lastName: originalLast };
  const boundary = full.search(/\s/);
  return boundary < 0 ? { firstName: full, lastName: "" } : { firstName: full.slice(0, boundary), lastName: full.slice(boundary).trim() };
};
type Review = { kind: "edit"; changes: [string, Draft][] } | { kind: "delete"; player: Player };

export default function PlayersPage() {
  const { id } = useParams<{ id: string }>();
  const { pending: navPending, navigate } = useNavigateWithPending();
  const card = useTournamentStore((state) => selectCard(state.cards, id));
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const addPlayer = useTournamentStore((state) => state.addPlayer);
  const importPlayers = useTournamentStore((state) => state.importPlayers);
  const updatePlayer = useTournamentStore((state) => state.updatePlayer);
  const removePlayer = useTournamentStore((state) => state.removePlayer);
  const finishRegistration = useTournamentStore((state) => state.finishRegistration);
  const verifyPassword = useTournamentStore((state) => state.verifyPassword);

  const filter = useWorkspaceListFilter();
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [review, setReview] = useState<Review | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSchool, setNewSchool] = useState("");

  if (loading || card?.summaryOnly) return <div className="panel panel-padding">กำลังโหลดรายชื่อผู้เล่น…</div>;
  if (!hasStaffAccess(auth)) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="ดูผลที่เผยแพร่จากหน้าภาพรวมของรุ่น" action={<Link prefetch={false} href={`/cards/${id}`} className="button button--primary">กลับหน้าภาพรวม</Link>} /></div>;
  if (!card) return <CardNotFound />;

  const director = canManageTournament(auth) && card.status !== "CLOSED" && card.status !== "FINISHED";
  const registration = director && card.runtimeStage === "PLAYER_REGISTRATION";
  const working = busy || navPending;
  const held = new Set((card.screeningPool ?? []).map((entry) => entry.player));
  const stateOf = (player: Player) => player.terminated ? "withdrawn" : held.has(player.id) ? "held" : "active";
  const count = (state: string) => card.players.filter((player) => stateOf(player) === state).length;
  const schools = [...new Set(card.players.map((player) => player.school))].sort((a,b) => a.localeCompare(b,"th"));
  const { code, name, school, status } = filter.state;
  const includes = (value: string, needle?: string) => !needle || value.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  const rows = card.players.filter((player) => (!status || stateOf(player) === status)
    && (!code || code.split(/[\s,]+/).some((value) => matchesPlayerCode(player.id, value)))
    && includes(displayName(player), name) && includes(player.school, school)
  ).sort((a, b) => comparePlayerCodes(a.id, b.id));

  const changedFields = ({ before, after }: Draft) => [
    { label: "ชื่อ–นามสกุล", before: displayName(before), after: displayName(after) },
    { label: fields.school, before: before.school, after: after.school },
  ].filter((field) => field.before !== field.after);

  const change = (player: Player, field: "name" | "school", value: string) => {
    setDrafts((previous) => {
      const next = new Map(previous);
      const current = previous.get(player.id);
      const before = current?.before ?? details(player);
      const after = current?.after ?? before;
      const nextName = field === "name" ? value : current?.displayName ?? displayName(before);
      const nextSchool = field === "school" ? value : after.school;
      if (nextName === displayName(before) && nextSchool === before.school) next.delete(player.id);
      else next.set(player.id, { before, displayName: nextName, after: { ...splitName(nextName, before), school: nextSchool } });
      return next;
    });
  };

  const askSave = () => {
    setError("");
    const changes: [string, Draft][] = [];
    for (const [code, draft] of drafts) {
      const parsed = playerSchema.safeParse(draft.after);
      if (!parsed.success) {
        setError(`${code} · ${parsed.error.issues[0]?.message ?? "ตรวจสอบข้อมูลผู้เล่น"}`);
        return;
      }
      if (fieldKeys.some((key) => parsed.data[key] !== draft.before[key])) changes.push([code, { ...draft, after: parsed.data }]);
    }
    if (!changes.length) { setDrafts(new Map()); return; }
    setPassword("");
    setReview({ kind: "edit", changes });
  };

  const confirm = async () => {
    if (!review || !director) return;
    setError("");
    if (review.kind === "edit" && !password) { setError("กรอกรหัสผ่านผู้อำนวยการ"); return; }
    setBusy(true);
    let completed = 0;
    try {
      if (review.kind === "delete") {
        if (!registration) throw new Error("ลบผู้เล่นได้ในช่วงลงทะเบียน");
        const live = selectCard(useTournamentStore.getState().cards, id)?.players.find((player) => player.id === review.player.id);
        if (!live || fieldKeys.some((key) => live[key] !== review.player[key])) throw new Error("ข้อมูลผู้เล่นเปลี่ยน กรุณาปิดแล้วเลือกผู้เล่นอีกครั้ง");
        await removePlayer(id, review.player.id);
      } else {
        if (!await verifyPassword(password)) throw new Error("รหัสผ่านผู้อำนวยการไม่ถูกต้อง");
        for (const [code, draft] of review.changes) {
          const live = selectCard(useTournamentStore.getState().cards,id)?.players.find((player) => player.id === code);
          if (!live || fieldKeys.some((key) => live[key] !== draft.before[key])) throw new Error(`${code} มีข้อมูลเปลี่ยน กรุณาตรวจแถวนี้ก่อนบันทึกอีกครั้ง`);
          await updatePlayer(id, code, draft.after);
          ++completed;
          setDrafts((previous) => {
            const remaining = new Map(previous);
            remaining.delete(code);
            return remaining;
          });
        }
      }
      setReview(null);
      setPassword("");
      toast.success(review.kind === "delete" ? "ลบผู้เล่นแล้ว" : `บันทึกข้อมูล ${completed} คนแล้ว`);
    } catch (failure) {
      setError(`${completed ? `บันทึกแล้ว ${completed} คน · ` : ""}${failure instanceof Error ? failure.message : "ดำเนินการไม่สำเร็จ"}`);
      if (completed) { setReview(null); setPassword(""); }
    } finally { setBusy(false); }
  };

  const onAdd = async () => {
    if (!registration || working) return;
    setError("");
    const parsed = playerSchema.safeParse({ ...splitName(newName), school: newSchool });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "กรอกชื่อและโรงเรียนให้ครบ");
      return;
    }
    const values = parsed.data;
    const duplicate = card.players.find((player) => displayName(player).toLowerCase() === displayName(values).toLowerCase());
    if (duplicate && !await appDialog.confirm(`ชื่อซ้ำกับ ${duplicate.id}`, { title: "พบชื่อผู้เล่นซ้ำ", confirmLabel: "เพิ่มผู้เล่นต่อ" })) return;
    setBusy(true);
    try {
      await addPlayer(id, values);
      setNewName("");
      setNewSchool("");
      setShowAdd(false);
      toast.success("เพิ่มผู้เล่นแล้ว");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "เพิ่มผู้เล่นไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const finish = async () => {
    if (!await appDialog.confirm(`จบการลงทะเบียน ${card.players.length} คนและไปหน้าสร้างคู่เกมแรก`, { title:"จบการลงทะเบียน", confirmLabel:"ยืนยัน" })) return;
    setBusy(true);
    try { await finishRegistration(id); navigate(`/cards/${id}/tables`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "จบการลงทะเบียนไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  return <div className="players-page">
    <h1 className="sr">ผู้เล่น</h1>
    {director && <div className="roster-actions">
      <div className="roster-critical">{!registration && <PlayerTermination card={card} />}</div>
      <div className="roster-work">
        {!registration && canOpenScreening(card) && <PairingToolButtons card={card} modes={["screen"]} />}
        {registration ? <>
          <button type="button" className="btn btn--primary" onClick={() => { setError(""); setShowAdd(true); }} aria-haspopup="dialog"><UserPlus className="i" size={15} />เพิ่มผู้เล่น</button>
          <button type="button" className="btn btn--secondary" onClick={() => setShowImport(true)} aria-haspopup="dialog"><Upload className="i" size={14} />นำเข้า Excel</button>
          <button type="button" className="btn btn--success" disabled={working || drafts.size > 0 || card.players.length < 2} onClick={() => void finish()}>
            จบการลงทะเบียน <ArrowRight className="i" size={15} /></button>
        </> : <ReopenRegistration card={card} />}
      </div>
    </div>}
    {error && !review && !showAdd && <div className="notice notice--danger" role="alert"><p>{error}</p></div>}
    <section className="panel" aria-label="รายชื่อผู้เล่น">
      <WorkspaceListToolbar status={<><strong>ลงทะเบียน {card.players.length} คน</strong><span className="meta">แข่งอยู่ {count("active")}</span>
        <span className="meta">ถอนแล้ว {count("withdrawn")}</span>{held.size > 0 && <span className="meta">คัดชั่วคราว {held.size}</span>}
        {filter.count > 0 && <span className="meta">แสดง {rows.length} คน</span>}</>}
        actions={<>{filter.button}{director && <div className="roster-draft-bar">
          <span id="roster-draft-count" className="sr" role="status">{drafts.size} คนยังไม่บันทึก</span>
          <button type="button" className="btn btn--secondary roster-discard" disabled={!drafts.size || working} aria-label="ยกเลิกการแก้ไข"
            onClick={() => setDrafts(new Map())}><Undo2 className="i" size={15} /></button>
          <button type="button" className="btn btn--success" disabled={!drafts.size || working} onClick={askSave} aria-describedby="roster-draft-count">
            <Save className="i" size={15} />บันทึก<span className="roster-draft-badge" aria-hidden>{drafts.size || ""}</span></button>
        </div>}</>} />
      <div className="gscroll" style={{ maxHeight:500 }}><table className="dt" aria-label="ทะเบียนผู้เล่น">
        <thead><tr><th className="c" scope="col">#</th><th scope="col">{filter.heading("code")}</th>
          <th scope="col">{filter.heading("name")}</th><th scope="col">{filter.heading("school")}</th><th scope="col">{filter.heading("status")}</th>
          {registration && <th className="c" scope="col">ลบ</th>}</tr></thead>
        <tbody>{rows.length ? rows.map((player, index) => {
          const rowStatus = stateOf(player);
          const draft = drafts.get(player.id);
          return <tr key={player.id} data-roster-dirty={drafts.has(player.id) ? "" : undefined}>
            <td className="c num">{index + 1}</td><td className="code">{player.id}</td>
            <td className="roster-cell-td">{director ? <input aria-label={`ชื่อ–นามสกุล ${player.id}`} className="roster-cell" disabled={working}
              value={draft?.displayName ?? displayName(player)} title={displayName(player)} onChange={(event) => change(player, "name", event.target.value)} autoComplete="off" /> : displayName(player)}</td>
            <td className="roster-cell-td">{director ? <input aria-label={`${fields.school} ${player.id}`} className="roster-cell" disabled={working}
              value={draft?.after.school ?? player.school} title={player.school} onChange={(event) => change(player, "school", event.target.value)} autoComplete="off" /> : player.school}</td>
            <td><span className={`badge badge--${rowStatus === "withdrawn" ? "danger" : rowStatus === "held" ? "info" : "neutral"}`}>
              {rowStatus === "withdrawn" ? "ถอนแล้ว" : rowStatus === "held" ? "คัดชั่วคราว" : "แข่งอยู่"}</span></td>
            {registration && <td className="c"><button type="button" className="icon-btn roster-delete" aria-label={`ลบ ${player.id}`} disabled={working || drafts.size > 0}
              onClick={() => { setError(""); setReview({ kind:"delete", player }); }}><Trash2 className="i" size={15} /></button></td>}
          </tr>;
        }) : <tr><td colSpan={registration ? 6 : 5}>{card.players.length ? "ไม่พบผู้เล่นตามตัวกรอง" : "ยังไม่มีผู้เล่น"}</td></tr>}</tbody>
      </table></div>
    </section>
    <WorkspaceListFilter filter={filter} fields={["code","name","school"]} emptyStatus="ทุกสถานะ"
      statuses={[["active","แข่งอยู่"],["held","คัดชั่วคราว"],["withdrawn","ถอนแล้ว"]]} />

    <ConfirmDialog appearance="prototype" open={registration && showAdd} title="เพิ่มผู้เล่น" confirmLabel="บันทึก" busy={busy}
      error={showAdd ? error : undefined} onConfirm={() => void onAdd()} onCancel={() => { setShowAdd(false); setError(""); }}>
      <div className="field"><label htmlFor="roster-add-name">ชื่อ–นามสกุล</label><input id="roster-add-name" className="input" autoComplete="off" disabled={working}
        value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void onAdd(); }} /></div>
      <div className="field"><label htmlFor="roster-new-school">โรงเรียน/สถาบัน</label>
        <InstitutionCombobox id="roster-new-school" value={newSchool} onChange={setNewSchool} options={schools} disabled={working} /></div>
    </ConfirmDialog>
    <ConfirmDialog appearance="prototype" open={registration && showImport} title="นำเข้าผู้เล่นจาก Excel" confirmLabel="ปิด" hideCancel
      onConfirm={() => setShowImport(false)} onCancel={() => setShowImport(false)}>
      <ExcelPlayerImport onImport={(players) => importPlayers(id, players)} />
    </ConfirmDialog>
    <ConfirmDialog appearance="prototype" open={Boolean(review)} title={review?.kind === "delete" ? `ลบผู้เล่น ${review.player.id}` : "ยืนยันการแก้ไขข้อมูลผู้เล่น"}
      description={review?.kind === "delete" ? `${displayName(review.player)} · ระบบจะเรียงรหัสผู้เล่นที่เหลือใหม่` : undefined}
      confirmLabel={review?.kind === "delete" ? "ลบและจัดรหัสใหม่" : "ยืนยันและบันทึก"} danger={review?.kind === "delete"} busy={busy} error={review ? error : undefined}
      className={review?.kind === "edit" ? "dialog--roster-tool dialog--roster-edit" : undefined}
      cancelLabel={review?.kind === "edit" ? "กลับไปแก้ไข" : undefined} onConfirm={() => void confirm()}
      onCancel={() => { setReview(null); setPassword(""); setError(""); }}>
      {review?.kind === "edit" && <>
        <div className="msw-summary"><p className="msw-summary-count"><strong>{review.changes.length} คน</strong>
          <span>{review.changes.reduce((total, [,draft]) => total + changedFields(draft).length, 0)} ช่องที่เปลี่ยน</span></p>
          <div className="msw-summary-scroll roster-edit-scroll"><table className="dt roster-edit-diff" aria-label="รายการแก้ไขข้อมูลผู้เล่น">
            <thead><tr><th scope="col">ผู้เล่น</th><th scope="col">ช่องที่แก้</th><th scope="col">ค่าเดิม</th><th scope="col">ค่าใหม่</th></tr></thead>
            {review.changes.map(([code, draft]) => {
              const changes = changedFields(draft);
              return <tbody key={code}>{changes.map((change, index) => <tr key={change.label}>
                {index === 0 && <th scope="rowgroup" rowSpan={changes.length}><span className="code">{code}</span><small>{displayName(draft.before)}</small></th>}
                <td className="roster-review-field">{change.label}</td><td className="roster-review-before">{change.before}</td>
                <td className="roster-review-after"><span className="roster-review-new">{change.after}</span></td>
              </tr>)}</tbody>;
            })}
          </table></div>
        </div>
        <label className="field"><span>รหัสผ่านผู้อำนวยการ</span><FreshSecretInput className="input" value={password}
          onChange={(event) => setPassword(event.target.value)} aria-label="รหัสผ่านผู้อำนวยการ" /></label>
      </>}
    </ConfirmDialog>
  </div>;
}
