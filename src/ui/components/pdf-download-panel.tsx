"use client";

import { Gamepad2, ListOrdered, LoaderCircle, Swords } from "lucide-react";
import { useMemo, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import type { TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";
import { SelectMenu } from "@/ui/components/select-menu";

type PdfKind = "pairing" | "ranking" | "result";

const kinds: { kind: PdfKind; label: string; icon: typeof Swords }[] = [
  { kind: "pairing", label: "Pairing", icon: Swords },
  { kind: "ranking", label: "Ranking", icon: ListOrdered },
  { kind: "result", label: "Result", icon: Gamepad2 },
];

/**
 * Director/admin PDF export of a published game's Pairing / Ranking / Result. The heavy PDF module
 * (jsPDF + embedded Thai font) stays out of the page bundle and is only fetched on click.
 */
export function PdfDownloadPanel({ card }: { card: TournamentCard }) {
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<number | null>(null);

  // Games with a published (confirmed) snapshot — the only ones a document can be built for.
  const publishedGameList = useMemo(() => {
    const games = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt)).flatMap((snapshot) => snapshot.gameNumbers);
    return [...new Set(games)].sort((a, b) => a - b);
  }, [card]);
  // The picker defaults to (and never points past) an available game.
  const effectiveGame = selectedGame && publishedGameList.includes(selectedGame) ? selectedGame : publishedGameList[publishedGameList.length - 1] ?? null;

  const downloadPdf = async (kind: PdfKind) => {
    if (effectiveGame === null) return;
    setDownloading(kind);
    try {
      // Only tag the header with the tournament name when we actually know it belongs to this card.
      const meta = activeTournament?.id === card.tournamentId ? { tournamentName: activeTournament.name } : {};
      const pdf = await import("@/ui/pdf/tournament-pdfs");
      if (kind === "pairing") pdf.downloadPairingPdf(card, effectiveGame, meta);
      else if (kind === "ranking") pdf.downloadRankingPdf(card, effectiveGame, meta);
      else pdf.downloadResultPdf(card, effectiveGame, meta);
    } catch {
      toast.error("สร้างไฟล์ PDF ไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Panel
      title="ดาวน์โหลดเอกสาร PDF"
      description="สร้างและบันทึกลงเครื่องทันที · ไม่บันทึกลงระบบ · เลือกได้เฉพาะเกมที่เผยแพร่ผลแล้ว"
    >
      {publishedGameList.length === 0 || effectiveGame === null ? (
        <div className="panel-padding pdf-empty">ยังไม่มีเกมที่เผยแพร่ผล — เมื่อ Publish ผลเกมใดแล้ว จะดาวน์โหลด Pairing / Ranking / Result ของเกมนั้นได้ที่นี่</div>
      ) : (
        <div className="pdf-download-row">
          <div className="pdf-download-row__pick">
            <span className="pdf-download-row__label">เลือกเกม</span>
            <SelectMenu
              ariaLabel="เลือกเกมสำหรับสร้าง PDF"
              className="pdf-game-menu"
              value={String(effectiveGame)}
              options={publishedGameList.map((game) => ({ value: String(game), label: `เกม ${game}` }))}
              onChange={(value) => setSelectedGame(Number(value))}
            />
          </div>
          <div className="pdf-download-row__actions">
            {kinds.map(({ kind, label, icon: Icon }) => (
              <Button
                key={kind}
                size="sm"
                variant="secondary"
                disabled={Boolean(downloading)}
                onClick={() => void downloadPdf(kind)}
                title={`ดาวน์โหลด ${label} เกม ${effectiveGame} เป็น PDF`}
              >
                {downloading === kind ? <LoaderCircle className="loading-spinner" size={15} /> : <Icon size={15} />}
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
