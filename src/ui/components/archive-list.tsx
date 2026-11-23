"use client";

import { Download, Trash2 } from "lucide-react";
import type { TournamentArchive } from "@/application/tournament/store";

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
const formatDate = (iso: string) => new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

const formatDay = (iso: string) => new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" }).format(new Date(iso));

/** Lists admin-only archived tournament exports; `onDelete` is optional. Compact rows as in the accepted design. */
export function ArchiveList({ archives, onDelete, downloadHref = (archive) => `/api/archives/${archive.id}/download` }: { archives: TournamentArchive[]; onDelete?: (archive: TournamentArchive) => void; downloadHref?: (archive: TournamentArchive) => string }) {
  if (archives.length === 0)
    return <p className="panel-body meta archive-empty">ยังไม่มีไฟล์ที่เก็บถาวร · เมื่อเก็บรายการแข่งขันเป็นไฟล์ Excel ไฟล์จะอยู่ที่นี่ให้ดาวน์โหลด</p>;
  return (
    <table className="dt archive-table" aria-label="ไฟล์ Excel ที่ส่งออกแล้ว">
      <tbody>{archives.map((archive) => (
        <tr key={archive.id}>
          <td><span className="archive-cell"><span className="archive-name">{archive.fileName || `${archive.tournamentName}.xlsx`}</span>
            <small className="meta">{archive.tournamentName} · {archive.cardCount} การ์ด · {archive.playerCount} ผู้เล่น · {formatSize(archive.byteSize)}</small></span></td>
          <td className="meta" title={formatDate(archive.archivedAt)}>{formatDay(archive.archivedAt)}</td>
          <td className="n"><span className="cellrow">
            <a className="btn btn--sm btn--ghost" href={downloadHref(archive)} download={archive.fileName}><Download className="i" size={13} />ดาวน์โหลด</a>
            {onDelete && <button type="button" className="btn btn--sm btn--penalty" aria-label={`ลบไฟล์ ${archive.tournamentName}`} title="ลบไฟล์ถาวร"
              onClick={() => onDelete(archive)}><Trash2 className="i" size={13} />ลบ</button>}
          </span></td>
        </tr>
      ))}</tbody>
    </table>
  );
}
