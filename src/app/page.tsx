"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, LogIn, Settings, ShieldCheck, Trophy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore, type TournamentArchive } from "@/application/tournament/store";
import { isAdmin, isDirector, isResultStaff } from "@/domain/tournament/roles";
import type { Tournament } from "@/domain/tournament/types";
import { ArchiveList } from "@/ui/components/archive-list";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

/**
 * Master landing — role-aware entry point. Access requires signing in: anonymous visitors get a
 * login gate (this is the only place the login button lives). After login each role is routed:
 *  - staff (one tournament): auto-navigated into their workspace.
 *  - director: only their tournaments, shown as green "จัดการ" cards to manage.
 *  - admin: every tournament, shown as "เข้าชม" cards — admins watch, they don't manage cards.
 */
export default function Home() {
  const router = useRouter();
  const auth = useTournamentStore((state) => state.auth);
  const authLoading = useTournamentStore((state) => state.loading);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const loadPublicArchives = useTournamentStore((state) => state.loadPublicArchives);

  const director = isDirector(auth);
  const staff = isResultStaff(auth);
  const admin = isAdmin(auth);
  // Directors manage their own tournaments; admins watch every tournament. Both list them from here.
  const managedList = director || admin;

  const [myTournaments, setMyTournaments] = useState<Tournament[]>([]);
  const [archives, setArchives] = useState<TournamentArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffNoAccess, setStaffNoAccess] = useState(false);

  // Directors manage; admins only watch. Both set the active tournament and open its card list.
  const enterTournament = (tournament: Tournament) => {
    setActiveTournament({ id: tournament.id, name: tournament.name });
    router.push("/cards");
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (managedList) setMyTournaments(await loadTournaments().catch(() => []));
      setArchives(await loadPublicArchives().catch(() => []));
    } finally {
      setLoading(false);
    }
  }, [managedList, loadTournaments, loadPublicArchives]);

  useEffect(() => {
    if (authLoading) return;
    let active = true;
    if (staff) {
      // Staff own exactly one tournament — drop them straight into its workspace.
      (async () => {
        try {
          const mine = await loadTournaments();
          if (!active) return;
          if (mine.length > 0) {
            setActiveTournament({ id: mine[0].id, name: mine[0].name });
            router.replace("/cards");
          } else {
            setStaffNoAccess(true);
          }
        } catch {
          if (active) setStaffNoAccess(true);
        }
      })();
      return () => { active = false; };
    }
    if (!auth.authenticated) {
      // Anonymous visitors cannot browse anything from here — they must sign in.
      setActiveTournament(null);
      setLoading(false);
      return () => { active = false; };
    }
    // Director/admin land on their tournament list, un-scoped (sidebar folders stay hidden until entry).
    setActiveTournament(null);
    void refresh();
    return () => { active = false; };
  }, [authLoading, staff, auth.authenticated, refresh, loadTournaments, setActiveTournament, router]);

  if (authLoading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;

  if (staff) {
    return (
      <div className="panel panel-padding">
        {staffNoAccess
          ? "บัญชีของคุณยังไม่ได้ผูกกับรายการแข่งขัน — โปรดติดต่อผู้อำนวยการ"
          : "กำลังพาเข้าสู่การแข่งขันของคุณ…"}
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <>
        <PageHeader
          eyebrow="Tournament Control"
          title="เข้าสู่ระบบเพื่อดำเนินการต่อ"
          description="ระบบจัดการแข่งขันสำหรับผู้ดูแลระบบ ผู้อำนวยการ และเจ้าหน้าที่ — เข้าสู่ระบบเพื่อเข้าถึงข้อมูลการแข่งขัน"
        />
        <Panel title="เข้าสู่ระบบ" description="ต้องเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ ผู้อำนวยการ หรือเจ้าหน้าที่ก่อนจึงจะดูข้อมูลได้">
          <div className="panel-padding" style={{ display: "grid", gap: 16, maxWidth: 460 }}>
            <div className="notice notice--info"><ShieldCheck size={18} /><p><strong>จำเป็นต้องเข้าสู่ระบบ</strong><span>ข้อมูลการแข่งขันเปิดให้เฉพาะผู้ที่เข้าสู่ระบบเท่านั้น</span></p></div>
            <div className="form-actions" style={{ paddingLeft: 0 }}>
              <Link href="/staff-login"><Button><LogIn size={16} />เข้าสู่ระบบ</Button></Link>
            </div>
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={admin ? "Admin" : "Director"}
        title="รายการแข่งขัน"
        description={admin
          ? "เลือกรายการแข่งขันเพื่อเข้าชมข้อมูลการ์ดและผลการแข่งขัน (โหมดดูอย่างเดียว)"
          : "เลือกรายการแข่งขันที่คุณดูแลเพื่อเข้าไปจัดการการ์ดและผลการแข่งขัน"}
        actions={
          <div className="page-actions">
            <Badge tone={admin ? "warning" : "success"}>{admin ? "ADMIN" : "DIRECTOR"}</Badge>
            {admin && <Link href="/admin"><Button variant="secondary"><ShieldCheck size={16} />คอนโซลผู้ดูแล</Button></Link>}
          </div>
        }
      />

      <Panel
        title={admin ? "รายการแข่งขันทั้งหมด" : "รายการแข่งขันที่คุณดูแล"}
        description={admin ? "กดเข้าชมเพื่อดูการ์ดและผลของรายการนั้น" : "กดจัดการเพื่อเข้าไปทำงานในการ์ดของรายการนั้น"}
      >
        <div className="panel-padding">
          {loading ? (
            <p className="muted">กำลังโหลด…</p>
          ) : myTournaments.length === 0 ? (
            <EmptyState
              icon={<Trophy size={25} />}
              title={admin ? "ยังไม่มีรายการแข่งขัน" : "ยังไม่ได้รับมอบหมายรายการแข่งขัน"}
              description={admin ? "สร้างรายการแข่งขันได้จากคอนโซลผู้ดูแล" : "ติดต่อผู้ดูแลระบบเพื่อมอบหมายรายการแข่งขันให้คุณ"}
            />
          ) : (
            <div className="card-grid">
              {myTournaments.map((t) => (
                <article className={`competition-card${admin ? "" : " competition-card--manage"}`} key={t.id}>
                  <div className="competition-card__header">
                    <div><h2>{t.name}</h2><span className="competition-card__division">{t.cardCount} รุ่นการแข่งขัน</span></div>
                    <Badge tone={t.status === "OPEN" ? "success" : "danger"}>{t.status === "OPEN" ? "เปิด" : "ปิด"}</Badge>
                  </div>
                  <div className="competition-card__footer">
                    <small>{t.directors.length > 0 ? `ผู้อำนวยการ ${t.directors.length} คน` : (admin ? "รายการแข่งขัน" : "รายการที่คุณดูแล")}</small>
                    {admin
                      ? <Button variant="secondary" size="sm" onClick={() => enterTournament(t)}><Eye size={15} />เข้าชม</Button>
                      : <Button variant="success" size="sm" onClick={() => enterTournament(t)}><Settings size={15} />จัดการ</Button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="คลังผลการแข่งขัน (Excel)" description="ไฟล์สรุปผลของการแข่งขันที่จบและเก็บถาวรแล้ว ดาวน์โหลดได้ตลอด">
        <div className="panel-padding">
          <ArchiveList archives={archives} downloadHref={(archive) => `/api/public/archives/${archive.id}/download`} />
        </div>
      </Panel>
    </>
  );
}
