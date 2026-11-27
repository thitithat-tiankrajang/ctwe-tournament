"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Link2, LoaderCircle, LogIn, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { selectCardList, useTournamentStore, type TournamentArchive } from "@/application/tournament/store";
import { isAdmin, isDirector, isResultStaff } from "@/domain/tournament/roles";
import type { Tournament } from "@/domain/tournament/types";
import { ArchiveList } from "@/ui/components/archive-list";
import { useNavigateWithPending } from "@/ui/layout/use-navigate-with-pending";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { SystemOffPanel } from "@/ui/components/system-off-panel";
import { fetchSystemState, systemIsOff, type SystemState } from "@/infrastructure/http/system-state";

/**
 * Master landing — role-aware entry point. Access requires signing in: anonymous visitors get a
 * login gate (this is the only place the login button lives). After login each role is routed:
 *  - staff (one tournament): auto-navigated into their workspace.
 *  - director: only their tournaments, shown as green "จัดการ" cards to manage.
 *  - admin: every tournament, shown as "เข้าชม" cards — admins watch, they don't manage cards.
 */
export default function Home() {
  const router = useRouter();
  const { pending: navPending, navigate } = useNavigateWithPending();
  const auth = useTournamentStore((state) => state.auth);
  const authLoading = useTournamentStore((state) => state.loading);
  const cards = useTournamentStore((state) => state.cards);
  const summaries = useTournamentStore((state) => state.summaries);
  const sports = useMemo(() => {
    const grouped = new Map<string, Set<string>>();
    for (const card of selectCardList(cards, summaries)) {
      const names = grouped.get(card.tournamentId) ?? new Set<string>();
      names.add(card.name);
      grouped.set(card.tournamentId, names);
    }
    return grouped;
  }, [cards, summaries]);
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
  // Both buttons push to the same href, so the pending flag alone cannot say WHICH row was
  // clicked. Feedback has to appear on the row the operator pressed, not on all of them.
  const [enteringId, setEnteringId] = useState<string | null>(null);

  // Directors manage; admins only watch. Both set the active tournament and open its card list.
  const enterTournament = (tournament: Tournament) => {
    setEnteringId(tournament.id);
    setActiveTournament({ id: tournament.id, name: tournament.name });
    navigate("/cards");
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
    if (director && !admin) {
      // A director with a single tournament works inside it, as in the accepted design: straight to
      // its card list. The rail's tournament switcher still lists every assignment.
      (async () => {
        const mine = await loadTournaments().catch(() => [] as Tournament[]);
        if (!active) return;
        if (mine.length === 1) {
          setActiveTournament({ id: mine[0].id, name: mine[0].name });
          router.replace("/cards");
          return;
        }
        setMyTournaments(mine);
        setArchives(await loadPublicArchives().catch(() => []));
        setLoading(false);
      })();
      return () => { active = false; };
    }
    void refresh();
    return () => { active = false; };
  }, [authLoading, staff, director, admin, auth.authenticated, refresh, loadTournaments, loadPublicArchives, setActiveTournament, router]);

  // §20's system-off panel. Read once per mount; the file carries max-age=30 of its own.
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  useEffect(() => { void fetchSystemState().then(setSystemState); }, []);

  if (authLoading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;

  // Architecture §20: the shell renders and the data calls fail, so the panel explains why rather
  // than leaving a bare error banner. Anonymous visitors only — a signed-in operator's own screens
  // already report their failures, and this must never hide a working system (§21 caveat 2).
  if (!auth.authenticated && systemIsOff(systemState) && systemState) {
    return (
      <>
        <PageHeader
          eyebrow="Tournament Control"
          title="ระบบจัดการแข่งขันปิดอยู่"
          description="ผลการแข่งขันที่เผยแพร่แล้วยังเปิดดูได้ตามปกติผ่านลิงก์ของรายการนั้น"
        />
        <SystemOffPanel state={systemState} />
      </>
    );
  }

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
          description="ระบบจัดการแข่งขันสำหรับผู้ดูแลระบบ ผู้อำนวยการ และเจ้าหน้าที่ — ผู้ชมทั่วไปเข้าชมผ่านลิงก์ของรายการแข่งขัน"
        />
        <Panel title="เข้าสู่ระบบ" description="ใช้บัญชีผู้ดูแลระบบ ผู้อำนวยการ หรือเจ้าหน้าที่ของคุณ">
          <div className="panel-padding" style={{ display: "grid", gap: 16, maxWidth: 460 }}>
            <div className="form-actions" style={{ paddingLeft: 0 }}>
              <Link prefetch={false} href="/staff-login"><Button><LogIn size={16} />เข้าสู่ระบบ</Button></Link>
            </div>
          </div>
        </Panel>
      </>
    );
  }

  return <>
    <div className="page-head"><div className="ttl"><h1>รายการแข่งขันทั้งหมด</h1></div></div>
    <section className="panel" aria-label="รายการแข่งขันทั้งหมด">
      {loading ? <p className="panel-body meta" role="status">กำลังโหลด…</p> : myTournaments.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title={admin ? "ยังไม่มีรายการแข่งขัน" : "ยังไม่ได้รับมอบหมายรายการแข่งขัน"}
          description={admin ? "สร้างรายการแข่งขันได้จากคอนโซลผู้ดูแล" : "ติดต่อผู้ดูแลระบบเพื่อมอบหมายรายการแข่งขันให้คุณ"} />
      ) : <div className="gscroll"><table aria-label="รายการแข่งขันทั้งหมด" className="dt">
        <thead><tr><th scope="col">รายการแข่งขัน</th><th scope="col">กีฬา · รุ่น</th><th scope="col">ลิงก์</th><th scope="col"><span className="sr">เปิดรายการแข่งขัน</span></th></tr></thead>
        <tbody>{myTournaments.map((tour) => <tr key={tour.id}>
          <td><b>{tour.name}</b></td>
          <td className="meta">{sports.get(tour.id)?.size ?? 0} กีฬา · {tour.cardCount} รุ่น</td>
          <td><span className={`badge badge--${tour.status === "OPEN" ? "info" : "neutral"}`}>
            <Link2 className="i" size={11} aria-hidden />{tour.status === "OPEN" ? "ลิงก์เปิด" : "ลิงก์ปิด"}
          </span></td>
          <td className="n"><button className="btn btn--sm btn--secondary" type="button" onClick={() => enterTournament(tour)}>
            {admin ? "เข้าชม" : "จัดการ"}{navPending && enteringId === tour.id
              ? <LoaderCircle size={13} className="i spin" aria-hidden /> : <ArrowRight size={13} className="i" aria-hidden />}
          </button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    {archives.length > 0 && <section className="panel">
      <div className="panel-head"><h2>คลังผลการแข่งขัน (Excel)</h2></div>
      <ArchiveList archives={archives} downloadHref={(archive) => `/api/public/archives/${archive.id}/download`} />
    </section>}
  </>;
}
