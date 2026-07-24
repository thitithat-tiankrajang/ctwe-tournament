import * as XLSX from "xlsx";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { pairingRowsForGame, resultRowsForGame } from "@/domain/tournament/documents";

/**
 * Client-side Excel export of a card's published Pairing / Ranking / Result — the same three
 * documents as the PDF export, gated the same way (`@/domain/tournament/documents`), so a Pairing
 * can be exported as soon as its game is published rather than after the game is scored.
 *
 * Everything runs in the browser and streams straight to a download; nothing is stored server-side.
 * The whole module (SheetJS included) is only reached through a dynamic import in the audit page.
 *
 * Unlike the PDF — which is laid out to be read on paper — a sheet is laid out to be *used*: one
 * flat record per row, and scores/points/diffs written as real numbers so they can be sorted,
 * filtered and summed in Excel.
 */

export interface SheetMeta { tournamentName?: string }

type Cell = string | number;

const nameOf = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "";
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;

function isRecorded(pairing: Pairing): boolean {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

function filename(card: TournamentCard, label: string): string {
  return `${card.name} ${card.division} · ${label}.xlsx`.replace(/[/\\?%*:|"<>]/g, "-");
}

function formatNow(): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

/** The identification block every sheet opens with, so a saved file explains itself. */
function heading(card: TournamentCard, meta: SheetMeta, docType: string, gameLabel: string): Cell[][] {
  return [
    ["สาย", card.name],
    ["รุ่น", card.division],
    ...(meta.tournamentName ? [["รายการ", meta.tournamentName] as Cell[]] : []),
    ["เอกสาร", docType],
    ["เกม", gameLabel],
    ["สร้างเมื่อ", formatNow()],
    [],
  ];
}

/** Widths sized to the longest cell in each column (Thai counts a touch wider than Latin). */
function columnWidths(rows: Cell[][]): XLSX.ColInfo[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const length = String(cell ?? "").length;
      widths[index] = Math.max(widths[index] ?? 0, length);
    });
  }
  return widths.map((width) => ({ wch: Math.min(Math.max(width + 2, 8), 42) }));
}

function download(card: TournamentCard, label: string, sheetName: string, rows: Cell[][], headerRowIndex: number): void {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = columnWidths(rows);
  // Keep the column header on screen while scrolling a long list of athletes/tables.
  sheet["!freeze"] = { xSplit: "0", ySplit: String(headerRowIndex + 1) };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename(card, label));
}

// ---- Ranking ---------------------------------------------------------------------------------

const RANKING_HEADER: Cell[] = ["อันดับ", "รหัส", "ชื่อ - นามสกุล", "โรงเรียน / สถาบัน", "ชนะ", "เสมอ", "แพ้", "คะแนนสะสม", "ผลต่างสะสม"];

export function downloadRankingSheet(card: TournamentCard, gameNumber: number, meta: SheetMeta = {}): void {
  const players = new Map(card.players.map((player) => [player.id, player]));
  const head = heading(card, meta, "อันดับการแข่งขัน", `หลังจบเกม ${gameNumber}`);
  const rows: Cell[][] = [...head, RANKING_HEADER];
  rankingAfterGame(card, gameNumber).forEach((entry, index) => {
    const player = players.get(entry.id);
    rows.push([index + 1, entry.id, nameOf(player), player?.school ?? "", entry.wins, entry.draws, entry.losses, entry.winPoints, entry.diff]);
  });
  download(card, `อันดับ เกม ${gameNumber}`, `อันดับ เกม ${gameNumber}`, rows, head.length);
}

// ---- Pairing & Result ------------------------------------------------------------------------

const PAIRING_HEADER: Cell[] = [
  "โต๊ะ",
  "ที่นั่ง 1", "รหัส 1", "ชื่อ - นามสกุล 1", "โรงเรียน / สถาบัน 1",
  "ที่นั่ง 2", "รหัส 2", "ชื่อ - นามสกุล 2", "โรงเรียน / สถาบัน 2",
];
const RESULT_HEADER: Cell[] = [...PAIRING_HEADER, "คะแนน 1", "คะแนน 2", "ผล", "ผู้ชนะ", "ผลต่าง"];

const BYE = "บาย";

/** The nine shared pairing columns; a bye seat keeps its table but carries no code/name/school. */
function pairingCells(pairing: Pairing, players: Map<string, Player>): Cell[] {
  const side = (code: string | null, seat: number): Cell[] => code
    ? [seat, code, nameOf(players.get(code)), players.get(code)?.school ?? ""]
    : ["", "", BYE, ""];
  return [
    pairing.tableNumber,
    ...side(pairing.playerOneId, seatOf(pairing.tableNumber, 1)),
    ...side(pairing.playerTwoId, seatOf(pairing.tableNumber, 2)),
  ];
}

function outcomeLabel(pairing: Pairing): string {
  if (!isRecorded(pairing)) return "";
  if (pairing.resultType === "PENALTY") return "ลงดาบ";
  return pairing.resultType === "DRAW" ? "เสมอ" : "ชนะ";
}

/** Result columns. A penalty subtracts from both athletes, so its diff is written as a negative. */
function resultCells(pairing: Pairing): Cell[] {
  if (!isRecorded(pairing)) return ["", "", "", "", ""];
  const diff = pairing.calculatedDiff ?? 0;
  const penalty = pairing.resultType === "PENALTY";
  return [
    pairing.scoreOne ?? "",
    pairing.scoreTwo ?? "",
    outcomeLabel(pairing),
    penalty || pairing.resultType === "DRAW" ? "" : pairing.winnerId ?? "",
    penalty ? -diff : diff,
  ];
}

export function downloadPairingSheet(card: TournamentCard, gameNumber: number, meta: SheetMeta = {}): void {
  const players = new Map(card.players.map((player) => [player.id, player]));
  const head = heading(card, meta, "สายการแข่งขัน (Pairing)", `เกม ${gameNumber}`);
  const rows: Cell[][] = [...head, PAIRING_HEADER];
  pairingRowsForGame(card, gameNumber).forEach((pairing) => rows.push(pairingCells(pairing, players)));
  download(card, `Pairing เกม ${gameNumber}`, `Pairing เกม ${gameNumber}`, rows, head.length);
}

export function downloadResultSheet(card: TournamentCard, gameNumber: number, meta: SheetMeta = {}): void {
  const players = new Map(card.players.map((player) => [player.id, player]));
  const head = heading(card, meta, "ผลการแข่งขัน (Result)", `เกม ${gameNumber}`);
  const rows: Cell[][] = [...head, RESULT_HEADER];
  resultRowsForGame(card, gameNumber).forEach((pairing) => rows.push([...pairingCells(pairing, players), ...resultCells(pairing)]));
  download(card, `ผลการแข่งขัน เกม ${gameNumber}`, `Result เกม ${gameNumber}`, rows, head.length);
}
