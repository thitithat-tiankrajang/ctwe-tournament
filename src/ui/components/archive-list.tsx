"use client";

import { Download, FileSpreadsheet, Trash2 } from "lucide-react";
import type { TournamentArchive } from "@/application/tournament/store";
import { Button } from "@/ui/components/button";
import { EmptyState } from "@/ui/components/page";

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
const formatDate = (iso: string) => new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Lists archived (exported-to-Excel) tournaments with a public download link; `onDelete` (admin) is optional. */
export function ArchiveList({ archives, onDelete }: { archives: TournamentArchive[]; onDelete?: (archive: TournamentArchive) => void }) {
  if (archives.length === 0)
    return <EmptyState icon={<FileSpreadsheet size={24} />} title="ยังไม่มีไฟล์ที่เก็บถาวร" description="เมื่อมีการเก็บทัวร์นาเมนต์เป็นไฟล์ Excel ไฟล์จะมาอยู่ที่นี่ให้ดาวน์โหลด" />;
  return (
    <div className="archive-list">
      {archives.map((archive) => (
        <div className="archive-row" key={archive.id}>
          <span className="archive-row__icon"><FileSpreadsheet size={20} /></span>
          <div className="archive-row__info">
            <strong>{archive.tournamentName}</strong>
            <small>{archive.cardCount} การ์ด · {archive.playerCount} ผู้เล่น · {formatSize(archive.byteSize)} · เก็บเมื่อ {formatDate(archive.archivedAt)}</small>
          </div>
          <div className="archive-row__actions">
            <a href={`/api/archives/${archive.id}/download`} download={archive.fileName}>
              <Button variant="secondary" size="sm"><Download size={15} />ดาวน์โหลด</Button>
            </a>
            {onDelete && <Button variant="ghost" size="sm" aria-label={`ลบไฟล์ ${archive.tournamentName}`} title="ลบไฟล์ถาวร" onClick={() => onDelete(archive)}><Trash2 size={15} /></Button>}
          </div>
        </div>
      ))}
    </div>
  );
}
