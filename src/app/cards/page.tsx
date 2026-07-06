"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, DoorOpen, Plus, Trash2, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { canManageTournament, hasStaffAccess, isAdmin, isDirector, isOperator } from "@/domain/tournament/roles";
import type { TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { EmptyState, PageHeader } from "@/ui/components/page";

export default function CardsPage() {
  const router = useRouter();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const error = useTournamentStore((state) => state.error);
  const deleteCard = useTournamentStore((state) => state.deleteCard);
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const isStaff = hasStaffAccess(auth);
  const admin = isAdmin(auth);
  const director = isDirector(auth);
  const operator = isOperator(auth);
  // Only directors manage cards (create/delete); admins watch, staff/viewers only read.
  const canManage = canManageTournament(auth);
  const createHref = director ? "/director" : "/cards/create";
  const [deleting, setDeleting] = useState<TournamentCard | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // The card list only exists inside a tournament scope. Every role now enters a tournament
  // explicitly (staff auto, director/admin pick from "/", viewers via link), so anyone here without
  // one is sent back to the master landing.
  useEffect(() => {
    if (!loading && !activeTournament) router.replace("/");
  }, [loading, activeTournament, router]);

  // Directors/admins exit a tournament from here (there is no exit button in the sidebar).
  const exitTournament = () => { setActiveTournament(null); router.push("/"); };

  // Back-office users must enter a tournament first; public viewers see all published cards.
  const needsTournament = isStaff && !activeTournament;
  const visibleCards = activeTournament ? cards.filter((card) => card.tournamentId === activeTournament.id) : cards;
  const groupedCards = [...visibleCards]
    .sort((a, b) => a.name.localeCompare(b.name, "th", { numeric: true })
      || a.division.localeCompare(b.division, "th", { numeric: true }))
    .reduce<Map<string, TournamentCard[]>>((groups, card) => {
      const group = groups.get(card.name) ?? [];
      group.push(card);
      groups.set(card.name, group);
      return groups;
    }, new Map());

  const confirmDelete = async () => {
    if (!deleting) return;
    setPending(true); setDeleteError("");
    try { await deleteCard(deleting.id); setDeleting(null); }
    catch (failure) { setDeleteError(failure instanceof Error ? failure.message : "ลบการ์ดไม่สำเร็จ"); }
    finally { setPending(false); }
  };
  const cardHref = (card: typeof cards[number]) => {
    // Only operators (director/staff) go straight to the workspace; admins and viewers watch the overview.
    if (!operator || card.runtimeStage === "FINAL_PUBLISHED") return `/cards/${card.id}`;
    if (card.runtimeStage === "PLAYER_REGISTRATION") return `/cards/${card.id}/players`;
    if (["TABLE_PAIRING", "PAIRING_PREVIEW"].includes(card.runtimeStage)) return `/cards/${card.id}/tables`;
    return `/cards/${card.id}/games`;
  };

  return (
    <>
      <PageHeader
        className="cards-page-header"
        eyebrow={activeTournament ? "รายการแข่งขัน" : "Tournament cards"}
        title={activeTournament ? activeTournament.name : "ติดตามการแข่งขัน"}
        description={activeTournament ? "รุ่นการแข่งขัน (card) ทั้งหมดของรายการนี้ — จัดการผู้เล่น เกม และผลลัพธ์แยกแต่ละรุ่น" : "หนึ่งการ์ดต่อหนึ่งรุ่นการแข่งขัน จัดการผู้เล่น เกม และผลลัพธ์แยกจากกันอย่างชัดเจน"}
        actions={activeTournament && (admin || director) ? (
          <div className="page-actions">
            <Button variant="secondary" onClick={exitTournament}><DoorOpen size={16} />ออกจากรายการแข่งขัน</Button>
            {director && <Link prefetch={false} href={createHref}><Button><Plus size={17} />สร้างการ์ด</Button></Link>}
          </div>
        ) : undefined}
      />
      {error && <div className="notice notice--warning"><p><strong>เชื่อมต่อฐานข้อมูลไม่สำเร็จ</strong><span>{error}</span></p></div>}
      {loading ? <div className="panel panel-padding">กำลังโหลดข้อมูลจากฐานข้อมูล…</div> : needsTournament ? (
        <EmptyState icon={<DoorOpen size={25} />} title="ยังไม่ได้เข้าสู่รายการแข่งขัน" description="เปิดการแข่งขันผ่านลิงก์ของรายการนั้น หรือจัดการได้จากคอนโซลผู้ดูแล" action={<Link prefetch={false} href="/admin"><Button><Trophy size={16} />ไปคอนโซลผู้ดูแล</Button></Link>} />
      ) : visibleCards.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีการ์ดในรายการนี้" description={activeTournament ? (director ? "สร้างรุ่นการแข่งขันแรกของรายการนี้ได้เลย" : "ยังไม่มีรุ่นการแข่งขันในรายการนี้") : "ยังไม่มีการแข่งขันที่เผยแพร่"} action={activeTournament && director ? <Link prefetch={false} href={createHref}><Button>สร้างการ์ด</Button></Link> : undefined} />
      ) : (
        <div className="card-groups">
          {[...groupedCards.entries()].map(([name, group]) => (
            <section className="card-group" key={name}>
              <h2 className="card-group__title">{name}</h2>
              <div className="card-group__rows">
                {group.map((card) => (
                  <article className="card-select-row" key={card.id}>
                    <Link prefetch={false} href={cardHref(card)} className="card-select-row__link">
                      <span className="card-select-row__name">{card.name}</span>
                      <span className="card-select-row__division">{card.division}</span>
                      <ChevronRight size={19} aria-hidden />
                    </Link>
                    {canManage && (
                      <Button variant="ghost" size="sm" className="card-select-row__delete" aria-label={`ลบการ์ด ${card.name} ${card.division}`} title="ลบการ์ดและข้อมูลทั้งหมด" onClick={() => { setDeleteError(""); setDeleting(card); }}>
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            </section>
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
