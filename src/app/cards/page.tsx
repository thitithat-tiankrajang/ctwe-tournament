"use client";

import Link from "next/link";
import { ArrowRight, DoorOpen, Plus, Trash2, Trophy } from "lucide-react";
import { useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { hasStaffAccess, isDirector } from "@/domain/tournament/roles";
import type { TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { EmptyState, PageHeader, Stat } from "@/ui/components/page";

export default function CardsPage() {
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const error = useTournamentStore((state) => state.error);
  const deleteCard = useTournamentStore((state) => state.deleteCard);
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const isStaff = hasStaffAccess(auth);
  // Directors create cards from their own console; admins use the standalone create page.
  const createHref = isDirector(auth) ? "/director" : "/cards/create";
  const [deleting, setDeleting] = useState<TournamentCard | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Back-office users must enter a tournament first; public viewers see all published cards.
  const needsTournament = isStaff && !activeTournament;
  const visibleCards = activeTournament ? cards.filter((card) => card.tournamentId === activeTournament.id) : cards;

  const confirmDelete = async () => {
    if (!deleting) return;
    setPending(true); setDeleteError("");
    try { await deleteCard(deleting.id); setDeleting(null); }
    catch (failure) { setDeleteError(failure instanceof Error ? failure.message : "ลบการ์ดไม่สำเร็จ"); }
    finally { setPending(false); }
  };
  const running = visibleCards.filter((card) => card.status === "RUNNING").length;
  const totalPlayers = visibleCards.reduce((sum, card) => sum + card.players.length, 0);
  const finished = visibleCards.filter((card) => ["FINISHED", "CLOSED"].includes(card.status)).length;
  const cardHref = (card: typeof cards[number]) => {
    if (!isStaff || card.runtimeStage === "FINAL_PUBLISHED") return `/cards/${card.id}`;
    if (card.runtimeStage === "PLAYER_REGISTRATION") return `/cards/${card.id}/players`;
    if (["TABLE_PAIRING", "PAIRING_PREVIEW"].includes(card.runtimeStage)) return `/cards/${card.id}/tables`;
    return `/cards/${card.id}/games`;
  };

  return (
    <>
      <PageHeader
        eyebrow={activeTournament ? "รายการแข่งขัน" : "Tournament cards"}
        title={activeTournament ? activeTournament.name : "การ์ดการแข่งขัน"}
        description={activeTournament ? "รุ่นการแข่งขัน (card) ทั้งหมดของรายการนี้ — จัดการผู้เล่น เกม และผลลัพธ์แยกแต่ละรุ่น" : "หนึ่งการ์ดต่อหนึ่งรุ่นการแข่งขัน จัดการผู้เล่น เกม และผลลัพธ์แยกจากกันอย่างชัดเจน"}
        actions={activeTournament ? <Link href={createHref}><Button><Plus size={17} />สร้างการ์ด</Button></Link> : undefined}
      />
      {error && <div className="notice notice--warning"><p><strong>เชื่อมต่อฐานข้อมูลไม่สำเร็จ</strong><span>{error}</span></p></div>}
      {!needsTournament && (
        <div className="stat-grid">
          <Stat label="การ์ดทั้งหมด" value={visibleCards.length} note="ทุกสถานะ" />
          <Stat label="กำลังแข่งขัน" value={running} tone="yellow" note="ต้องติดตามผล" />
          <Stat label="ผู้เล่นในระบบ" value={totalPlayers.toLocaleString("th-TH")} tone="blue" note="รวมทุกการ์ด" />
          <Stat label="แข่งขันเสร็จแล้ว" value={finished} tone="green" note="พร้อมส่งออกข้อมูล" />
        </div>
      )}
      {loading ? <div className="panel panel-padding">กำลังโหลดข้อมูลจากฐานข้อมูล…</div> : needsTournament ? (
        <EmptyState icon={<DoorOpen size={25} />} title="ยังไม่ได้เข้าสู่รายการแข่งขัน" description="เลือกและเปิดรายการแข่งขัน (tournament) ก่อน จึงจะจัดการรุ่นการแข่งขันได้" action={<Link href="/tournaments"><Button><Trophy size={16} />ไปหน้ารายการแข่งขัน</Button></Link>} />
      ) : visibleCards.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีการ์ดในรายการนี้" description={activeTournament ? "สร้างรุ่นการแข่งขันแรกของรายการนี้ได้เลย" : "ยังไม่มีการแข่งขันที่เผยแพร่"} action={activeTournament ? <Link href={createHref}><Button>สร้างการ์ด</Button></Link> : undefined} />
      ) : (
        <div className="card-grid">
          {visibleCards.map((card) => (
            <article className="competition-card" key={card.id}>
              <div className="competition-card__header">
                <div><h2>{card.name}</h2><span className="competition-card__division">{card.division}</span></div>
                <div className="competition-card__header-actions">
                  <Badge>{card.status}</Badge>
                  {isStaff && <Button variant="ghost" size="sm" className="card-delete" aria-label={`ลบการ์ด ${card.name}`} title="ลบการ์ดและข้อมูลทั้งหมด" onClick={() => { setDeleteError(""); setDeleting(card); }}><Trash2 size={15} /></Button>}
                </div>
              </div>
              <div className="competition-card__metrics">
                <div className="competition-card__metric"><span>ผู้เล่น</span><strong>{card.players.length}</strong></div>
                <div className="competition-card__metric"><span>เกม</span><strong>{card.games.length}</strong></div>
                <div className="competition-card__metric"><span>เกมปัจจุบัน</span><strong>{card.currentGame}/{card.games.length}</strong></div>
              </div>
              <div className="competition-card__footer">
                <small>สร้างเมื่อ {new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(new Date(card.createdAt))}</small>
                <Link href={cardHref(card)}><Button variant="ghost" size="sm">{isStaff && card.runtimeStage !== "FINAL_PUBLISHED" ? "ทำงานต่อ" : "ดูภาพรวม"} <ArrowRight size={15} /></Button></Link>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`ลบการ์ด “${deleting?.name}” ?`}
        description="ระบบจะลบการ์ดนี้และข้อมูลที่เกี่ยวข้องทั้งหมดอย่างถาวร ทั้งผู้เล่น, pairing, ผลการแข่งขัน, อันดับ และบันทึกกิจกรรม (log) ทั้งหมด — ไม่สามารถกู้คืนได้"
        confirmLabel="ลบถาวร"
        danger
        busy={pending}
        error={deleteError || undefined}
        onConfirm={() => void confirmDelete()}
        onCancel={() => { if (!pending) { setDeleting(null); setDeleteError(""); } }}
      />
    </>
  );
}
