"use client";

import { FileSpreadsheet, FileText, Gamepad2, ListOrdered, LoaderCircle, Swords } from "lucide-react";
import { useMemo, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { availableGames, type DocumentKind } from "@/domain/tournament/documents";
import type { TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";
import { SelectMenu } from "@/ui/components/select-menu";

type Format = "pdf" | "excel";

const kinds: { kind: DocumentKind; label: string; icon: typeof Swords }[] = [
  { kind: "pairing", label: "Pairing", icon: Swords },
  { kind: "ranking", label: "Ranking", icon: ListOrdered },
  { kind: "result", label: "Result", icon: Gamepad2 },
];

const formats: { format: Format; label: string; icon: typeof FileText }[] = [
  { format: "pdf", label: "PDF", icon: FileText },
  { format: "excel", label: "Excel", icon: FileSpreadsheet },
];

/**
 * Director/admin export of a published game's Pairing / Ranking / Result, as PDF or Excel.
 *
 * Each document is offered the moment it exists rather than only once a game is fully over: a
 * Pairing can be downloaded as soon as its pairings are published, while Ranking and Result wait
 * for that game's results to be published. The picker therefore lists every game with *something*
 * to export, and the buttons that game has nothing for are disabled with the reason in their title.
 *
 * Both heavy generators (jsPDF + the embedded Thai font, SheetJS) stay out of the page bundle and
 * are only fetched on click.
 */
export function DocumentDownloadPanel({ card }: { card: TournamentCard }) {
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const [downloading, setDownloading] = useState<DocumentKind | null>(null);
  const [format, setFormat] = useState<Format>("pdf");
  const [selectedGame, setSelectedGame] = useState<number | null>(null);

  const gamesByKind = useMemo(() => ({
    pairing: availableGames(card, "pairing"),
    ranking: availableGames(card, "ranking"),
    result: availableGames(card, "result"),
  }), [card]);
  const gameList = useMemo(
    () => [...new Set([...gamesByKind.pairing, ...gamesByKind.ranking, ...gamesByKind.result])].sort((a, b) => a - b),
    [gamesByKind],
  );
  // The picker defaults to (and never points past) a game that has at least one document.
  const effectiveGame = selectedGame && gameList.includes(selectedGame) ? selectedGame : gameList[gameList.length - 1] ?? null;

  const downloadDocument = async (kind: DocumentKind) => {
    if (effectiveGame === null) return;
    setDownloading(kind);
    try {
      // Only tag the header with the tournament name when we actually know it belongs to this card.
      const meta = activeTournament?.id === card.tournamentId ? { tournamentName: activeTournament.name } : {};
      if (format === "pdf") {
        const pdf = await import("@/ui/pdf/tournament-pdfs");
        if (kind === "pairing") pdf.downloadPairingPdf(card, effectiveGame, meta);
        else if (kind === "ranking") pdf.downloadRankingPdf(card, effectiveGame, meta);
        else pdf.downloadResultPdf(card, effectiveGame, meta);
      } else {
        const sheets = await import("@/ui/export/tournament-sheets");
        if (kind === "pairing") sheets.downloadPairingSheet(card, effectiveGame, meta);
        else if (kind === "ranking") sheets.downloadRankingSheet(card, effectiveGame, meta);
        else sheets.downloadResultSheet(card, effectiveGame, meta);
      }
    } catch {
      toast.error(format === "pdf" ? "สร้างไฟล์ PDF ไม่สำเร็จ กรุณาลองอีกครั้ง" : "สร้างไฟล์ Excel ไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Panel
      title="ดาวน์โหลดเอกสาร PDF / Excel"
      description="สร้างและบันทึกลงเครื่องทันที · ไม่บันทึกลงระบบ · Pairing ดาวน์โหลดได้ทันทีที่เผยแพร่สาย · Ranking / Result ดาวน์โหลดได้เมื่อเผยแพร่ผลเกมนั้นแล้ว"
    >
      {effectiveGame === null ? (
        <div className="panel-padding doc-download__empty">ยังไม่มีเกมที่เผยแพร่ — เมื่อเผยแพร่สายหรือผลของเกมใดแล้ว จะดาวน์โหลด Pairing / Ranking / Result ของเกมนั้นได้ที่นี่</div>
      ) : (
        <div className="doc-download">
          <div className="doc-download__pick">
            <span className="doc-download__label">เลือกเกม</span>
            <SelectMenu
              ariaLabel="เลือกเกมสำหรับสร้างเอกสาร"
              className="doc-download__menu"
              value={String(effectiveGame)}
              options={gameList.map((game) => ({ value: String(game), label: `เกม ${game}` }))}
              onChange={(value) => setSelectedGame(Number(value))}
            />
            <div className="doc-download__formats" role="group" aria-label="รูปแบบไฟล์">
              {formats.map(({ format: option, label, icon: Icon }) => (
                <Button
                  key={option}
                  size="sm"
                  variant={format === option ? "primary" : "ghost"}
                  aria-pressed={format === option}
                  disabled={Boolean(downloading)}
                  onClick={() => setFormat(option)}
                >
                  <Icon size={15} />
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className="doc-download__actions">
            {kinds.map(({ kind, label, icon: Icon }) => {
              const ready = gamesByKind[kind].includes(effectiveGame);
              return (
                <Button
                  key={kind}
                  size="sm"
                  variant="secondary"
                  disabled={Boolean(downloading) || !ready}
                  onClick={() => void downloadDocument(kind)}
                  title={ready
                    ? `ดาวน์โหลด ${label} เกม ${effectiveGame} เป็น ${format === "pdf" ? "PDF" : "Excel"}`
                    : kind === "pairing"
                      ? `ยังไม่ได้เผยแพร่สายของเกม ${effectiveGame}`
                      : `ยังไม่ได้เผยแพร่ผลของเกม ${effectiveGame}`}
                >
                  {downloading === kind ? <LoaderCircle className="loading-spinner" size={15} /> : <Icon size={15} />}
                  {label}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}
