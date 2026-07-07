import { jsPDF } from "jspdf";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { SARABUN_REGULAR_BASE64, SARABUN_SEMIBOLD_BASE64 } from "./sarabun-font";

/**
 * Client-side PDF export for a card's published Pairing / Ranking / Result of a given game.
 *
 * Everything runs in the browser and streams straight to a download — nothing is stored on the
 * server or the database. The whole module (jsPDF + the embedded Thai font) is only ever reached
 * through a dynamic import in the audit page, so it never weighs on the initial bundle and loads
 * only when a director actually downloads a document.
 *
 * Design intent: no table gridlines. Structure comes from generous whitespace, aligned columns,
 * a shaded header band, and faint zebra banding — easy on the eyes, print-clean.
 */

const FONT = "Sarabun";
const INK: RGB = [26, 28, 46];
const MUTED: RGB = [107, 114, 128];
const HEADER_BAND: RGB = [238, 242, 249];
const ZEBRA: RGB = [248, 250, 252];
const ACCENT: RGB = [22, 119, 255];

type RGB = [number, number, number];
type Align = "left" | "right" | "center";
interface Column { header: string; x: number; width: number; align?: Align }

const MARGIN = 44;
const ROW_H = 22;
// A pairing row stacks three lines (code+seat / name / school), so it needs more vertical room
// than a single-line ranking row. Kept in sync with the baselines in drawAthleteRow.
const ATHLETE_ROW_H = 42;

interface Doc {
  pdf: jsPDF;
  pageW: number;
  pageH: number;
  y: number;
}

function newDoc(orientation: "portrait" | "landscape"): Doc {
  const pdf = new jsPDF({ orientation, unit: "pt", format: "a4", compress: true });
  pdf.addFileToVFS("Sarabun-Regular.ttf", SARABUN_REGULAR_BASE64);
  pdf.addFont("Sarabun-Regular.ttf", FONT, "normal");
  pdf.addFileToVFS("Sarabun-SemiBold.ttf", SARABUN_SEMIBOLD_BASE64);
  pdf.addFont("Sarabun-SemiBold.ttf", FONT, "bold");
  pdf.setFont(FONT, "normal");
  return { pdf, pageW: pdf.internal.pageSize.getWidth(), pageH: pdf.internal.pageSize.getHeight(), y: 0 };
}

function text(doc: Doc, value: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: RGB; align?: Align; maxWidth?: number } = {}) {
  const { size = 11, bold = false, color = INK, align = "left", maxWidth } = opts;
  doc.pdf.setFont(FONT, bold ? "bold" : "normal");
  doc.pdf.setFontSize(size);
  doc.pdf.setTextColor(color[0], color[1], color[2]);
  doc.pdf.text(maxWidth ? clip(doc, value, size, bold, maxWidth) : value, x, y, { align });
}

/** Truncate with an ellipsis so long Thai names/schools never collide with the next column. */
function clip(doc: Doc, value: string, size: number, bold: boolean, maxWidth: number): string {
  doc.pdf.setFont(FONT, bold ? "bold" : "normal");
  doc.pdf.setFontSize(size);
  if (doc.pdf.getTextWidth(value) <= maxWidth) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (doc.pdf.getTextWidth(value.slice(0, mid) + "…") <= maxWidth) low = mid; else high = mid - 1;
  }
  return value.slice(0, low) + "…";
}

function band(doc: Doc, y: number, height: number, color: RGB) {
  doc.pdf.setFillColor(color[0], color[1], color[2]);
  doc.pdf.rect(MARGIN, y, doc.pageW - MARGIN * 2, height, "F");
}

function drawTitle(doc: Doc, card: TournamentCard, docType: string, gameLabel: string): void {
  doc.y = MARGIN + 8;
  text(doc, card.name, MARGIN, doc.y, { size: 20, bold: true });
  doc.y += 18;
  text(doc, `รุ่น ${card.division}`, MARGIN, doc.y, { size: 11, color: MUTED });
  doc.y += 26;
  text(doc, docType, MARGIN, doc.y, { size: 14, bold: true, color: ACCENT });
  text(doc, gameLabel, doc.pageW - MARGIN, doc.y, { size: 12, bold: true, color: MUTED, align: "right" });
  // A single accent hairline under the title is a divider, not a table gridline.
  doc.y += 8;
  doc.pdf.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.pdf.setLineWidth(1.2);
  doc.pdf.line(MARGIN, doc.y, doc.pageW - MARGIN, doc.y);
  doc.y += 16;
}

function footer(doc: Doc, generatedAt: string): void {
  const pages = doc.pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.pdf.setPage(page);
    const y = doc.pageH - 24;
    text(doc, `สร้างเมื่อ ${generatedAt}`, MARGIN, y, { size: 8, color: MUTED });
    text(doc, `หน้า ${page} / ${pages}`, doc.pageW - MARGIN, y, { size: 8, color: MUTED, align: "right" });
  }
}

function drawColumnHeader(doc: Doc, columns: Column[]): void {
  band(doc, doc.y - 14, ROW_H, HEADER_BAND);
  for (const column of columns) {
    const x = column.align === "right" ? column.x + column.width : column.align === "center" ? column.x + column.width / 2 : column.x;
    text(doc, column.header, x, doc.y, { size: 10, bold: true, color: MUTED, align: column.align ?? "left" });
  }
  doc.y += ROW_H;
}

/** Add a page when the next row would cross the bottom margin, repeating the column header. */
function ensureRoom(doc: Doc, rowHeight: number, redrawHeader: () => void): void {
  if (doc.y + rowHeight <= doc.pageH - MARGIN - 16) return;
  doc.pdf.addPage();
  doc.y = MARGIN + 12;
  redrawHeader();
}

const nameOf = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "";
const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`);
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;

function filename(card: TournamentCard, label: string): string {
  return `${card.name} ${card.division} · ${label}.pdf`.replace(/[/\\?%*:|"<>]/g, "-");
}

function publishedSnapshotPairings(card: TournamentCard, gameNumber: number): Pairing[] {
  const snapshot = card.snapshots.find((item) => Boolean(item.confirmedAt) && item.gameNumbers.includes(gameNumber));
  return (snapshot?.pairings ?? [])
    .filter((pairing) => (pairing.gameNumber ?? gameNumber) === gameNumber)
    .sort((a, b) => a.tableNumber - b.tableNumber);
}

/** Games that have a published (confirmed) snapshot — the only games these exports can cover. */
export function publishedGames(card: TournamentCard): number[] {
  const games = card.snapshots
    .filter((snapshot) => Boolean(snapshot.confirmedAt))
    .flatMap((snapshot) => snapshot.gameNumbers);
  return [...new Set(games)].sort((a, b) => a - b);
}

function isRecorded(pairing: Pairing): boolean {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

// ---- Ranking --------------------------------------------------------------------------------

export function downloadRankingPdf(card: TournamentCard, gameNumber: number): void {
  buildRankingPdf(card, gameNumber).save(filename(card, `อันดับ เกม ${gameNumber}`));
}

export function buildRankingPdf(card: TournamentCard, gameNumber: number): jsPDF {
  const doc = newDoc("portrait");
  const players = new Map(card.players.map((player) => [player.id, player]));
  const ranked = rankingAfterGame(card, gameNumber);
  drawTitle(doc, card, "อันดับการแข่งขัน", `หลังจบเกม ${gameNumber}`);

  const left = MARGIN;
  const right = doc.pageW - MARGIN;
  const columns: Column[] = [
    { header: "อันดับ", x: left, width: 46, align: "center" },
    { header: "รหัส", x: left + 52, width: 52, align: "center" },
    { header: "ชื่อ - นามสกุล", x: left + 112, width: 176 },
    { header: "โรงเรียน / สถาบัน", x: left + 296, width: right - (left + 296) - 128 },
    { header: "คะแนนสะสม", x: right - 124, width: 58, align: "right" },
    { header: "ผลต่างสะสม", x: right - 58, width: 58, align: "right" },
  ];
  drawColumnHeader(doc, columns);

  ranked.forEach((entry, index) => {
    ensureRoom(doc, ROW_H, () => drawColumnHeader(doc, columns));
    if (index % 2 === 1) band(doc, doc.y - 14, ROW_H, ZEBRA);
    const player = players.get(entry.id);
    text(doc, String(index + 1), columns[0].x + columns[0].width / 2, doc.y, { bold: true, align: "center" });
    text(doc, entry.id, columns[1].x + columns[1].width / 2, doc.y, { align: "center", color: MUTED });
    text(doc, nameOf(player), columns[2].x, doc.y, { maxWidth: columns[2].width });
    text(doc, player?.school ?? "", columns[3].x, doc.y, { color: MUTED, maxWidth: columns[3].width });
    text(doc, String(entry.winPoints), columns[4].x + columns[4].width, doc.y, { bold: true, align: "right" });
    text(doc, signed(entry.diff), columns[5].x + columns[5].width, doc.y, { align: "right", color: MUTED });
    doc.y += ROW_H;
  });

  footer(doc, formatNow());
  return doc.pdf;
}

// ---- Pairing & Result (shared two-athlete layout) -------------------------------------------

function athleteColumns(doc: Doc, withResult: boolean): { columns: Column[]; blockWidth: number; scoreX: number; diffX: number } {
  const left = MARGIN;
  const right = doc.pageW - MARGIN;
  const resultReserve = withResult ? 150 : 0;
  const vsWidth = 40;
  const blockWidth = (right - left - vsWidth - resultReserve) / 2;
  const rightBlockX = left + blockWidth + vsWidth;
  const columns: Column[] = [
    { header: "นักกีฬา", x: left, width: blockWidth },
    { header: "", x: left + blockWidth, width: vsWidth, align: "center" },
    { header: "นักกีฬา (คู่แข่ง)", x: rightBlockX, width: blockWidth },
  ];
  if (withResult) {
    columns.push({ header: "คะแนน", x: right - resultReserve + 12, width: 84, align: "center" });
    columns.push({ header: "ผลต่าง", x: right - 54, width: 54, align: "right" });
  }
  return { columns, blockWidth, scoreX: right - resultReserve + 12 + 42, diffX: right };
}

/** Top-based column header for athlete rows so the row band lines up with the header band. */
function drawAthleteHeader(doc: Doc, columns: Column[]): void {
  band(doc, doc.y, ROW_H, HEADER_BAND);
  for (const column of columns) {
    if (!column.header) continue;
    const x = column.align === "right" ? column.x + column.width : column.align === "center" ? column.x + column.width / 2 : column.x;
    text(doc, column.header, x, doc.y + 15, { size: 10, bold: true, color: MUTED, align: column.align ?? "left" });
  }
  doc.y += ROW_H + 4;
}

/**
 * One pairing rendered top-down inside a fixed-height row: a faint code+seat line, the athlete
 * name, then the school — for both sides, with "พบ" between and the score/diff on the right.
 * Baselines are measured from the row top so nothing overlaps the next row.
 */
function drawAthleteRow(doc: Doc, pairing: Pairing, players: Map<string, Player>, blockWidth: number, columns: Column[], zebra: boolean, result?: { scoreX: number; diffX: number }): void {
  const top = doc.y;
  if (zebra) band(doc, top, ATHLETE_ROW_H, ZEBRA);
  const one = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
  const two = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;

  const block = (player: Player | undefined, code: string | null, seat: number, x: number) => {
    text(doc, code ?? "— บาย —", x, top + 13, { size: 8, color: MUTED });
    if (code) text(doc, `โต๊ะ ${pairing.tableNumber} · ที่ ${seat}`, x + blockWidth, top + 13, { size: 8, color: MUTED, align: "right" });
    text(doc, code ? nameOf(player) : "ไม่มีคู่แข่งขัน", x, top + 26, { size: 11, bold: Boolean(code), maxWidth: blockWidth });
    if (code) text(doc, player?.school ?? "", x, top + 37, { size: 8.5, color: MUTED, maxWidth: blockWidth });
  };
  block(one, pairing.playerOneId, seatOf(pairing.tableNumber, 1), columns[0].x);
  text(doc, "พบ", columns[1].x + columns[1].width / 2, top + 25, { size: 10, bold: true, color: ACCENT, align: "center" });
  block(two, pairing.playerTwoId, seatOf(pairing.tableNumber, 2), columns[2].x);

  if (result) {
    const score = pairing.resultType === "PENALTY" ? "ลงดาบ" : isRecorded(pairing) ? `${pairing.scoreOne} - ${pairing.scoreTwo}` : "—";
    const diff = !isRecorded(pairing) ? "—"
      : pairing.resultType === "PENALTY" ? `−${pairing.calculatedDiff ?? 0}`
      : pairing.resultType === "DRAW" ? "0"
      : signed(pairing.calculatedDiff ?? 0);
    text(doc, score, result.scoreX, top + 25, { size: 11, bold: true, align: "center" });
    text(doc, diff, result.diffX, top + 25, { size: 10, color: MUTED, align: "right" });
  }
  doc.y += ATHLETE_ROW_H;
}

function buildAthleteDoc(card: TournamentCard, gameNumber: number, docType: string, withResult: boolean): jsPDF {
  const doc = newDoc("landscape");
  const players = new Map(card.players.map((player) => [player.id, player]));
  const pairings = publishedSnapshotPairings(card, gameNumber);
  drawTitle(doc, card, docType, `เกม ${gameNumber}`);
  const { columns, blockWidth, scoreX, diffX } = athleteColumns(doc, withResult);
  drawAthleteHeader(doc, columns);

  pairings.forEach((pairing, index) => {
    ensureRoom(doc, ATHLETE_ROW_H, () => drawAthleteHeader(doc, columns));
    drawAthleteRow(doc, pairing, players, blockWidth, columns, index % 2 === 1, withResult ? { scoreX, diffX } : undefined);
  });

  footer(doc, formatNow());
  return doc.pdf;
}

export function buildPairingPdf(card: TournamentCard, gameNumber: number): jsPDF {
  return buildAthleteDoc(card, gameNumber, "สายการแข่งขัน (Pairing)", false);
}

export function buildResultPdf(card: TournamentCard, gameNumber: number): jsPDF {
  return buildAthleteDoc(card, gameNumber, "ผลการแข่งขัน (Result)", true);
}

export function downloadPairingPdf(card: TournamentCard, gameNumber: number): void {
  buildPairingPdf(card, gameNumber).save(filename(card, `Pairing เกม ${gameNumber}`));
}

export function downloadResultPdf(card: TournamentCard, gameNumber: number): void {
  buildResultPdf(card, gameNumber).save(filename(card, `ผลการแข่งขัน เกม ${gameNumber}`));
}

function formatNow(): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}
