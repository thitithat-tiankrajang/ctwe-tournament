import { jsPDF } from "jspdf";
import type { Pairing, Player, TournamentCard } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { pairingRowsForGame, resultRowsForGame } from "@/domain/tournament/documents";
import { SARABUN_REGULAR_BASE64, SARABUN_SEMIBOLD_BASE64 } from "./sarabun-font";
import {
  needsThaiClusterLayout,
  thaiClusters,
  thaiMarkAnchorX,
  thaiMarkOffsets,
  type ThaiCluster,
} from "./thai-text-layout";

/**
 * Client-side PDF export for a card's published Pairing / Ranking / Result of a given game.
 *
 * Each document is built from whatever is published right now — a Pairing can be exported the
 * moment its game's pairings go live, without waiting for the game to be scored. See
 * `@/domain/tournament/documents` for the per-document gates.
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
const PAIR_BG_A: RGB = [238, 246, 255];
const PAIR_BG_B: RGB = [255, 248, 229];
const ACCENT: RGB = [22, 119, 255];
const SEAT_BG: RGB = [225, 236, 255];

type RGB = [number, number, number];
type Align = "left" | "right" | "center";
interface Column { header: string; x: number; width: number; align?: Align }

/** Optional context for the header band (the tournament this card belongs to). */
export interface PdfMeta { tournamentName?: string }

const MARGIN = 40;
const GRAPHEME_SEGMENTER = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter("th", { granularity: "grapheme" })
  : null;

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
  const fitted = maxWidth ? clip(doc, value, size, bold, maxWidth) : value;
  if (needsThaiClusterLayout(fitted)) {
    drawThaiText(doc, fitted, x, y, size, bold, align);
    return;
  }
  doc.pdf.text(fitted, x, y, { align });
}

function rawMeasure(doc: Doc, value: string, size: number, bold: boolean): number {
  doc.pdf.setFont(FONT, bold ? "bold" : "normal");
  doc.pdf.setFontSize(size);
  return doc.pdf.getTextWidth(value);
}

function clusterAdvance(doc: Doc, cluster: ThaiCluster, size: number, bold: boolean): number {
  return rawMeasure(doc, cluster.prefix + cluster.base + cluster.suffix, size, bold);
}

function measureClusters(doc: Doc, clusters: ThaiCluster[], size: number, bold: boolean): number {
  return clusters.reduce((total, cluster) => total + clusterAdvance(doc, cluster, size, bold), 0);
}

function measure(doc: Doc, value: string, size: number, bold: boolean): number {
  return needsThaiClusterLayout(value)
    ? measureClusters(doc, thaiClusters(value), size, bold)
    : rawMeasure(doc, value, size, bold);
}

function drawThaiText(doc: Doc, value: string, x: number, y: number, size: number, bold: boolean, align: Align): void {
  const clusters = thaiClusters(value);
  const width = measureClusters(doc, clusters, size, bold);
  let cursor = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
  for (const cluster of clusters) cursor += drawThaiCluster(doc, cluster, cursor, y, size, bold);
}

function drawThaiCluster(doc: Doc, cluster: ThaiCluster, x: number, y: number, size: number, bold: boolean): number {
  const prefixW = rawMeasure(doc, cluster.prefix, size, bold);
  const baseW = rawMeasure(doc, cluster.base, size, bold);
  if (cluster.prefix) doc.pdf.text(cluster.prefix, x, y);
  if (cluster.base) doc.pdf.text(cluster.base, x + prefixW, y);
  if (cluster.suffix) doc.pdf.text(cluster.suffix, x + prefixW + baseW, y);

  const markAnchorX = thaiMarkAnchorX(x, prefixW, baseW);
  const offsets = thaiMarkOffsets(cluster, size);
  const drawMarks = (marks: string[], yOffsets: number[]) => {
    marks.forEach((mark, index) => {
      doc.pdf.text(mark, markAnchorX, y + yOffsets[index]);
    });
  };
  drawMarks(cluster.lower, offsets.lower);
  drawMarks(cluster.upper, offsets.upper);
  drawMarks(cluster.tone, offsets.tone);
  return clusterAdvance(doc, cluster, size, bold);
}

function graphemes(value: string): string[] {
  return GRAPHEME_SEGMENTER
    ? Array.from(GRAPHEME_SEGMENTER.segment(value), (part) => part.segment)
    : Array.from(value);
}

/** Truncate with an ellipsis so long Thai names/schools never collide with the next column. */
function clip(doc: Doc, value: string, size: number, bold: boolean, maxWidth: number): string {
  if (measure(doc, value, size, bold) <= maxWidth) return value;
  const parts = graphemes(value);
  let low = 0, high = parts.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(doc, parts.slice(0, mid).join("") + "…", size, bold) <= maxWidth) low = mid; else high = mid - 1;
  }
  return parts.slice(0, low).join("") + "…";
}

function fillBand(doc: Doc, y: number, height: number, color: RGB) {
  doc.pdf.setFillColor(color[0], color[1], color[2]);
  doc.pdf.rect(MARGIN, y, doc.pageW - MARGIN * 2, height, "F");
}

function fillCell(doc: Doc, x: number, y: number, width: number, height: number, color: RGB) {
  doc.pdf.setFillColor(color[0], color[1], color[2]);
  doc.pdf.rect(x, y, width, height, "F");
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
    text(doc, column.header, x, doc.y + height - 7, { size: 9.5, bold: true, color: MUTED, align: column.align ?? "left", maxWidth: column.width });
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

function isRecorded(pairing: Pairing): boolean {
  return pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined && Boolean(pairing.resultType);
}

// ---- Ranking --------------------------------------------------------------------------------

const RANK_HEADER_H = 24;
const RANK_ROW_H = 28;
const RANK_TEXT_SIZE = 9.4;

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
  drawColumnHeader(doc, columns, RANK_HEADER_H);

  ranked.forEach((entry, index) => {
    ensureRoom(doc, RANK_ROW_H, () => drawColumnHeader(doc, columns, RANK_HEADER_H));
    const top = doc.y;
    if (index % 2 === 1) fillBand(doc, top, RANK_ROW_H, ZEBRA);
    const baseline = top + 19;
    const player = players.get(entry.id);
    text(doc, String(index + 1), columns[0].x + columns[0].width / 2, baseline, { size: RANK_TEXT_SIZE, bold: true, align: "center" });
    text(doc, codeName(entry.id, player), columns[1].x, baseline, { size: RANK_TEXT_SIZE, maxWidth: columns[1].width });
    text(doc, player?.school ?? "", columns[2].x, baseline, { size: RANK_TEXT_SIZE, color: MUTED, maxWidth: columns[2].width });
    text(doc, String(entry.winPoints), columns[3].x + columns[3].width, baseline, { size: RANK_TEXT_SIZE, bold: true, align: "right" });
    text(doc, signed(entry.diff), columns[4].x + columns[4].width, baseline, { size: RANK_TEXT_SIZE, align: "right", color: MUTED });
    doc.y += RANK_ROW_H;
  });

  footer(doc, formatNow());
  return doc.pdf;
}

// ---- Pairing & Result (one physical table = two pairings per row) ---------------------------

const PAIRING_ROW_H = 48;
const RESULT_ROW_H = 54;
const CELL_PAD_X = 8;
const PLAYER_INNER_GAP = 10;
const PLAYER_SEAT_W = 24;

interface HalfLayout {
  playerW: number;
  resultW: number;
  halfW: number;
  gap: number;
  innerGap: number;
  padX: number;
  rowH: number;
  withResult: boolean;
}

function halfLayout(doc: Doc, withResult: boolean): HalfLayout {
  const usable = doc.pageW - MARGIN * 2;
  const gap = 22;
  const halfW = (usable - gap) / 2;
  const padX = CELL_PAD_X;
  const innerGap = PLAYER_INNER_GAP;
  const contentW = halfW - padX * 2;
  const resultW = withResult ? 80 : 0;
  const playerW = withResult ? (contentW - resultW - innerGap * 2) / 2 : (contentW - innerGap) / 2;
  const rowH = withResult ? RESULT_ROW_H : PAIRING_ROW_H;
  return { playerW, resultW, halfW, gap, innerGap, padX, rowH, withResult };
}

/** A prominent seat badge — a filled rounded chip with the seat number, so seats read at a glance. */
function seatBadge(doc: Doc, x: number, top: number, seat: number | null) {
  if (seat === null) return;
  doc.pdf.setFillColor(SEAT_BG[0], SEAT_BG[1], SEAT_BG[2]);
  doc.pdf.roundedRect(x, top + 14, 20, 18, 3.5, 3.5, "F");
  text(doc, String(seat), x + 10, top + 27, { size: 10.5, bold: true, color: ACCENT, align: "center" });
}

function resultLabel(pairing: Pairing): string {
  return `${pairing.playerOneId ?? "บาย"} พบ ${pairing.playerTwoId ?? "บาย"}`;
}

function scoreText(pairing: Pairing): string {
  return pairing.resultType === "PENALTY" ? "ลงดาบ" : isRecorded(pairing) ? `${pairing.scoreOne} - ${pairing.scoreTwo}` : "—";
}

function diffText(pairing: Pairing): string {
  if (!isRecorded(pairing)) return "";
  if (pairing.resultType === "PENALTY") return `−${pairing.calculatedDiff ?? 0}`;
  if (pairing.resultType === "DRAW") return "เสมอ 0";
  return signed(pairing.calculatedDiff ?? 0);
}

/** Draw one pairing inside a half-width block. Pairing has two player info columns; result adds a third. */
function drawPairHalf(doc: Doc, x: number, top: number, pairing: Pairing, players: Map<string, Player>, layout: HalfLayout): void {
  const { playerW, resultW, innerGap, padX, withResult } = layout;
  const nameSize = withResult ? 8.2 : 9.1;
  const nameY = top + 18;
  const schoolY = top + 39;
  const athlete = (code: string | null, player: Player | undefined, seat: number, blockX: number) => {
    seatBadge(doc, blockX, top, code ? seat : null);
    const textX = blockX + PLAYER_SEAT_W;
    const maxWidth = playerW - PLAYER_SEAT_W - 2;
    if (code) {
      text(doc, codeName(code, player), textX, nameY, { size: nameSize, bold: true, maxWidth });
      text(doc, player?.school ?? "", textX, schoolY, { size: 7.4, color: MUTED, maxWidth });
    } else {
      text(doc, "บาย — ไม่มีคู่แข่งขัน", textX, top + 30, { size: 8.5, color: MUTED, maxWidth });
    }
  };
  const one = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
  const two = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
  const playerOneX = x + padX;
  const playerTwoX = playerOneX + playerW + innerGap;
  athlete(pairing.playerOneId, one, seatOf(pairing.tableNumber, 1), playerOneX);
  athlete(pairing.playerTwoId, two, seatOf(pairing.tableNumber, 2), playerTwoX);
  if (withResult) {
    const resultX = playerTwoX + playerW + innerGap;
    const centerX = resultX + resultW / 2;
    text(doc, resultLabel(pairing), centerX, top + 17, { size: 8.2, bold: true, color: ACCENT, align: "center", maxWidth: resultW });
    text(doc, scoreText(pairing), centerX, top + 35, { size: 9.5, bold: true, align: "center", maxWidth: resultW });
    const diff = diffText(pairing);
    if (diff) text(doc, diff, centerX, top + 48, { size: 7.4, color: MUTED, align: "center", maxWidth: resultW });
  }
}

function tableColumns(layout: HalfLayout): Column[] {
  const halfXs = [MARGIN, MARGIN + layout.halfW + layout.gap];
  return halfXs.flatMap((halfX) => {
    const playerOneX = halfX + layout.padX;
    const playerTwoX = playerOneX + layout.playerW + layout.innerGap;
    const columns: Column[] = [
      { header: "ข้อมูลผู้เล่นคนที่ 1", x: playerOneX, width: layout.playerW },
      { header: "ข้อมูลผู้เล่นคนที่ 2", x: playerTwoX, width: layout.playerW },
    ];
    if (layout.withResult) columns.push({ header: "Result", x: playerTwoX + layout.playerW + layout.innerGap, width: layout.resultW, align: "center" });
    return columns;
  });
}

function pairCellColor(rowIndex: number, columnIndex: number): RGB {
  return (rowIndex + columnIndex) % 2 === 0 ? PAIR_BG_A : PAIR_BG_B;
}

function buildTableDoc(card: TournamentCard, gameNumber: number, meta: PdfMeta, docType: string, withResult: boolean): jsPDF {
  const doc = newDoc("landscape");
  const players = new Map(card.players.map((player) => [player.id, player]));
  const pairings = withResult ? resultRowsForGame(card, gameNumber) : pairingRowsForGame(card, gameNumber);
  drawTitle(doc, card, meta, docType, `เกม ${gameNumber}`);
  const layout = halfLayout(doc, withResult);

  // A "table" is two consecutive pairings (four seats). Grouping them per row keeps the page dense
  // while each pair still reads as one colored cell.
  const rows: [Pairing, Pairing | undefined][] = [];
  for (let index = 0; index < pairings.length; index += 2) rows.push([pairings[index], pairings[index + 1]]);

  const columns = tableColumns(layout);
  const header = () => drawColumnHeader(doc, columns, 20);
  header();

  rows.forEach(([pairA, pairB], index) => {
    ensureRoom(doc, layout.rowH, header);
    const top = doc.y;
    fillCell(doc, MARGIN, top, layout.halfW, layout.rowH - 2, pairCellColor(index, 0));
    if (pairB) fillCell(doc, MARGIN + layout.halfW + layout.gap, top, layout.halfW, layout.rowH - 2, pairCellColor(index, 1));
    drawPairHalf(doc, MARGIN, top, pairA, players, layout);
    if (pairB) drawPairHalf(doc, MARGIN + layout.halfW + layout.gap, top, pairB, players, layout);
    doc.y += layout.rowH;
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
