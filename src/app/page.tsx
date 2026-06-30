"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LogIn, Settings, ShieldCheck, Trophy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore, type TournamentArchive } from "@/application/tournament/store";
import { isAdmin, isDirector, isResultStaff } from "@/domain/tournament/roles";
import type { PublicTournamentSummary, Tournament } from "@/domain/tournament/types";
import { ArchiveList } from "@/ui/components/archive-list";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

/**
 * Master landing — role-aware entry point.
 *  - anonymous viewer: OPEN tournaments to watch ("เข้าชม") + login.
 *  - staff (one tournament): auto-navigated into their workspace.
 *  - director: only their tournaments, shown as green "จัดการ" cards to manage.
 *  - admin: OPEN tournaments + a shortcut to the admin console.
 */
export default function Home() {
  const router = useRouter();
  const auth = useTournamentStore((state) => state.auth);
  const authLoading = useTournamentStore((state) => state.loading);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const loadPublicTournaments = useTournamentStore((state) => state.loadPublicTournaments);
  const loadPublicArchives = useTournamentStore((state) => state.loadPublicArchives);

  const director = isDirector(auth);
  const staff = isResultStaff(auth);
  const admin = isAdmin(auth);

  const [publicTournaments, setPublicTournaments] = useState<PublicTournamentSummary[]>([]);
  const [myTournaments, setMyTournaments] = useState<Tournament[]>([]);
  const [archives, setArchives] = useState<TournamentArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffNoAccess, setStaffNoAccess] = useState(false);

  const enterManage = (tournament: Tournament) => {
    setActiveTournament({ id: tournament.id, name: tournament.name });
    router.push("/cards");
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (director) {
        setMyTournaments(await loadTournaments().catch(() => []));
      } else {
        setPublicTournaments(await loadPublicTournaments().catch(() => []));
      }
      setArchives(await loadPublicArchives().catch(() => []));
    } finally {
      setLoading(false);
    }
  }, [director, loadTournaments, loadPublicTournaments, loadPublicArchives]);

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
    // Everyone else views the master page un-scoped.
    setActiveTournament(null);
    void refresh();
    return () => { active = false; };
  }, [authLoading, staff, refresh, loadTournaments, setActiveTournament, router]);

  if (staff) {
    return (
      <div className="panel panel-padding">
        {staffNoAccess
          ? "บัญชีของคุณยังไม่ได้ผูกกับรายการแข่งขัน — โปรดติดต่อผู้อำนวยการ"
          : "กำลังพาเข้าสู่การแข่งขันของคุณ…"}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={director ? "Director" : "Tournament Control"}
        title={director ? "รายการแข่งขันของคุณ" : "ติดตามการแข่งขัน"}
        description={director
          ? "เลือกรายการแข่งขันที่คุณดูแลเพื่อเข้าไปจัดการการ์ดและผลการแข่งขัน"
          : "เลือกการแข่งขันที่เปิดอยู่เพื่อเข้าชมผลแบบเรียลไทม์ หรือดาวน์โหลดผลย้อนหลังที่เก็บถาวรไว้"}
        actions={
          <div className="page-actions">
            {director && <Badge tone="success">DIRECTOR</Badge>}
            {admin && <Link href="/admin"><Button variant="secondary"><ShieldCheck size={16} />คอนโซลผู้ดูแล</Button></Link>}
            {!auth.authenticated && <Link href="/staff-login"><Button variant="secondary"><LogIn size={16} />เข้าสู่ระบบเจ้าหน้าที่</Button></Link>}
          </div>
        }
      />

      {director ? (
        <Panel title="รายการแข่งขันที่คุณดูแล" description="กดจัดการเพื่อเข้าไปทำงานในการ์ดของรายการนั้น">
          <div className="panel-padding">
            {loading ? (
              <p className="muted">กำลังโหลด…</p>
            ) : myTournaments.length === 0 ? (
              <EmptyState icon={<Trophy size={25} />} title="ยังไม่ได้รับมอบหมายรายการแข่งขัน" description="ติดต่อผู้ดูแลระบบเพื่อมอบหมายรายการแข่งขันให้คุณ" />
            ) : (
              <div className="card-grid">
                {myTournaments.map((t) => (
                  <article className="competition-card competition-card--manage" key={t.id}>
                    <div className="competition-card__header">
                      <div><h2>{t.name}</h2><span className="competition-card__division">{t.cardCount} รุ่นการแข่งขัน</span></div>
                      <Badge tone={t.status === "OPEN" ? "success" : "danger"}>{t.status === "OPEN" ? "เปิด" : "ปิด"}</Badge>
                    </div>
                    <div className="competition-card__footer">
                      <small>{t.directors.length > 0 ? `ผู้อำนวยการ ${t.directors.length} คน` : "รายการที่คุณดูแล"}</small>
                      <Button variant="success" size="sm" onClick={() => enterManage(t)}><Settings size={15} />จัดการ</Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </Panel>
      ) : (
        <Panel title="การแข่งขันที่เปิดอยู่" description="กดเข้าชมเพื่อดู Ranking · Pairing · ผลการแข่งขัน ของรายการนั้น">
          <div className="panel-padding">
            {loading ? (
              <p className="muted">กำลังโหลด…</p>
            ) : publicTournaments.length === 0 ? (
              <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีการแข่งขันที่เปิดอยู่" description="เมื่อผู้ดูแลระบบเปิดการใช้งานการแข่งขัน รายการจะปรากฏที่นี่พร้อมลิงก์เข้าชม" />
            ) : (
              <div className="card-grid">
                {publicTournaments.map((t) => (
                  <article className="competition-card" key={t.id}>
                    <div className="competition-card__header">
                      <div><h2>{t.name}</h2><span className="competition-card__division">{t.cardCount} รุ่นการแข่งขัน</span></div>
                      <Badge tone="success">เปิดอยู่</Badge>
                    </div>
                    <div className="competition-card__footer">
                      <small>{t.publishedCardCount > 0 ? `เผยแพร่ผลแล้ว ${t.publishedCardCount} รุ่น` : "ยังไม่มีผลที่เผยแพร่"}</small>
                      <Link href={`/t/${t.accessToken}`}><Button size="sm">เข้าชม <ArrowRight size={15} /></Button></Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </Panel>
      )}

      <Panel title="คลังผลการแข่งขัน (Excel)" description="ไฟล์สรุปผลของการแข่งขันที่จบและเก็บถาวรแล้ว ดาวน์โหลดได้ตลอด">
        <div className="panel-padding">
          <ArchiveList archives={archives} downloadHref={(archive) => `/api/public/archives/${archive.id}/download`} />
        </div>
      </Panel>
    </>
  );
}
