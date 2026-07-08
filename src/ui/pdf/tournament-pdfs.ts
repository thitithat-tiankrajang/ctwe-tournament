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
 * Design intent: no table gridlines. Structure comes from whitespace, aligned columns, a shaded
 * header band, and zebra banding so every record is easy to read as one unit.
 */

const FONT = "Sarabun";
const INK: RGB = [26, 28, 46];
const MUTED: RGB = [107, 114, 128];
const HEADER_BAND: RGB = [238, 242, 249];
const ZEBRA: RGB = [244, 247, 251];
const ACCENT: RGB = [22, 119, 255];
const SEAT_BG: RGB = [225, 236, 255];

type RGB = [number, number, number];
type Align = "left" | "right" | "center";
interface Column { header: string; x: number; width: number; align?: Align }

/** Optional context for the header band (the tournament this card belongs to). */
export interface PdfMeta { tournamentName?: string }

const MARGIN = 40;

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

function measure(doc: Doc, value: string, size: number, bold: boolean): number {
  doc.pdf.setFont(FONT, bold ? "bold" : "normal");
  doc.pdf.setFontSize(size);
  return doc.pdf.getTextWidth(value);
}

/** Truncate with an ellipsis so long Thai names/schools never collide with the next column. */
function clip(doc: Doc, value: string, size: number, bold: boolean, maxWidth: number): string {
  if (measure(doc, value, size, bold) <= maxWidth) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(doc, value.slice(0, mid) + "…", size, bold) <= maxWidth) low = mid; else high = mid - 1;
  }
  return value.slice(0, low) + "…";
}

function fillBand(doc: Doc, y: number, height: number, color: RGB) {
  doc.pdf.setFillColor(color[0], color[1], color[2]);
  doc.pdf.rect(MARGIN, y, doc.pageW - MARGIN * 2, height, "F");
}

/**
 * Compact header: card name with its division set right after it, the tournament name aligned to
 * the right of that same line, then the document type + game on the next line and a single accent
 * divider (a divider, not a table gridline). Returns the y where the table can begin.
 */
function drawTitle(doc: Doc, card: TournamentCard, meta: PdfMeta, docType: string, gameLabel: string): void {
  const left = MARGIN;
  const right = doc.pageW - MARGIN;
  const totalW = right - left;
  doc.y = MARGIN + 16;

  // Tournament name sits at the right of the first line (capped so it can never eat the title).
  const tournamentName = meta.tournamentName ? clip(doc, meta.tournamentName, 10.5, false, totalW * 0.42) : "";
  const tournamentW = tournamentName ? measure(doc, tournamentName, 10.5, false) : 0;
  const leftLimit = right - (tournamentW ? tournamentW + 18 : 0);

  // Card name and its division share the left side; the name is clipped first so a long name can
  // never overrun the division or the tournament (the portrait ranking header is the tight case).
  const divisionText = `รุ่น ${card.division}`;
  const divisionReserve = Math.min(measure(doc, divisionText, 10.5, false) + 12, (leftLimit - left) * 0.5);
  const nameText = clip(doc, card.name, 17, true, leftLimit - left - divisionReserve);
  text(doc, nameText, left, doc.y, { size: 17, bold: true });
  const afterName = left + measure(doc, nameText, 17, true) + 12;
  text(doc, divisionText, afterName, doc.y, { size: 10.5, color: MUTED, maxWidth: leftLimit - afterName - 6 });
  if (tournamentName) text(doc, tournamentName, right, doc.y, { size: 10.5, color: MUTED, align: "right" });

  doc.y += 19;
  text(doc, docType, left, doc.y, { size: 13, bold: true, color: ACCENT });
  text(doc, gameLabel, right, doc.y, { size: 12, bold: true, color: MUTED, align: "right" });

  doc.y += 7;
  doc.pdf.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.pdf.setLineWidth(1.2);
  doc.pdf.line(left, doc.y, right, doc.y);
  doc.y += 14;
}

function footer(doc: Doc, generatedAt: string): void {
  const pages = doc.pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.pdf.setPage(page);
    const y = doc.pageH - 20;
    text(doc, `สร้างเมื่อ ${generatedAt}`, MARGIN, y, { size: 8, color: MUTED });
    text(doc, `หน้า ${page} / ${pages}`, doc.pageW - MARGIN, y, { size: 8, color: MUTED, align: "right" });
  }
}

/** Top-based column header (band + labels), advancing the cursor past it. */
function drawColumnHeader(doc: Doc, columns: Column[], height: number): void {
  fillBand(doc, doc.y, height, HEADER_BAND);
  for (const column of columns) {
    if (!column.header) continue;
    const x = column.align === "right" ? column.x + column.width : column.align === "center" ? column.x + column.width / 2 : column.x;
    text(doc, column.header, x, doc.y + height - 7, { size: 9.5, bold: true, color: MUTED, align: column.align ?? "left" });
  }
  doc.y += height + 3;
}

/** Add a page when the next row would cross the bottom margin, repeating the column header. */
function ensureRoom(doc: Doc, rowHeight: number, redrawHeader: () => void): void {
  if (doc.y + rowHeight <= doc.pageH - MARGIN - 8) return;
  doc.pdf.addPage();
  doc.y = MARGIN + 10;
  redrawHeader();
}

const nameOf = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "";
const codeName = (code: string | null, player?: Player) => code ? `${code} ${nameOf(player)}`.trim() : "";
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

const RANK_ROW_H = 22;

export function downloadRankingPdf(card: TournamentCard, gameNumber: number, meta: PdfMeta = {}): void {
  buildRankingPdf(card, gameNumber, meta).save(filename(card, `อันดับ เกม ${gameNumber}`));
}

export function buildRankingPdf(card: TournamentCard, gameNumber: number, meta: PdfMeta = {}): jsPDF {
  const doc = newDoc("portrait");
  const players = new Map(card.players.map((player) => [player.id, player]));
  const ranked = rankingAfterGame(card, gameNumber);
  drawTitle(doc, card, meta, "อันดับการแข่งขัน", `หลังจบเกม ${gameNumber}`);

  const left = MARGIN;
  const right = doc.pageW - MARGIN;
  const rankW = 40;
  const wpW = 56;
  const diffW = 56;
  const gap = 14;
  // Athlete (code + name) and school share the remaining width equally.
  const equalW = (right - left - rankW - wpW - diffW - gap * 3) / 2;
  const nameX = left + rankW + gap;
  const schoolX = nameX + equalW + gap;
  const columns: Column[] = [
    { header: "อันดับ", x: left, width: rankW, align: "center" },
    { header: "รหัส · ชื่อ - นามสกุล", x: nameX, width: equalW },
    { header: "โรงเรียน / สถาบัน", x: schoolX, width: equalW },
    { header: "คะแนนสะสม", x: right - wpW - diffW - gap, width: wpW, align: "right" },
    { header: "ผลต่างสะสม", x: right - diffW, width: diffW, align: "right" },
  ];
  drawColumnHeader(doc, columns, RANK_ROW_H);

  ranked.forEach((entry, index) => {
    ensureRoom(doc, RANK_ROW_H, () => drawColumnHeader(doc, columns, RANK_ROW_H));
    const top = doc.y;
    if (index % 2 === 1) fillBand(doc, top, RANK_ROW_H, ZEBRA);
    const baseline = top + 15;
    const player = players.get(entry.id);
    text(doc, String(index + 1), columns[0].x + columns[0].width / 2, baseline, { size: 10, bold: true, align: "center" });
    text(doc, codeName(entry.id, player), columns[1].x, baseline, { size: 10, maxWidth: columns[1].width });
    text(doc, player?.school ?? "", columns[2].x, baseline, { size: 10, color: MUTED, maxWidth: columns[2].width });
    text(doc, String(entry.winPoints), columns[3].x + columns[3].width, baseline, { size: 10, bold: true, align: "right" });
    text(doc, signed(entry.diff), columns[4].x + columns[4].width, baseline, { size: 10, align: "right", color: MUTED });
    doc.y += RANK_ROW_H;
  });

  footer(doc, formatNow());
  return doc.pdf;
}

// ---- Pairing & Result (one physical table = two pairings per row) ---------------------------

const TABLE_ROW_H = 40;

interface HalfLayout { seatW: number; centerW: number; athleteW: number; halfW: number; gap: number; withResult: boolean }

function halfLayout(doc: Doc, withResult: boolean): HalfLayout {
  const usable = doc.pageW - MARGIN * 2;
  const gap = 22;
  const halfW = (usable - gap) / 2;
  const seatW = 24;
  const centerW = withResult ? 62 : 34;
  const athleteW = (halfW - centerW - seatW * 2) / 2;
  return { seatW, centerW, athleteW, halfW, gap, withResult };
}

/** A prominent seat badge — a filled rounded chip with the seat number, so seats read at a glance. */
function seatBadge(doc: Doc, x: number, top: number, seat: number | null) {
  if (seat === null) return;
  doc.pdf.setFillColor(SEAT_BG[0], SEAT_BG[1], SEAT_BG[2]);
  doc.pdf.roundedRect(x, top + 11, 20, 17, 3.5, 3.5, "F");
  text(doc, String(seat), x + 10, top + 23, { size: 11, bold: true, color: ACCENT, align: "center" });
}

/** Draw one pairing (two athletes + "พบ", plus score for result) inside a half-width block. */
function drawPairHalf(doc: Doc, x: number, top: number, pairing: Pairing, players: Map<string, Player>, layout: HalfLayout): void {
  const { seatW, centerW, athleteW, withResult } = layout;
  // Result rows reserve center space for the score, so their names run a touch smaller to fit.
  const nameSize = withResult ? 8.5 : 9;
  const athlete = (code: string | null, player: Player | undefined, seat: number, blockX: number) => {
    seatBadge(doc, blockX, top, code ? seat : null);
    const textX = blockX + seatW;
    if (code) {
      text(doc, codeName(code, player), textX, top + 17, { size: nameSize, bold: true, maxWidth: athleteW - seatW });
      text(doc, player?.school ?? "", textX, top + 31, { size: 7.5, color: MUTED, maxWidth: athleteW - seatW });
    } else {
      text(doc, "บาย — ไม่มีคู่แข่งขัน", textX, top + 24, { size: 8.5, color: MUTED, maxWidth: athleteW - seatW });
    }
  };
  const one = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
  const two = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
  const centerX = x + seatW + athleteW;
  athlete(pairing.playerOneId, one, seatOf(pairing.tableNumber, 1), x);
  text(doc, "พบ", centerX + centerW / 2, top + (withResult ? 17 : 24), { size: 9.5, bold: true, color: ACCENT, align: "center" });
  if (withResult) {
    const score = pairing.resultType === "PENALTY" ? "ลงดาบ" : isRecorded(pairing) ? `${pairing.scoreOne} - ${pairing.scoreTwo}` : "—";
    const diff = !isRecorded(pairing) ? ""
      : pairing.resultType === "PENALTY" ? `−${pairing.calculatedDiff ?? 0}`
      : pairing.resultType === "DRAW" ? "เสมอ 0"
      : signed(pairing.calculatedDiff ?? 0);
    text(doc, score, centerX + centerW / 2, top + 29, { size: 9.5, bold: true, align: "center" });
    if (diff) text(doc, diff, centerX + centerW / 2, top + 38, { size: 7.5, color: MUTED, align: "center" });
  }
  athlete(pairing.playerTwoId, two, seatOf(pairing.tableNumber, 2), centerX + centerW);
}

function buildTableDoc(card: TournamentCard, gameNumber: number, meta: PdfMeta, docType: string, withResult: boolean): jsPDF {
  const doc = newDoc("landscape");
  const players = new Map(card.players.map((player) => [player.id, player]));
  const pairings = publishedSnapshotPairings(card, gameNumber);
  drawTitle(doc, card, meta, docType, `เกม ${gameNumber}`);
  const layout = halfLayout(doc, withResult);

  // A "table" is two consecutive pairings (four seats). Grouping them per row shows one physical
  // table per record and doubles the density to 20 pairings a page.
  const rows: [Pairing, Pairing | undefined][] = [];
  for (let index = 0; index < pairings.length; index += 2) rows.push([pairings[index], pairings[index + 1]]);

  const columns: Column[] = [
    { header: "ที่นั่ง · นักกีฬา", x: MARGIN, width: layout.halfW },
    { header: "ที่นั่ง · นักกีฬา", x: MARGIN + layout.halfW + layout.gap, width: layout.halfW },
  ];
  const header = () => drawColumnHeader(doc, columns, 20);
  header();

  rows.forEach(([pairA, pairB], index) => {
    ensureRoom(doc, TABLE_ROW_H, header);
    const top = doc.y;
    if (index % 2 === 1) fillBand(doc, top, TABLE_ROW_H, ZEBRA);
    drawPairHalf(doc, MARGIN, top, pairA, players, layout);
    if (pairB) drawPairHalf(doc, MARGIN + layout.halfW + layout.gap, top, pairB, players, layout);
    doc.y += TABLE_ROW_H;
  });

  footer(doc, formatNow());
  return doc.pdf;
}

export function buildPairingPdf(card: TournamentCard, gameNumber: number, meta: PdfMeta = {}): jsPDF {
  return buildTableDoc(card, gameNumber, meta, "สายการแข่งขัน (Pairing)", false);
}

export function buildResultPdf(card: TournamentCard, gameNumber: number, meta: PdfMeta = {}): jsPDF {
  return buildTableDoc(card, gameNumber, meta, "ผลการแข่งขัน (Result)", true);
}

export function downloadPairingPdf(card: TournamentCard, gameNumber: number, meta: PdfMeta = {}): void {
  buildPairingPdf(card, gameNumber, meta).save(filename(card, `Pairing เกม ${gameNumber}`));
}

export function downloadResultPdf(card: TournamentCard, gameNumber: number, meta: PdfMeta = {}): void {
  buildResultPdf(card, gameNumber, meta).save(filename(card, `ผลการแข่งขัน เกม ${gameNumber}`));
}

function formatNow(): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}
