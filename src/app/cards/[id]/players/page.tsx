"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, FilterX, LoaderCircle, LockKeyhole, Pencil, Plus, Save, Trash2, Users, X } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { rankPlayers, selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { matchesPlayerCode } from "@/domain/tournament/player-code";
import { canManageTournament, hasStaffAccess } from "@/domain/tournament/roles";
import { playerSchema, type PlayerForm } from "@/domain/tournament/schemas";
import { rankingAfterGame } from "@/domain/tournament/history";
import type { Player } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { ExcelPlayerImport } from "@/ui/components/excel-player-import";
import { GameFlow } from "@/ui/components/game-flow";
import { InstitutionCombobox } from "@/ui/components/institution-combobox";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { PlayerTermination } from "@/ui/components/player-termination";
import { ReopenRegistration } from "@/ui/components/reopen-registration";

type Confirmation = { kind: "update" | "delete"; player: Player } | null;

export default function PlayersPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const addPlayer = useTournamentStore((state) => state.addPlayer);
  const importPlayers = useTournamentStore((state) => state.importPlayers);
  const updatePlayer = useTournamentStore((state) => state.updatePlayer);
  const removePlayer = useTournamentStore((state) => state.removePlayer);
  const finishRegistration = useTournamentStore((state) => state.finishRegistration);
  const card = selectCard(cards, id);
  const [query, setQuery] = useState("");
  const [rankingGame, setRankingGame] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PlayerForm>({ firstName: "", lastName: "", school: "" });
  const [rowError, setRowError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [pending, setPending] = useState<"add" | "update" | "delete" | null>(null);
  const { control, register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<PlayerForm>({
    resolver: zodResolver(playerSchema),
    defaultValues: { firstName: "", lastName: "", school: "" },
  });

  if (loading) return <div className="panel panel-padding loading-state"><LoaderCircle className="loading-spinner" size={18} />กำลังตรวจสอบสิทธิ์…</div>;
  const isStaff = hasStaffAccess(auth);
  if (!isStaff) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="บุคคลทั่วไปดูผลที่ประกาศแล้วได้จากหน้าภาพรวมของการ์ด" action={<Link prefetch={false} href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
  if (!card) return <CardNotFound />;

  const registrationOpen = card.runtimeStage === "PLAYER_REGISTRATION";
  const canManage = canManageTournament(auth);
  const canEditRegistration = canManage && registrationOpen;
  // Directors may correct a player's personal info (name/school) at any stage; add/remove stays registration-only.
  const directorEdit = !registrationOpen && canManage;
  const showEditableTable = canManage;
  const schools = [...new Set(card.players.map((player) => player.school).filter(Boolean))].sort((a, b) => a.localeCompare(b, "th"));
  const publishedSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const latestPublishedGame = Math.max(0, ...publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const selectedRankingGame = rankingGame && publishedSnapshots.some((snapshot) => snapshot.gameNumbers.includes(rankingGame)) ? rankingGame : latestPublishedGame;
  // Terminated players are shown in the terminate/restore panel, not the active ranking table.
  const terminatedIds = new Set(card.players.filter((player) => player.terminated).map((player) => player.id));
  const ranked = (selectedRankingGame > 0 ? rankingAfterGame({ ...card, snapshots: publishedSnapshots }, selectedRankingGame) : rankPlayers(card.players))
    .filter((player) => !terminatedIds.has(player.id));
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  const filtered = ranked.filter((player) => {
    const term = query.trim();
    if (/^[A-Za-z]*\d+$/.test(term)) return matchesPlayerCode(player.id, term);
    return `${player.id} ${player.firstName} ${player.lastName} ${player.school}`.toLowerCase().includes(term.toLowerCase());
  });
  const rankIndex = new Map(ranked.map((player, index) => [player.id, index + 1]));
  // Preview the next code with the card's letter prefix, numbered after the current highest.
  const codePrefix = card.codePrefix ?? card.players[0]?.id.replace(/\d+$/, "") ?? "P";
  const nextCode = `${codePrefix}${String(Math.max(0, ...card.players.map((player) => Number(player.id.replace(/^[A-Za-z]+/, "")) || 0)) + 1).padStart(3, "0")}`;
  const busy = pending !== null || isSubmitting;

  const rankingColumns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 48, width: 58, align: "right", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัส", min: 50, width: 60, filterKind: "playerCode", cellClassName: "cell-id", value: ({ player }) => player.id, render: ({ player }) => player.id },
    { key: "name", label: "ชื่อ-นามสกุล", min: 110, width: 200, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 110, width: 200, cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนสะสม", min: 76, width: 90, align: "right", value: ({ player }) => player.winPoints, render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 82, width: 96, align: "right", value: ({ player }) => player.diff, filterable: false, render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
    { key: "wdl", label: "ชนะ / เสมอ / แพ้", min: 100, width: 142, align: "center", value: ({ player }) => `${player.wins} / ${player.draws} / ${player.losses}`, render: ({ player }) => `${player.wins} / ${player.draws} / ${player.losses}` },
  ];

  const onAdd = async (values: PlayerForm) => {
    const normalized = `${values.firstName} ${values.lastName}`.trim().toLocaleLowerCase("th");
    const duplicates = card.players.filter((player) => `${player.firstName} ${player.lastName}`.trim().toLocaleLowerCase("th") === normalized);
    if (duplicates.length > 0) {
      const codes = duplicates.map((player) => player.id).join(", ");
      if (!await appDialog.confirm(`ชื่อนี้ซ้ำกับรหัส ${codes} นะ ยืนยันว่าจะเพิ่มผู้เล่นชื่อนี้หรือไม่?`, {
        title: "พบชื่อผู้เล่นซ้ำ",
        confirmLabel: "เพิ่มผู้เล่นต่อ",
      })) return;
    }
    setOperationError("");
    setPending("add");
    try {
      await addPlayer(id, values);
      reset({ firstName: "", lastName: "", school: "" });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "เพิ่มผู้เล่นไม่สำเร็จ");
    } finally {
      setPending(null);
    }
  };

  const startEdit = (player: Player) => {
    setEditingId(player.id);
    setEditDraft({ firstName: player.firstName, lastName: player.lastName, school: player.school });
    setRowError("");
    setOperationError("");
  };

  const requestUpdate = (player: Player) => {
    const validation = playerSchema.safeParse(editDraft);
    if (!validation.success) {
      setRowError(validation.error.issues[0]?.message ?? "กรุณาตรวจสอบข้อมูลให้ครบ");
      return;
    }
    setEditDraft(validation.data);
    setRowError("");
    setConfirmation({ kind: "update", player });
  };

  const confirmMutation = async () => {
    if (!confirmation) return;
    setOperationError("");
    setPending(confirmation.kind);
    try {
      if (confirmation.kind === "update") {
        await updatePlayer(id, confirmation.player.id, editDraft);
      } else {
        await removePlayer(id, confirmation.player.id);
      }
      setEditingId(null);
      setRowError("");
      setConfirmation(null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "ดำเนินการไม่สำเร็จ");
    } finally {
      setPending(null);
    }
  };

  const finish = async () => {
    if (!await appDialog.confirm(`ยืนยันจบการลงทะเบียนผู้เล่น ${card.players.length} คน? หลังจากนี้จะแก้รายชื่อไม่ได้`, {
      title: "จบการลงทะเบียน",
      confirmLabel: "จบการลงทะเบียน",
    })) return;
    try {
      await finishRegistration(id);
      router.push(`/cards/${id}/tables`);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "จบการลงทะเบียนไม่สำเร็จ");
    }
  };

  const confirmationDescription = confirmation?.kind === "delete"
    ? `ระบบจะลบ ${confirmation.player.id} · ${confirmation.player.firstName} ${confirmation.player.lastName} และเลื่อนรหัสของผู้เล่นถัดไป ${card.players.filter((player) => Number(player.id.slice(1)) > Number(confirmation.player.id.slice(1))).length} คนให้ต่อเนื่อง การทำรายการนี้จะถูกเก็บใน History Log`
    : confirmation
      ? `ยืนยันแก้ไข ${confirmation.player.id} เป็น “${editDraft.firstName} ${editDraft.lastName}” สถาบัน “${editDraft.school}” ระบบจะเก็บข้อมูลก่อนและหลังแก้ไขใน History Log`
      : "";

  return (
    <>
      <PageHeader
        eyebrow={`${card.name} · ${card.runtimeStage}`}
        title="ผู้เล่น"
        description={!canManage
          ? "ดูรายชื่อผู้เล่นที่ Director จัดเตรียมไว้เท่านั้น"
          : registrationOpen
            ? "เพิ่มผู้เล่นให้ครบก่อนจบการลงทะเบียน รหัสนักกีฬาจะสร้างโดยระบบอัตโนมัติ"
            : "รายชื่อถูกล็อกแล้ว ผลการแข่งขันเรียงตาม Win Point และ Total Difference"}
        actions={canManage
          ? registrationOpen
            ? <Button variant="success" disabled={busy || card.players.length < 2} onClick={finish}>Finish registration <ArrowRight size={16} /></Button>
            : <><ReopenRegistration card={card} /><Link prefetch={false} href={`/cards/${id}/tables`}><Button>ไปขั้นตอนปัจจุบัน <ArrowRight size={16} /></Button></Link></>
          : undefined}
      />

      {canEditRegistration && (
        <Panel title="เพิ่มผู้เล่น" description={`รหัสถัดไปโดยประมาณ ${nextCode} · backend จะเป็นผู้ยืนยันรหัสจริงเพื่อป้องกันข้อมูลชนกัน`}>
          <form className="panel-padding form-grid" onSubmit={handleSubmit(onAdd)}>
            <div className="form-field"><label className="form-label" htmlFor="firstName">ชื่อ <span className="required">*</span></label><input className="input" id="firstName" autoComplete="off" disabled={busy} {...register("firstName")} />{errors.firstName && <p className="form-error">{errors.firstName.message}</p>}</div>
            <div className="form-field"><label className="form-label" htmlFor="lastName">นามสกุล <span className="required">*</span></label><input className="input" id="lastName" autoComplete="off" disabled={busy} {...register("lastName")} />{errors.lastName && <p className="form-error">{errors.lastName.message}</p>}</div>
            <div className="form-field">
              <label className="form-label" htmlFor="school">โรงเรียน/สถาบัน <span className="required">*</span></label>
              <Controller name="school" control={control} render={({ field }) => <InstitutionCombobox id="school" value={field.value} onChange={field.onChange} options={schools} disabled={busy} aria-describedby={errors.school ? "school-error" : undefined} />} />
              {errors.school && <p className="form-error" id="school-error">{errors.school.message}</p>}
            </div>
            <div className="form-field" style={{ justifyContent: "flex-end" }}><Button type="submit" disabled={busy}>{pending === "add" ? <LoaderCircle className="loading-spinner" size={16} /> : <Plus size={16} />}{pending === "add" ? "กำลังเพิ่ม…" : "Add player"}</Button></div>
          </form>
        </Panel>
      )}

      {canEditRegistration && <ExcelPlayerImport onImport={(players) => importPlayers(id, players)} />}

      {canManage && pending && <div className="operation-loading" role="status"><LoaderCircle className="loading-spinner" size={17} /><span>{pending === "add" ? "กำลังเพิ่มผู้เล่นและสร้างรหัส…" : pending === "update" ? "กำลังบันทึกข้อมูลและ History Log…" : "กำลังลบ จัดรหัสใหม่ และบันทึก History Log…"}</span></div>}
      {canManage && operationError && <div className="notice notice--danger" role="alert"><p><strong>ทำรายการไม่สำเร็จ</strong><span>{operationError}</span></p></div>}
      {!canManage && <div className="notice notice--info"><LockKeyhole size={18} /><p><strong>Staff ดูรายชื่อได้อย่างเดียว</strong><span>การเพิ่ม นำเข้า แก้ไข ลบ และจบการลงทะเบียนเป็นสิทธิ์ของ Director</span></p></div>}
      {directorEdit && <div className="notice notice--info"><Pencil size={18} /><p><strong>ผู้อำนวยการแก้ข้อมูลส่วนตัวได้ตลอดเวลา</strong><span>แก้ชื่อ–นามสกุล และโรงเรียน/สถาบันได้ทุกขั้นตอน · การเพิ่ม/ลบผู้เล่นทำได้เฉพาะช่วงลงทะเบียน</span></p></div>}

      {directorEdit && <PlayerTermination card={card} />}

      {publishedSnapshots.length > 0 && (
        <Panel title="Ranking หลังจบแต่ละเกม" description="เลือกเกมเพื่อดูอันดับสะสม ณ เวลาที่เกมนั้น Publish โดยไม่ปะปนกับเกมถัดไป">
          <div className="panel-padding archive-game-flow"><GameFlow card={rankingCard} selectedGame={selectedRankingGame} onSelect={setRankingGame} mode="ranking" /></div>
          <div className="archive-rule-summary"><strong>อันดับหลังจบเกม {selectedRankingGame}</strong><span>เรียงตาม Win Point แล้ว Total Difference</span></div>
        </Panel>
      )}

      {showEditableTable ? (
        <>
          <section className="player-filter-bar" style={{ gridTemplateColumns: "minmax(240px, 1fr) auto" }} aria-label="ค้นหาผู้เล่น">
            <div className="compact-field"><label htmlFor="player-search">ค้นหารหัส ชื่อ หรือโรงเรียน</label><input id="player-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="เช่น 42, P042 หรือชื่อโรงเรียน" /></div>
            <Button className="filter-reset" variant="secondary" size="sm" onClick={() => setQuery("")}><FilterX size={14} />ล้าง</Button>
          </section>
          <div className="dense-table-meta"><strong>{filtered.length.toLocaleString("th-TH")}</strong> จาก {card.players.length.toLocaleString("th-TH")} คน · {registrationOpen ? "รายชื่อก่อนเริ่มการแข่งขัน" : "ผู้อำนวยการแก้ข้อมูลส่วนตัวได้"}</div>
          {filtered.length === 0 ? <div className="panel"><EmptyState icon={<Users size={24} />} title="ไม่พบผู้เล่น" description={registrationOpen ? "เพิ่มผู้เล่นคนแรกจากฟอร์มด้านบน" : "ลองล้างคำค้นหา"} /></div> : (
            <div className="dense-table-wrap player-review-table"><table className="data-table dense-player-table"><thead><tr><th className="numeric">#</th><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>โรงเรียน/สถาบัน</th><th className="numeric">WP</th><th className="numeric">ชนะ</th><th className="numeric">เสมอ</th><th className="numeric">แพ้</th><th className="numeric">Difference</th><th>จัดการ</th></tr></thead><tbody>{filtered.map((player) => {
              const editing = editingId === player.id;
              return <tr key={player.id} className={editing ? "player-row--editing" : undefined}>
                <td className="numeric rank-cell">{rankIndex.get(player.id)}</td>
                <td className="mono">{player.id}</td>
                <td className="cell-primary">{editing ? <div className="inline-name-fields"><input className="input" aria-label={`ชื่อ ${player.id}`} value={editDraft.firstName} disabled={busy} onChange={(event) => setEditDraft((draft) => ({ ...draft, firstName: event.target.value }))} /><input className="input" aria-label={`นามสกุล ${player.id}`} value={editDraft.lastName} disabled={busy} onChange={(event) => setEditDraft((draft) => ({ ...draft, lastName: event.target.value }))} />{rowError && <span className="form-error">{rowError}</span>}</div> : `${player.firstName} ${player.lastName}`}</td>
                <td>{editing ? <InstitutionCombobox id={`school-${player.id}`} value={editDraft.school} onChange={(school) => setEditDraft((draft) => ({ ...draft, school }))} options={schools} disabled={busy} /> : player.school}</td>
                <td className="numeric"><strong>{player.winPoints}</strong></td><td className="numeric">{player.wins}</td><td className="numeric">{player.draws}</td><td className="numeric">{player.losses}</td><td className="numeric">{player.diff}</td>
                <td><div className="row-actions">{editing ? <><Button aria-label={`บันทึก ${player.id}`} size="sm" disabled={busy} onClick={() => requestUpdate(player)}><Save size={14} />ยืนยันแก้ไข</Button><Button aria-label={`ยกเลิกแก้ไข ${player.id}`} variant="secondary" size="sm" disabled={busy} onClick={() => { setEditingId(null); setRowError(""); }}><X size={14} /></Button></> : <><Button aria-label={`แก้ไข ${player.id}`} variant="secondary" size="sm" disabled={busy} onClick={() => startEdit(player)}><Pencil size={14} />Edit</Button>{registrationOpen && <Button aria-label={`ลบ ${player.id}`} variant="danger" size="sm" disabled={busy} onClick={() => { setOperationError(""); setConfirmation({ kind: "delete", player }); }}><Trash2 size={14} /></Button>}</>}</div></td>
              </tr>;
            })}</tbody></table></div>
          )}
        </>
      ) : ranked.length === 0 ? (
        <div className="panel"><EmptyState icon={<Users size={24} />} title="ยังไม่มีผู้เล่น" description="รายชื่อจะปรากฏหลังเจ้าหน้าที่เพิ่มผู้เล่น" /></div>
      ) : (
        <DataGrid
          columns={rankingColumns}
          rows={ranked.map((player, index) => ({ player, rank: index + 1 }))}
          getRowKey={(row) => row.player.id}
          storageKey={`${id}:players:ranking-v3`}
          resetKey={String(selectedRankingGame)}
          tableClassName="entry-grid--ranking"
          emptyText="ไม่พบผู้เล่นตามตัวกรอง"
          unit="คน"
        />
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.kind === "delete" ? `ยืนยันลบ ${confirmation.player.id}?` : `ยืนยันแก้ไข ${confirmation?.player.id}?`}
        description={confirmationDescription}
        confirmLabel={confirmation?.kind === "delete" ? "ลบและจัดรหัสใหม่" : "บันทึกการแก้ไข"}
        danger={confirmation?.kind === "delete"}
        busy={pending === "update" || pending === "delete"}
        error={confirmation && operationError ? operationError : undefined}
        onCancel={() => { if (!pending) { setConfirmation(null); setOperationError(""); } }}
        onConfirm={() => void confirmMutation()}
      />
    </>
  );
}
