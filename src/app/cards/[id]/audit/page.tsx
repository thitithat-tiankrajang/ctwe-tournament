"use client";

import { useParams } from "next/navigation";
import { FileClock, LockKeyhole } from "lucide-react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { CardNotFound } from "@/ui/components/card-not-found";
import { EmptyState, PageHeader } from "@/ui/components/page";

function compactDateTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export default function AuditPage() {
  const { id } = useParams<{ id: string }>();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const card = selectCard(cards, id);
  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!auth.authenticated || !auth.roles.includes("ROLE_STAFF")) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="Audit log มีข้อมูลการปฏิบัติงานภายในและไม่เปิดเผยต่อบุคคลทั่วไป" /></div>;
  if (!card) return <CardNotFound />;
  const entries = [...card.audit].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <>
      <PageHeader eyebrow={card.name} title="บันทึกกิจกรรม" description={`${entries.length.toLocaleString("th-TH")} รายการ · ล่าสุดก่อน`} />
      {entries.length === 0 ? <div className="panel"><EmptyState icon={<FileClock size={25} />} title="ยังไม่มีบันทึกกิจกรรม" description="การเปลี่ยนแปลงข้อมูลจะปรากฏที่นี่" /></div> : (
        <div className="dense-table-wrap audit-table-wrap">
          <table className="data-table audit-table"><thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>กิจกรรม</th><th>การเปลี่ยนแปลง</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td className="mono">{compactDateTime(entry.timestamp)}</td><td>{entry.user}</td><td><strong>{entry.action}</strong></td><td><span className="audit-old">{entry.oldValue}</span><span className="audit-arrow">→</span><span>{entry.newValue}</span></td></tr>)}</tbody></table>
        </div>
      )}
    </>
  );
}
