"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKeyhole, Trophy } from "lucide-react";
import { useEffect } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { canManageTournament, isAdmin, isDirector } from "@/domain/tournament/roles";
import { Button } from "@/ui/components/button";
import { CardCreateForm } from "@/ui/components/card-create-form";
import { EmptyState, PageHeader } from "@/ui/components/page";

export default function CreateCardPage() {
  const router = useRouter();
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);

  // Directors create cards from their own console ("จัดการเจ้าหน้าที่") only.
  const directorOnly = isDirector(auth) && !isAdmin(auth);
  useEffect(() => {
    if (!loading && directorOnly) router.replace("/director");
  }, [loading, directorOnly, router]);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!canManageTournament(auth)) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="เข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่เพื่อสร้างการ์ดการแข่งขัน" action={<Link href="/staff-login"><Button>เข้าสู่ระบบเจ้าหน้าที่</Button></Link>} /></div>;
  }
  if (directorOnly) return <div className="panel panel-padding">กำลังพาไปหน้าจัดการเจ้าหน้าที่…</div>;
  if (!activeTournament) {
    return <div className="panel"><EmptyState icon={<Trophy size={25} />} title="ยังไม่ได้เข้าสู่รายการแข่งขัน" description="เข้าสู่รายการแข่งขัน (tournament) ก่อนจึงจะสร้างรุ่นการแข่งขันได้" action={<Link href="/tournaments"><Button>ไปหน้ารายการแข่งขัน</Button></Link>} /></div>;
  }

  return (
    <>
      <PageHeader eyebrow="New competition" title="สร้างการ์ดการแข่งขัน" description="ระบบจะสร้างเกมและเส้นเชื่อมอัตโนมัติตามจำนวนเกมที่กำหนด" />
      <CardCreateForm fixedTournament={activeTournament} cancelHref="/cards" onCreated={(id) => router.push(`/cards/${id}/players`)} />
    </>
  );
}
