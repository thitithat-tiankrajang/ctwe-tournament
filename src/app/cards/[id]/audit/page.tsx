"use client";

import { useParams } from "next/navigation";
import { FileClock, FileDown, Gamepad2, ListOrdered, LoaderCircle, LockKeyhole, Swords } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { canManageTournament, isAdmin } from "@/domain/tournament/roles";
import type { AuditEntry } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { SearchableTable } from "@/ui/components/table-search";

function compactDateTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

type PdfKind = "pairing" | "ranking" | "result";

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
  const [downloading, setDownloading] = useState<string | null>(null);

  // Games with a published (confirmed) snapshot — the only ones a document can be built for.
  // Computed inline so the heavy PDF module (jsPDF + embedded Thai font) stays out of this page's
  // bundle and is only fetched when a director actually clicks download.
  const publishedGameList = useMemo(() => {
    if (!card) return [];
    const games = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt)).flatMap((snapshot) => snapshot.gameNumbers);
    return [...new Set(games)].sort((a, b) => a - b);
  }, [card]);

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

  const downloadPdf = async (kind: PdfKind, gameNumber: number) => {
    if (!card) return;
    setDownloading(`${kind}:${gameNumber}`);
    try {
      // Lazy import: PDF engine + Thai font load only now, then browser-cache for later clicks.
      const pdf = await import("@/ui/pdf/tournament-pdfs");
      if (kind === "pairing") pdf.downloadPairingPdf(card, gameNumber);
      else if (kind === "ranking") pdf.downloadRankingPdf(card, gameNumber);
      else pdf.downloadResultPdf(card, gameNumber);
    } catch {
      toast.error("สร้างไฟล์ PDF ไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      setDownloading(null);
    }
  };

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!canView) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="Audit log มีข้อมูลการปฏิบัติงานภายในและไม่เปิดเผยต่อบุคคลทั่วไป" /></div>;
  if (!card) return <CardNotFound />;

  const kinds: { kind: PdfKind; label: string; icon: typeof FileDown }[] = [
    { kind: "pairing", label: "Pairing", icon: Swords },
    { kind: "ranking", label: "Ranking", icon: ListOrdered },
    { kind: "result", label: "Result", icon: Gamepad2 },
  ];

  return (
    <>
      <PageHeader eyebrow={card.name} title="บันทึกกิจกรรม" description={loadingAudit ? "กำลังโหลด…" : `${entries.length.toLocaleString("th-TH")} รายการ · ล่าสุดก่อน`} />

      <Panel
        title="ดาวน์โหลดเอกสาร PDF"
        description="สร้างและบันทึกลงเครื่องทันที · ไม่บันทึกลงระบบ · เลือกได้เฉพาะเกมที่เผยแพร่ผลแล้ว"
      >
        {publishedGameList.length === 0 ? (
          <div className="panel-padding pdf-empty">ยังไม่มีเกมที่เผยแพร่ผล — เมื่อ Publish ผลเกมใดแล้ว จะดาวน์โหลด Pairing / Ranking / Result ของเกมนั้นได้ที่นี่</div>
        ) : (
          <div className="pdf-download-list">
            {publishedGameList.map((gameNumber) => (
              <div key={gameNumber} className="pdf-download-row">
                <span className="pdf-download-row__game">เกม {gameNumber}</span>
                <div className="pdf-download-row__actions">
                  {kinds.map(({ kind, label, icon: Icon }) => {
                    const busy = downloading === `${kind}:${gameNumber}`;
                    return (
                      <Button
                        key={kind}
                        size="sm"
                        variant="secondary"
                        disabled={Boolean(downloading)}
                        onClick={() => void downloadPdf(kind, gameNumber)}
                        title={`ดาวน์โหลด ${label} เกม ${gameNumber} เป็น PDF`}
                      >
                        {busy ? <LoaderCircle className="loading-spinner" size={15} /> : <Icon size={15} />}
                        {label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {loadingAudit ? <div className="panel panel-padding">กำลังโหลดบันทึกกิจกรรม…</div> : entries.length === 0 ? <div className="panel"><EmptyState icon={<FileClock size={25} />} title="ยังไม่มีบันทึกกิจกรรม" description="การเปลี่ยนแปลงข้อมูลจะปรากฏที่นี่" /></div> : (
        <SearchableTable
          items={entries}
          toText={(entry) => `${compactDateTime(entry.timestamp)} ${entry.user} ${entry.action} ${entry.oldValue} ${entry.newValue}`}
          placeholder="ค้นหาเวลา ผู้ใช้ กิจกรรม หรือการเปลี่ยนแปลง"
          unit="รายการ"
          wrapClassName="audit-table-wrap"
          tableClassName="audit-table"
          columns={[{ label: "เวลา" }, { label: "ผู้ใช้" }, { label: "กิจกรรม" }, { label: "การเปลี่ยนแปลง" }]}
          renderRow={(entry) => <tr key={entry.id}><td className="mono">{compactDateTime(entry.timestamp)}</td><td>{entry.user}</td><td><strong>{entry.action}</strong></td><td><span className="audit-old">{entry.oldValue}</span><span className="audit-arrow">→</span><span>{entry.newValue}</span></td></tr>}
        />
      )}
    </>
  );
}
