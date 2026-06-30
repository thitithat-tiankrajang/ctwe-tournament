"use client";

import Link from "next/link";
import { ArrowRight, LogIn, ShieldCheck, Trophy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore, type TournamentArchive } from "@/application/tournament/store";
import { isAdmin } from "@/domain/tournament/roles";
import type { PublicTournamentSummary } from "@/domain/tournament/types";
import { ArchiveList } from "@/ui/components/archive-list";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

/**
 * Public master landing — the only entry to the cross-tournament overview. Lists OPEN tournaments
 * (each with its private access link) and the Excel archives of finished tournaments. Opening a
 * tournament link scopes the visitor to that tournament with no in-app way back here.
 */
export default function Home() {
  const auth = useTournamentStore((state) => state.auth);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const loadPublicTournaments = useTournamentStore((state) => state.loadPublicTournaments);
  const loadPublicArchives = useTournamentStore((state) => state.loadPublicArchives);

  const [tournaments, setTournaments] = useState<PublicTournamentSummary[]>([]);
  const [archives, setArchives] = useState<TournamentArchive[]>([]);
  const [loading, setLoading] = useState(true);

  // Reaching the master page un-scopes any tournament the visitor previously entered via a link.
  useEffect(() => { setActiveTournament(null); }, [setActiveTournament]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a] = await Promise.all([
        loadPublicTournaments().catch(() => []),
        loadPublicArchives().catch(() => []),
      ]);
      setTournaments(t);
      setArchives(a);
    } finally {
      setLoading(false);
    }
  }, [loadPublicTournaments, loadPublicArchives]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <>
      <PageHeader
        eyebrow="Tournament Control"
        title="ติดตามการแข่งขัน"
        description="เลือกการแข่งขันที่เปิดอยู่เพื่อเข้าชมผลแบบเรียลไทม์ หรือดาวน์โหลดผลย้อนหลังที่เก็บถาวรไว้"
        actions={
          <div className="page-actions">
            {isAdmin(auth) && <Link href="/admin"><Button variant="secondary"><ShieldCheck size={16} />คอนโซลผู้ดูแล</Button></Link>}
            {!auth.authenticated && <Link href="/staff-login"><Button variant="secondary"><LogIn size={16} />เข้าสู่ระบบเจ้าหน้าที่</Button></Link>}
          </div>
        }
      />

      <Panel title="การแข่งขันที่เปิดอยู่" description="กดเข้าชมเพื่อดู Ranking · Pairing · ผลการแข่งขัน ของรายการนั้น">
        <div className="panel-padding">
          {loading ? (
            <p className="muted">กำลังโหลด…</p>
          ) : tournaments.length === 0 ? (
            <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีการแข่งขันที่เปิดอยู่" description="เมื่อผู้ดูแลระบบเปิดการใช้งานการแข่งขัน รายการจะปรากฏที่นี่พร้อมลิงก์เข้าชม" />
          ) : (
            <div className="card-grid">
              {tournaments.map((t) => (
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

      <Panel title="คลังผลการแข่งขัน (Excel)" description="ไฟล์สรุปผลของการแข่งขันที่จบและเก็บถาวรแล้ว ดาวน์โหลดได้ตลอด">
        <div className="panel-padding">
          <ArchiveList archives={archives} downloadHref={(archive) => `/api/public/archives/${archive.id}/download`} />
        </div>
      </Panel>
    </>
  );
}
