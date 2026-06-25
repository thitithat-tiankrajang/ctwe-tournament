"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, DoorClosed, DoorOpen, Lock, LockKeyhole, LockOpen, Trophy, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { hasStaffAccess, isAdmin } from "@/domain/tournament/roles";
import type { Tournament } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader } from "@/ui/components/page";

export default function TournamentsPage() {
  const router = useRouter();
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const setTournamentStatus = useTournamentStore((state) => state.setTournamentStatus);
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [busy, setBusy] = useState(false);
  const admin = isAdmin(auth);

  const refresh = useCallback(async () => {
    if (!hasStaffAccess(auth)) return;
    try { setTournaments(await loadTournaments()); } catch { /* surfaced via store.error */ }
  }, [auth, loadTournaments]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!hasStaffAccess(auth)) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="เข้าสู่ระบบเพื่อดูและเข้าสู่รายการแข่งขัน" action={<Link href="/staff-login"><Button>เข้าสู่ระบบ</Button></Link>} /></div>;
  }

  // Navigation: enter a tournament to view/work on its cards. Distinct from the admin OPEN/CLOSED lifecycle.
  const enter = (tournament: Tournament) => { setActiveTournament({ id: tournament.id, name: tournament.name }); router.push("/cards"); };
  const leave = () => setActiveTournament(null);
  const toggleStatus = async (tournament: Tournament) => {
    setBusy(true);
    try { await setTournamentStatus(tournament.id, tournament.status !== "OPEN"); await refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : "เปลี่ยนสถานะไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader
        eyebrow="Tournaments"
        title="รายการแข่งขัน"
        description="เข้าสู่รายการแข่งขันเพื่อจัดการรุ่นการแข่งขัน (card) ของรายการนั้น · สถานะ OPEN/CLOSED ผู้ดูแลระบบเป็นผู้กำหนด รายการที่ CLOSED จะแก้ไขไม่ได้"
        actions={activeTournament ? <Button variant="secondary" onClick={leave}><DoorClosed size={16} />ออกจาก {activeTournament.name}</Button> : undefined}
      />
      {tournaments.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีรายการแข่งขัน" description={admin ? "สร้างรายการแข่งขันได้ที่หน้าผู้ดูแลระบบ" : "ผู้ดูแลระบบยังไม่ได้มอบหมายรายการแข่งขันให้คุณ"} action={admin ? <Link href="/admin"><Button>ไปหน้าผู้ดูแลระบบ</Button></Link> : undefined} />
      ) : (
        <div className="card-grid">
          {tournaments.map((tournament) => {
            const isActive = activeTournament?.id === tournament.id;
            const open = tournament.status === "OPEN";
            return (
              <article className={`competition-card${isActive ? " competition-card--current" : ""}`} key={tournament.id}>
                <div className="competition-card__header">
                  <div><h2>{tournament.name}</h2><span className="competition-card__division">{tournament.cardCount} รุ่นการแข่งขัน</span></div>
                  <Badge tone={open ? "success" : "danger"}>{open ? "OPEN" : "CLOSED"}</Badge>
                </div>
                <div className="competition-card__metrics">
                  <div className="competition-card__metric"><span><Users size={13} /> ผู้อำนวยการ</span><strong>{tournament.directors.length}</strong></div>
                  <div className="competition-card__metric"><span>รุ่นแข่งขัน</span><strong>{tournament.cardCount}</strong></div>
                </div>
                <div className="competition-card__footer">
                  {tournament.directors.length > 0 ? <small>{tournament.directors.join(", ")}</small> : <small>ยังไม่มีผู้อำนวยการ</small>}
                  <span style={{ display: "flex", gap: 6 }}>
                    {admin && <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggleStatus(tournament)} title={open ? "ปิดรายการ (ทำให้แก้ไขไม่ได้)" : "เปิดรายการ"}>{open ? <><Lock size={14} />ปิด</> : <><LockOpen size={14} />เปิด</>}</Button>}
                    {isActive ? (
                      <Link href="/cards"><Button size="sm">จัดการ <ArrowRight size={15} /></Button></Link>
                    ) : (
                      <Button size="sm" onClick={() => enter(tournament)}><DoorOpen size={15} />เข้า</Button>
                    )}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
