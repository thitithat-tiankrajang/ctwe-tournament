"use client";

import { useParams } from "next/navigation";
import { FileClock, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { canManageTournament, isAdmin } from "@/domain/tournament/roles";
import type { AuditEntry } from "@/domain/tournament/types";
import { CardNotFound } from "@/ui/components/card-not-found";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { EmptyState, PageHeader } from "@/ui/components/page";

function compactDateTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

const auditColumns: DataColumn<AuditEntry>[] = [
  { key: "time", label: "เวลา", min: 96, width: 120, cellClassName: "mono", value: (entry) => entry.timestamp, filterable: false, render: (entry) => compactDateTime(entry.timestamp) },
  { key: "user", label: "ผู้ใช้", min: 90, width: 130, value: (entry) => entry.user, render: (entry) => entry.user },
  { key: "action", label: "กิจกรรม", min: 130, width: 190, value: (entry) => entry.action, render: (entry) => <strong>{entry.action}</strong> },
  {
    key: "change", label: "การเปลี่ยนแปลง", min: 220, width: 460,
    value: (entry) => `${entry.oldValue} → ${entry.newValue}`,
    filterable: false,
    sortable: false,
    render: (entry) => <><span className="audit-old">{entry.oldValue}</span><span className="audit-arrow">→</span><span>{entry.newValue}</span></>,
  },
];

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

  return (
    <>
      <PageHeader eyebrow={card.name} title="บันทึกกิจกรรม" description={loadingAudit ? "กำลังโหลด…" : `${entries.length.toLocaleString("th-TH")} รายการ · ล่าสุดก่อน`} />

      {loadingAudit ? <div className="panel panel-padding">กำลังโหลดบันทึกกิจกรรม…</div> : entries.length === 0 ? <div className="panel"><EmptyState icon={<FileClock size={25} />} title="ยังไม่มีบันทึกกิจกรรม" description="การเปลี่ยนแปลงข้อมูลจะปรากฏที่นี่" /></div> : (
        <DataGrid
          columns={auditColumns}
          rows={entries}
          getRowKey={(entry) => entry.id}
          storageKey={`${id}:audit`}
          tableClassName="entry-grid--audit"
          emptyText="ไม่พบรายการตามตัวกรอง"
        />
      )}
    </>
  );
}
