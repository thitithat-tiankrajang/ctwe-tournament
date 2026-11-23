"use client";

import { useParams } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { canManageTournament, isAdmin } from "@/domain/tournament/roles";
import type { AuditEntry } from "@/domain/tournament/types";
import { CardNotFound } from "@/ui/components/card-not-found";
import { AuditActivity } from "@/ui/components/audit-activity";
import { EmptyState } from "@/ui/components/page";

export default function AuditPage() {
  const { id } = useParams<{ id: string }>();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const loadAudit = useTournamentStore((state) => state.loadAudit);
  const card = selectCard(cards, id);
  // Directors read their own audit; admins watch every tournament's audit. Staff/viewers cannot.
  const canView = isAdmin(auth) || canManageTournament(auth);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(true);

  // Audit is fetched on demand (no longer bundled in the card payload) so saves/polls stay cheap.
  useEffect(() => {
    if (!id || !canView) return;
    let active = true;
    setLoadingAudit(true);
    loadAudit(id)
      .then((rows) => { if (active) setEntries([...rows].sort((a, b) => b.timestamp.localeCompare(a.timestamp))); })
      .catch(() => { /* surfaced via store.error */ })
      .finally(() => { if (active) setLoadingAudit(false); });
    return () => { active = false; };
  }, [id, canView, loadAudit]);

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!canView) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="Audit log มีข้อมูลการปฏิบัติงานภายในและไม่เปิดเผยต่อบุคคลทั่วไป" /></div>;
  if (!card) return <CardNotFound />;

  return <div className="audit-page">
    <h1 className="sr">บันทึกกิจกรรม</h1>
    {loadingAudit ? <div className="panel panel-padding">กำลังโหลดบันทึกกิจกรรม…</div> : <AuditActivity key={id} entries={entries} />}
  </div>;
}
