"use client";

import Link from "next/link";
import { ArrowRight, ClipboardCheck, Hourglass, LockKeyhole, Megaphone, Trophy, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { rankPlayers } from "@/domain/tournament/rank-player-list";
import { appDialog } from "@/application/ui/dialog";
import { finalStandings, rankingAfterGame, type HistoryScope, type RankedPlayer } from "@/domain/tournament/history";
import { comparePlayerCodes } from "@/domain/tournament/player-code";
import type { FinalSlot, Pairing, PairingSnapshot, Player, RuntimeStage, SlotLabel, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CardNotFound } from "@/ui/components/card-not-found";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { FinalRoundBoard } from "@/ui/components/final-round-board";
import { SpectatorFinals } from "@/ui/components/spectator-finals";
import { DocumentDownloadPanel } from "@/ui/components/document-download-panel";
import { PlayerHistoryTable } from "@/ui/components/player-history-table";
import { SpectatorPairList, SpectatorStandingList } from "@/ui/components/spectator-report-lists";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";
import { SelectMenu } from "@/ui/components/select-menu";
import { stageLabels } from "@/ui/components/stage-info";
import { OverviewRecordFilter, matchesRecordQuery, type OverviewRecordFilterValue } from "@/ui/components/overview-record-filter";
import type { SpectatorReportContext } from "@/application/tournament/spectator-route";

export type OverviewView = "ranking" | "pairing" | "result";

const publishedAtText = (iso: string) =>
  `เผยแพร่ผลเมื่อ ${new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}`;

function workflowHref(cardId: string, stage: RuntimeStage) {
  if (stage === "PLAYER_REGISTRATION") return `/cards/${cardId}/players`;
  if (stage === "TABLE_PAIRING" || stage === "PAIRING_PREVIEW") return `/cards/${cardId}/tables`;
  if (stage === "RESULT_COLLECTION" || stage === "RESULT_REVIEW" || stage === "FINAL_SEEDING" || stage === "FINAL_COLLECTION") return `/cards/${cardId}/games`;
  return `/cards/${cardId}`;
}

/** Seat number for a player in a pairing (seat 1 = couple n → seats 2n-1 / 2n). */
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;
const athleteName = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "";

/** Two-line athlete cell: name (black) over school (dark grey), shared by pairing + result viewers. */
function AthleteCell({ player, gibsonized = false, onOpenPlayer }: {
  player?: Player;
  gibsonized?: boolean;
  onOpenPlayer?: (player: Player) => void;
}) {
  const name = athleteName(player);
  const content = (
    <div className="cell-athlete">
      <span className="cell-athlete__name" title={name}><span>{name}</span>{gibsonized && <span className="gibson-mark">GIB</span>}</span>
      <span className="cell-athlete__school" title={player?.school}>{player?.school ?? ""}</span>
    </div>
  );
  return player && onOpenPlayer
    ? <button type="button" className="spectator-athlete-link" onClick={() => onOpenPlayer(player)}>{content}</button>
    : content;
}

function isRecorded(pairing: Pairing) {
  return pairing.scoreOne != null && pairing.scoreTwo != null && Boolean(pairing.resultType);
}

/**
 * The overview shows what the audience is meant to see. Rows of an unconfirmed snapshot count only
 * once the director published them: PAIR_RESULT materialises the destination game's pairings while
 * the source game is still being scored, and those stay backstage (even for logged-in staff, whose
 * card payload contains them) until the explicit "Publish Pairing" milestone.
 */
function overviewPairings(snapshot: PairingSnapshot) {
  return snapshot.confirmedAt ? snapshot.pairings : snapshot.pairings.filter((pairing) => pairing.pairingPublished);
}

/** Games of a snapshot that have at least one overview-visible pairing row. */
function overviewGames(snapshot: PairingSnapshot) {
  if (snapshot.confirmedAt) return snapshot.gameNumbers;
  const games = new Set(overviewPairings(snapshot).map((pairing) => pairing.gameNumber ?? snapshot.gameNumbers[0]));
  return snapshot.gameNumbers.filter((game) => games.has(game));
}

function RankingTable({ players, selectedId, onPlayerClick, resizableColumns, emptyText, stacked = false, spectator = false }: {
  players: ReturnType<typeof rankingAfterGame>;
  emptyText: string;
  selectedId?: string | null;
  onPlayerClick?: (player: Player) => void;
  resizableColumns: boolean;
  /** Public portrait phones read the same rows as a list; the grid cannot fit nine columns there. */
  stacked?: boolean;
  spectator?: boolean;
}) {
  if (stacked) {
    const byId = new Map(players.map((player) => [player.id, player]));
    return <SpectatorStandingList
      rows={players.map((player) => ({ rank: player.displayRank, id: player.id,
        name: `${player.firstName} ${player.lastName}`, school: player.school,
        figures: { winPoints: player.winPoints, diff: player.diff, scoreFor: player.scoreFor,
          average: player.games > 0 ? player.average.toFixed(1) : "—" } }))}
      selectedId={selectedId}
      onRowClick={onPlayerClick ? (id) => { const player = byId.get(id); if (player) onPlayerClick(player); } : undefined}
      emptyText={emptyText} />;
  }
  // The rank comes from the ranking rule, not from the row's position: players the rules could not
  // separate SHARE a number (1, 2, 2, 4), which a positional index cannot express.
  const rows = players.map((player) => ({ player, rank: player.displayRank }));
  const identityLink = (player: RankedPlayer, content: React.ReactNode) => spectator && onPlayerClick
    ? <button type="button" className="spectator-player-identity-link" onClick={() => onPlayerClick(player)}>{content}</button>
    : content;
  const columns: DataColumn<{ player: RankedPlayer; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 48, width: 58, align: "center", priority: "identity", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัส", min: 50, width: 60, align: "center", filterKind: "playerCode", priority: "identity", cellClassName: "cell-id", value: ({ player }) => player.id, render: ({ player }) => identityLink(player, player.id) },
    { key: "name", label: "ชื่อ - นามสกุล", min: 120, width: 250, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 120, width: 250, priority: "secondary", cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนสะสม", min: 76, width: 90, align: "center", value: ({ player }) => player.winPoints, render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 82, width: 96, align: "center", value: ({ player }) => player.diff, filterable: false, render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
    // ScoreFor and Average Score decide the order once WinPoint and Diff are level, so they are
    // shown: a tie broken by a number nobody can see reads as arbitrary, which is the complaint
    // that started this work.
    { key: "scoreFor", label: spectator ? "คะแนนรวม" : "แต้มรวม", min: 72, width: 86, align: "center", priority: "secondary", value: ({ player }) => player.scoreFor, filterable: false, render: ({ player }) => player.scoreFor },
    { key: "average", label: spectator ? "คะแนนเฉลี่ย" : "แต้มเฉลี่ย", min: 76, width: 90, align: "center", value: ({ player }) => player.average, filterable: false, render: ({ player }) => player.games > 0 ? player.average.toFixed(1) : "—" },
  ];
  return <DataGrid ariaLabel="ตารางอันดับ" columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:ranking:v3" tableClassName="entry-grid--ranking" emptyText={emptyText} resizableColumns={resizableColumns} onRowClick={!spectator && onPlayerClick ? (row) => onPlayerClick(row.player) : undefined} rowClassName={selectedId ? (row) => row.player.id === selectedId ? "egrid-row--active" : undefined : undefined} />;
}

/**
 * Final placings shown after the whole card is done: only rank / name / school (no points), and a
 * click opens the player's master card. The championship result is already baked into the order.
 */
function FinalResultsList({ standings, onPlayerClick, resizableColumns, stacked = false, spectator = false }: {
  standings: Player[];
  onPlayerClick: (player: Player) => void;
  resizableColumns: boolean;
  stacked?: boolean;
  spectator?: boolean;
}) {
  if (stacked) return <SpectatorStandingList
    rows={standings.map((player, index) => ({ rank: index + 1, id: player.id,
      name: `${player.firstName} ${player.lastName}`, school: player.school }))}
    onRowClick={(id) => { const player = standings.find((item) => item.id === id); if (player) onPlayerClick(player); }}
    emptyText="ยังไม่มีผลการแข่งขัน" />;
  const rows = standings.map((player, index) => ({ player, rank: index + 1 }));
  const identityLink = (player: Player, content: React.ReactNode) => spectator
    ? <button type="button" className="spectator-player-identity-link" onClick={() => onPlayerClick(player)}>{content}</button>
    : content;
  const columns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 48, width: 64, align: "center", priority: "identity", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "name", label: "ชื่อ - นามสกุล", min: 140, width: 300, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => identityLink(player, <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span>) },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 140, width: 320, priority: "secondary", cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
  ];
  return <DataGrid ariaLabel="ผลรอบชิงชนะเลิศ" columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey="overview:final-result" tableClassName="entry-grid--ranking" emptyText="ยังไม่มีผลการแข่งขัน" resizableColumns={resizableColumns} onRowClick={!spectator ? (row) => onPlayerClick(row.player) : undefined} />;
}

/**
 * `slotLabel` is the card's answer to "which number does this event announce": PAIR or SEAT. It is
 * null for staff, who need the operational seat numbers whatever the audience is told.
 */
/**
 * The slot column, in whichever of its two forms this card announces.
 *
 * A PAIR card carries ONE leading คู่ที่ column and no seat columns — pair n is one number for both
 * competitors, so side 2 contributes nothing. A SEAT card carries a ที่นั่ง column on each side, as
 * every report did before the choice existed, and so does staff (`null`).
 */
function pairOrSeat(slotLabel: SlotLabel | null, side: 1 | 2): DataColumn<Pairing>[] {
  if (slotLabel === "PAIR")
    return side === 2 ? [] : [{
      key: "pair", label: "คู่ที่", min: 44, width: 58, align: "center", priority: "identity",
      cellClassName: "cell-seat", value: (pairing) => pairing.tableNumber, filterable: false,
      render: (pairing) => pairing.tableNumber,
    }];
  return [{
    key: `seat${side}`, label: "ที่นั่ง", min: 38, width: 50, align: "center",
    priority: side === 1 ? "identity" : undefined, cellClassName: "cell-seat",
    value: (pairing) => seatOf(pairing.tableNumber, side), filterable: false,
    render: (pairing) => seatOf(pairing.tableNumber, side),
  }];
}

function PairingGrid({ pairings, players, resizableColumns, emptyText, slotLabel, stacked = false, onPlayerClick }: { pairings: Pairing[]; players: Map<string, Player>; resizableColumns: boolean; emptyText: string; slotLabel: SlotLabel | null; stacked?: boolean; onPlayerClick?: (player: Player) => void }) {
  if (stacked) return <SpectatorPairList pairings={pairings} players={players} mode="pairing" slotLabel={slotLabel ?? "PAIR"} onOpenPlayer={onPlayerClick} emptyText={emptyText} />;
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const columns: DataColumn<Pairing>[] = [
    ...pairOrSeat(slotLabel, 1),
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", field: "code", priority: "identity", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 150, width: 300, field: "name", priority: "primary", value: (pairing) => athleteName(playerOf(pairing.playerOneId)), searchText: (pairing) => `${athleteName(playerOf(pairing.playerOneId))} ${playerOf(pairing.playerOneId)?.school ?? ""}`, render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} gibsonized={pairing.playerOneGibsonized} onOpenPlayer={onPlayerClick} /> },
    { key: "vs", label: "", min: 42, width: 56, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    ...pairOrSeat(slotLabel, 2),
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", searchable: false, field: "code", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 150, width: 300, searchable: false, field: "name", priority: "primary", value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), searchText: (pairing) => `${athleteName(playerOf(pairing.playerTwoId))} ${playerOf(pairing.playerTwoId)?.school ?? ""}`, render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} gibsonized={pairing.playerTwoGibsonized} onOpenPlayer={onPlayerClick} /> },
  ];
  return <DataGrid ariaLabel="ตารางประกบคู่" columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={`overview:pairing:${slotLabel ?? "STAFF"}`} tableClassName="entry-grid--match" emptyText={emptyText} resizableColumns={resizableColumns} rowClassName={(pairing) => pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "egrid-row--gibson" : undefined} />;
}

function ResultTable({ pairings, players, storageKey, resizableColumns, emptyText, slotLabel, stacked = false, onPlayerClick }: { pairings: Pairing[]; players: Map<string, Player>; storageKey: string; resizableColumns: boolean; emptyText: string; slotLabel: SlotLabel | null; stacked?: boolean; onPlayerClick?: (player: Player) => void }) {
  if (stacked) return <SpectatorPairList pairings={pairings} players={players} mode="result" slotLabel={slotLabel ?? "PAIR"} onOpenPlayer={onPlayerClick} emptyText={emptyText} />;
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const scoreText = (pairing: Pairing) => pairing.resultType === "PENALTY" ? "ลงดาบ" : isRecorded(pairing) ? `${pairing.scoreOne} - ${pairing.scoreTwo}` : "—";
  const longestScore = pairings.reduce((longest, pairing) => Math.max(longest, scoreText(pairing).length), "คะแนน".length);
  const diffOf = (pairing: Pairing) => !isRecorded(pairing) ? null : pairing.resultType === "DRAW" ? 0 : pairing.calculatedDiff ?? 0;
  const diffText = (pairing: Pairing) => {
    if (!isRecorded(pairing)) return "—";
    if (pairing.resultType === "PENALTY") return `−${pairing.calculatedDiff ?? 0}`;
    const diff = diffOf(pairing);
    return diff === 0 ? "0" : `${diff}`;
  };
  const columns: DataColumn<Pairing>[] = [
    ...pairOrSeat(slotLabel, 1),
    { key: "id1", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", field: "code", priority: "identity", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "นักกีฬา", min: 140, width: 300, field: "name", priority: "primary", value: (pairing) => athleteName(playerOf(pairing.playerOneId)), searchText: (pairing) => `${athleteName(playerOf(pairing.playerOneId))} ${playerOf(pairing.playerOneId)?.school ?? ""}`, render: (pairing) => <AthleteCell player={playerOf(pairing.playerOneId)} gibsonized={pairing.playerOneGibsonized} onOpenPlayer={onPlayerClick} /> },
    { key: "vs", label: "", min: 40, width: 52, align: "center", cellClassName: "cell-vs", render: () => "พบ" },
    ...pairOrSeat(slotLabel, 2),
    { key: "id2", label: "รหัส", min: 52, width: 68, align: "center", filterKind: "playerCode", searchable: false, field: "code", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "นักกีฬา", min: 140, width: 300, searchable: false, field: "name", priority: "primary", value: (pairing) => athleteName(playerOf(pairing.playerTwoId)), searchText: (pairing) => `${athleteName(playerOf(pairing.playerTwoId))} ${playerOf(pairing.playerTwoId)?.school ?? ""}`, render: (pairing) => <AthleteCell player={playerOf(pairing.playerTwoId)} gibsonized={pairing.playerTwoGibsonized} onOpenPlayer={onPlayerClick} /> },
    { key: "score", label: "คะแนน", min: 36, width: 68, fitContent: true, align: "center", cellClassName: "cell-score", value: (pairing) => scoreText(pairing), filterable: false, render: (pairing) => scoreText(pairing) },
    { key: "diff", label: "ผลต่าง", min: 56, width: 68, align: "center", cellClassName: (pairing) => `cell-diff cell-diff--${pairing.resultType === "PENALTY" ? "penalty" : "win"}`, value: (pairing) => diffOf(pairing) ?? -1, filterable: false, render: (pairing) => diffText(pairing) },
  ];
  return <DataGrid ariaLabel="ตารางผลการแข่งขัน" columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={`${storageKey}:layout-v4:${slotLabel ?? "STAFF"}:score-content-${longestScore}`} tableClassName="entry-grid--match" emptyText={emptyText} resizableColumns={resizableColumns} rowClassName={(pairing) => pairing.playerOneGibsonized || pairing.playerTwoGibsonized ? "egrid-row--gibson" : undefined} />;
}

function FinalHistoryDialog({ slot, players, onClose }: { slot: FinalSlot; players: Map<string, Player>; onClose: () => void }) {
  const name = (id: string) => {
    const player = players.get(id);
    return player ? `${player.id} · ${player.firstName} ${player.lastName}` : id;
  };
  const school = (id: string) => players.get(id)?.school ?? "—";
  const winnerName = slot.winnerId ? name(slot.winnerId) : "ยังไม่สรุป";
  const dialog = useModalDialog({ open: true, onDismiss: onClose });
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section ref={dialog.ref as React.RefObject<HTMLElement>} tabIndex={-1} className="history-table-dialog final-history-dialog" role="dialog" aria-modal="true" aria-labelledby={dialog.titleId} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>ประวัติรอบชิง</span><h2 id={dialog.titleId}>{slot.slot === 0 ? "คู่ชิงอันดับ 1 - 2" : "คู่ชิงอันดับ 3 - 4"}</h2></div>
          <button type="button" className="confirm-dialog__close" aria-label="ปิดประวัติรอบชิง" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="final-history-matchup">
          <strong>{name(slot.playerOneId)}</strong><span>พบ</span><strong>{name(slot.playerTwoId)}</strong>
          <small>{school(slot.playerOneId)} · {school(slot.playerTwoId)}</small>
        </div>
        <table className="data-table final-history-table" aria-label="ประวัติเกมรอบชิงชนะเลิศ">
          <thead><tr><th scope="col">เกม</th><th scope="col" className="numeric">คะแนน</th><th scope="col">ผู้ชนะเกม</th><th scope="col" className="numeric">diff</th></tr></thead>
          <tbody>
            {slot.games.map((game) => (
              <tr key={game.gameIndex}>
                <td>เกม {game.gameIndex}</td>
                <td className="numeric">{game.scoreOne == null || game.scoreTwo == null ? "—" : `${game.scoreOne} - ${game.scoreTwo}`}</td>
                <td>{game.winnerId ? name(game.winnerId) : game.scoreOne != null && game.scoreTwo != null ? "เสมอ" : "—"}</td>
                <td className="numeric">{game.diff ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="final-history-summary">
          <CrownBadge />
          <strong>{winnerName}</strong>
          <span>ชนะ {slot.winnerWins ?? "—"} เกม · แพ้ {slot.winnerLosses ?? "—"} เกม · Total diff {slot.totalDiff == null ? "—" : `${slot.totalDiff > 0 ? "+" : ""}${slot.totalDiff}`}</span>
        </div>
      </section>
    </div>
  );
}

function CrownBadge() {
  return <span className="final-history-crown">★</span>;
}

/**
 * The card's current headline state, split into two signals with different jobs:
 *
 * - `forcedKey` changes ONLY on the big publishes — a pairing publish (`pairing:N`) or a ranking
 *   publish (`ranking:N`) — and steering follows it live: whoever is watching gets switched to
 *   that view the moment the director publishes.
 * - `entryView` additionally prefers Result once the game has its first recorded score, but it is
 *   applied only when (re)entering the card — a result trickling in never yanks the viewer away
 *   from whatever they chose to look at.
 */
function overviewViewState(card: TournamentCard | undefined): { forcedKey: string; forcedView: OverviewView; entryView: OverviewView; activeGame: number } | null {
  if (!card) return null;
  const visibleSnapshots = card.snapshots.filter((snapshot) =>
    Boolean(snapshot.confirmedAt)
    || card.runtimeStage !== "PAIRING_PREVIEW"
    || !snapshot.gameNumbers.includes(card.currentGame));
  const latestGame = Math.max(0, ...visibleSnapshots.flatMap(overviewGames));
  const activeGame = latestGame > 0 ? latestGame : card.currentGame;
  const snapshot = visibleSnapshots.find((item) => overviewGames(item).includes(activeGame));
  if (!snapshot) return null;
  if (snapshot.confirmedAt) return { forcedKey: `ranking:${activeGame}`, forcedView: "ranking", entryView: "ranking", activeGame };
  const currentPairings = overviewPairings(snapshot).filter((pairing) => (pairing.gameNumber ?? activeGame) === activeGame);
  // Loose != : an unscored pairing arrives with the score fields OMITTED (undefined), not null.
  const hasFirstResult = currentPairings.some((pairing) => pairing.scoreOne != null || pairing.scoreTwo != null);
  return { forcedKey: `pairing:${activeGame}`, forcedView: "pairing", entryView: hasFirstResult ? "result" : "pairing", activeGame };
}

/**
 * True on phone-width screens (D15/UX-F3).
 *
 * `useSyncExternalStore` rather than an effect so the very first client render already has the right
 * answer and hydration does not warn: the server snapshot is the desktop default, which is also the
 * safe one — multi-select degrades to "you can open more than one panel", never to a lost view.
 */
function useNarrowViewport(media: string = NARROW_VIEWPORT) {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(media);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(media).matches,
    () => false,
  );
}

const NARROW_VIEWPORT = "(max-width: 768px)";
/** Where a nine-column report stops fitting on a portrait phone and becomes a list instead. */
const PHONE_VIEWPORT = "(max-width: 640px)";

/**
 * What the view picker shows after tapping `view` (D15/UX-F3).
 *
 * Desktop keeps multi-select: the panels sit side by side, and comparing Pairing against Ranking is
 * the whole reason a spectator opens both. A phone shows one panel per screenful, so "adding" a
 * second only buries the first under a scroll — there, picking a view REPLACES the current one.
 * Deselecting the only open view is allowed in both modes, so the tables can be collapsed away.
 *
 * Pure and exported so the rule is testable without a DOM; the component only supplies `narrow`.
 */
export function nextOverviewViews(
  current: ReadonlySet<OverviewView>,
  view: OverviewView,
  narrow: boolean,
): Set<OverviewView> {
  if (narrow) return current.has(view) ? new Set<OverviewView>() : new Set<OverviewView>([view]);
  const next = new Set(current);
  if (next.has(view)) next.delete(view); else next.add(view);
  return next;
}

/** What a publish announcement says. The viewer chooses to follow it; nothing moves on its own. */
const announcementCopy: Record<OverviewView, (game: number) => { text: string; action: string }> = {
  ranking: (game) => ({ text: `ประกาศอันดับของเกม ${game} แล้ว`, action: "ดูอันดับ" }),
  pairing: (game) => ({ text: `ประกาศคู่แข่งขันของเกม ${game} แล้ว`, action: "ดูคู่แข่งขัน" }),
  result: (game) => ({ text: `มีผลการแข่งขันใหม่ของเกม ${game}`, action: "ดูผล" }),
};

const spectatorViewLabel: Record<OverviewView, string> = {
  ranking: "อันดับ",
  pairing: "คู่แข่งขัน",
  result: "ผล",
};

/** Transitional presentation shared by isolated public reads and the operational wrapper. */
export function CardOverviewView({ cardId: id, card, loading = false, canManage = false, resizableColumns = false, allowDownloads = false, spectator = false, initialSpectatorContext = null, onSpectatorPlayer, onClose }: {
  cardId: string;
  card?: TournamentCard;
  loading?: boolean;
  canManage?: boolean;
  resizableColumns?: boolean;
  allowDownloads?: boolean;
  /** Public viewer. Only presentation follows from it — the data, ordering and rules are identical. */
  spectator?: boolean;
  /** Public identity activation opens the one canonical Player destination. */
  onSpectatorPlayer?: (player: Player, context: SpectatorReportContext) => void;
  /** Context restored by Back or by the Player → division report action. */
  initialSpectatorContext?: SpectatorReportContext | null;
  onClose?: (id: string) => Promise<void>;
}) {
  const restoredContext = spectator ? initialSpectatorContext : null;
  const [historyGame, setHistoryGame] = useState<number | "final" | "result" | null>(restoredContext?.game ?? null);
  const [views, setViews] = useState<Set<OverviewView>>(() => new Set<OverviewView>(restoredContext?.views ?? []));
  const [selectedRankingPlayerId, setSelectedRankingPlayerId] = useState<string | null>(null);
  const [historyPlayerId, setHistoryPlayerId] = useState<string | null>(null);
  const [finalHistorySlot, setFinalHistorySlot] = useState<FinalSlot | null>(null);
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [recordFilter, setRecordFilter] = useState<OverviewRecordFilterValue>(restoredContext?.filter ?? { mode: "player", playerIds: [], schools: [], query: "" });
  /** A publish the viewer has been TOLD about but has not chosen to follow yet (D15/UX-F3). */
  const [announcement, setAnnouncement] = useState<{ view: OverviewView; game: number } | null>(null);
  const narrow = useNarrowViewport();
  const phone = useNarrowViewport(PHONE_VIEWPORT);
  const stacked = spectator && phone;
  // Staff keep both numbers; the audience sees the one this card announces.
  const viewerSlotLabel: SlotLabel | null = spectator ? card?.slotLabel ?? "PAIR" : null;
  const viewState = overviewViewState(card);
  const enteredCardRef = useRef<string | null>(null);
  const appliedForcedKeyRef = useRef<string | null>(null);
  // The player-history dialog is rendered inline far below, past the loading and not-found early
  // returns — so its hook belongs up here with the others rather than beside its JSX. Declared next
  // to the markup it drives, it ran on some renders and not others, and the first render that got
  // past those returns crashed the whole overview with React #310. It is inert while the id is null.
  const historyDialog = useModalDialog({ open: historyPlayerId !== null, onDismiss: () => setHistoryPlayerId(null) });

  useEffect(() => {
    setRecordFilter(restoredContext?.filter ?? { mode: "player", playerIds: [], schools: [], query: "" });
  }, [id]);

  // Entering a card still applies the entry default (Result once a first score exists) — that is the
  // opening state, not a jump.
  //
  // What a publish does has CHANGED (D15/UX-F3). It used to replace the viewer's selection outright:
  // whatever you were reading was swapped for Pairing or Ranking the instant the director published.
  // For a spectator following one player mid-table that is the screen being taken away, and it is
  // worse on a phone where the swapped-in panel fills the viewport. A publish now raises a banner and
  // the viewer decides. Nothing moves until they tap it.
  //
  // Still keyed on forcedKey advancing, so a re-run with the same key (StrictMode double-invoke, an
  // unrelated re-render) neither re-announces nor disturbs the current selection.
  useEffect(() => {
    if (!viewState) return;
    if (enteredCardRef.current !== id) {
      enteredCardRef.current = id;
      appliedForcedKeyRef.current = viewState.forcedKey;
      setAnnouncement(null);
      setHistoryGame(restoredContext?.game ?? null);
      setViews(new Set<OverviewView>(restoredContext ? restoredContext.views : [viewState.entryView]));
      return;
    }
    if (appliedForcedKeyRef.current === viewState.forcedKey) return;
    appliedForcedKeyRef.current = viewState.forcedKey;
    setAnnouncement({ view: viewState.forcedView, game: viewState.activeGame });
  }, [id, viewState?.forcedKey]);

  useEffect(() => {
    if (!selectedRankingPlayerId) return;
    const clearSelectionOutsideTable = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".overview-ranking-panel")) return;
      setSelectedRankingPlayerId(null);
    };
    document.addEventListener("pointerdown", clearSelectionOutsideTable);
    return () => document.removeEventListener("pointerdown", clearSelectionOutsideTable);
  }, [selectedRankingPlayerId]);

  if (loading || card?.summaryOnly) return <div className="panel panel-padding">กำลังโหลดข้อมูลการแข่งขัน…</div>;
  if (!card) return <CardNotFound />;
  const visibleSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt) || card.runtimeStage !== "PAIRING_PREVIEW" || !snapshot.gameNumbers.includes(card.currentGame));
  const publishedSnapshots = visibleSnapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const publishedGames = new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const visibleGames = new Set(visibleSnapshots.flatMap(overviewGames));
  const finalConfigured = card.finalType !== "NONE";
  const hasFinalRound = finalConfigured && Boolean(card.finalRound);
  const finalActive = hasFinalRound && (card.runtimeStage === "FINAL_COLLECTION" || card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED");
  const latestVisibleGame = Math.max(0, ...visibleSnapshots.flatMap(overviewGames));
  const currentVisibleGame = latestVisibleGame > 0 ? latestVisibleGame : card.currentGame;
  const selectedFinal = finalConfigured && (historyGame === "final" || (historyGame == null && finalActive));
  const selectedResultSummary = historyGame === "result";
  const selectedGame = typeof historyGame === "number" && visibleGames.has(historyGame) ? historyGame : currentVisibleGame;
  const selectedSnapshot = visibleSnapshots.find((snapshot) => overviewGames(snapshot).includes(selectedGame));
  const selectedPairings = selectedSnapshot ? overviewPairings(selectedSnapshot).filter((pairing) => (pairing.gameNumber ?? selectedGame) === selectedGame) : [];
  const rankingCard = { ...card, snapshots: publishedSnapshots };
  // Before any result exists there is nothing to rank on, but the list still goes through the
  // engine so the pre-game order and the in-play order are produced by one rule.
  const historicalRanking = selectedGame > 0 ? rankingAfterGame(rankingCard, selectedGame) : rankPlayers(card.players.filter((player) => !player.terminated));
  const players = new Map(card.players.map((player) => [player.id, player]));
  const activeRecordValues = recordFilter.mode === "player" ? recordFilter.playerIds : recordFilter.schools;
  // What the viewer TYPED counts as part of the filter, alongside the chips they pinned. Both are
  // ways of naming records to keep, so a row survives if either names it.
  const recordQueryActive = recordFilter.query.trim() !== "";
  const recordFilterActive = activeRecordValues.length > 0 || recordQueryActive;
  const matchesRecordFilter = (playerId: string | null) => {
    if (!recordFilterActive) return true;
    if (!playerId) return false;
    const pinned = recordFilter.mode === "player"
      ? recordFilter.playerIds.includes(playerId)
      : recordFilter.schools.includes(players.get(playerId)?.school ?? "");
    if (pinned) return true;
    const player = players.get(playerId);
    return recordQueryActive && Boolean(player) && matchesRecordQuery(player!, recordFilter);
  };
  const visibleRanking = recordFilterActive
    ? historicalRanking.filter((player) => matchesRecordFilter(player.id))
    : historicalRanking;
  const visiblePairings = recordFilterActive
    ? selectedPairings.filter((pairing) => matchesRecordFilter(pairing.playerOneId) || matchesRecordFilter(pairing.playerTwoId))
    : selectedPairings;
  const selectedResultsPublished = Boolean(selectedSnapshot?.confirmedAt);
  // Loose != : an unscored pairing arrives with the score fields OMITTED (undefined), not null.
  const selectedHasResults = selectedPairings.some((pairing) => pairing.scoreOne != null || pairing.scoreTwo != null);
  const selectedResultsVisible = selectedResultsPublished || selectedHasResults;
  // A filter that excluded everything is NOT the same as a game with nothing in it. Both used to
  // render the identical "ไม่พบคู่ตามตัวกรอง", so a viewer could not tell whether their search was
  // wrong or the data simply was not there yet.
  const filteredToZero = recordFilterActive && selectedPairings.length > 0 && visiblePairings.length === 0;
  const rankingFilteredToZero = recordFilterActive && historicalRanking.length > 0 && visibleRanking.length === 0;
  const emptyPairingText = filteredToZero
    ? `ไม่มีคู่ในเกม ${selectedGame} ที่ตรงกับการค้นหา — ล้างการค้นหาเพื่อดูทั้งหมด`
    : "ยังไม่มีคู่แข่งขันในเกมนี้";
  const emptyRankingText = rankingFilteredToZero
    ? "ไม่มีผู้เล่นที่ตรงกับการค้นหา — ล้างการค้นหาเพื่อดูทั้งหมด"
    : "ยังไม่มีผู้เล่นในอันดับนี้";
  const viewUnavailable: Record<OverviewView, boolean> = {
    ranking: historicalRanking.length === 0,
    pairing: selectedPairings.length === 0,
    result: !selectedResultsVisible,
  };
  const viewUnavailableTitle: Record<OverviewView, string> = spectator ? {
    ranking: "อันดับจะแสดงเมื่อมีรายชื่อผู้เล่น",
    pairing: "คู่แข่งขันจะแสดงเมื่อเผยแพร่คู่แข่งขันของเกมนี้",
    result: "ผลจะแสดงเมื่อมีการบันทึกคะแนนคู่แรกของเกมนี้",
  } : {
    ranking: "Ranking จะเปิดให้ดูเมื่อมีรายชื่อผู้เล่น",
    pairing: "Pairing จะเปิดให้ดูเมื่อเผยแพร่คู่แข่งขันของเกมนี้",
    result: "Result จะเปิดให้ดูเมื่อมีการบันทึกคะแนนคู่แรกของเกมนี้",
  };
  const historyPlayer = historyPlayerId ? players.get(historyPlayerId) : undefined;
  // The master card follows the game the viewer has open. Scope is stated, not baked into a
  // pre-filtered card: filtering whole snapshots dropped game N whenever its snapshot also
  // carried game N+1 (a PAIR_RESULT block), which left game 1 showing an empty history.
  // The championship round joins only on the final / result views, so a qualifying-game view
  // never folds championship score or diff into its cumulative totals.
  const historyScope: HistoryScope = {
    throughGame: selectedFinal || selectedResultSummary ? latestVisibleGame : selectedGame,
    includeFinal: selectedFinal || selectedResultSummary,
  };
  const final = card.runtimeStage === "FINAL_PUBLISHED" || card.status === "FINISHED" || card.status === "CLOSED";
  const canClose = card.status === "FINISHED" && canManage;
  // Final placings (bracket-aware) for the "ผลการแข่งขัน" view, shown once the card is finished.
  const finalResults = selectedResultSummary ? finalStandings(rankingCard, latestVisibleGame) : [];
  const gameOptions = [...visibleGames].sort((a, b) => a - b)
    .map((game) => ({ value: String(game), label: `เกม ${game}` }))
    .concat(finalConfigured ? [{ value: "final", label: "รอบชิง" }] : [])
    .concat(final ? [{ value: "result", label: "ผลการแข่งขัน" }] : []);
  // Desktop keeps multi-select: the panels sit side by side, and comparing Pairing against Ranking
  // is the whole reason a spectator opens both. A phone shows one panel per screenful, so "adding" a
  // second only buries the first under a scroll — there, picking a view REPLACES the current one
  // (D15/UX-F3). Deselecting the only open view is allowed on both, so the tables can be collapsed.
  const toggleView = (view: OverviewView) => {
    const opening = !views.has(view);
    setViews((prev) => nextOverviewViews(prev, view, narrow));
    // Opening the view a banner was offering answers it; leaving it up would be nagging.
    if (opening && announcement?.view === view) setAnnouncement(null);
    if (opening && narrow) {
      window.setTimeout(() => document.getElementById(`overview-view-${view}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };

  /** Follow a publish announcement: go to the game it is about, open its view, clear the banner. */
  const followAnnouncement = () => {
    if (!announcement) return;
    setHistoryGame(null);
    setViews((prev) => narrow ? new Set<OverviewView>([announcement.view]) : new Set(prev).add(announcement.view));
    setAnnouncement(null);
    if (narrow) {
      window.setTimeout(() => document.getElementById(`overview-view-${announcement.view}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };

  const currentSpectatorContext = (): SpectatorReportContext => ({
    game: historyGame,
    views: [...views],
    filter: {
      mode: recordFilter.mode,
      playerIds: [...recordFilter.playerIds],
      schools: [...recordFilter.schools],
      query: recordFilter.query,
    },
    scrollY: typeof window === "undefined" ? 0 : window.scrollY,
  });

  const selectRankingPlayer = (player: Player) => {
    if (spectator && onSpectatorPlayer) {
      onSpectatorPlayer(player, currentSpectatorContext());
      return;
    }
    if (selectedRankingPlayerId === player.id) {
      setHistoryPlayerId(player.id);
      return;
    }
    setSelectedRankingPlayerId(player.id);
    setHistoryPlayerId(null);
  };
  const openSpectatorPlayer = spectator && onSpectatorPlayer
    ? (player: Player) => onSpectatorPlayer(player, currentSpectatorContext())
    : undefined;

  return (
    <>
      <PageHeader
        className={`overview-page-header${final ? " overview-page-header--complete" : ""}`}
        title={<>{card.name}{card.division && <span className="page-title-inline-subtitle">{card.division}</span>}</>}
        actions={(visibleSnapshots.length > 0 || final || finalConfigured) ? (
          <div className="overview-header-actions">
            {visibleSnapshots.length > 0 && (
              <div className="overview-header-controls">
                <div className="overview-game-filter-row">
                  {!selectedFinal && !selectedResultSummary && <OverviewRecordFilter players={card.players.filter((player) => !player.terminated)} value={recordFilter} onChange={setRecordFilter} />}
                  <div className="overview-game-menu-wrap">
                    <SelectMenu
                      ariaLabel="เลือกเกม"
                      className={`overview-game-menu${selectedFinal ? " overview-game-menu--final" : ""}`}
                      value={selectedResultSummary ? "result" : selectedFinal ? "final" : String(selectedGame)}
                      options={gameOptions}
                      onChange={(value) => setHistoryGame(value === "final" ? "final" : value === "result" ? "result" : Number(value))}
                      onOpenChange={setGameMenuOpen}
                    />
                  </div>
                </div>
                {/*
                  The roles follow the behaviour rather than the other way round: a phone picks ONE
                  view, which is a radio group, while desktop toggles several, which is aria-pressed.
                  Announcing a multi-select as radios (or the reverse) is exactly the mismatch UX-F3
                  filed — "a segmented picker that is really multi-select".
                */}
                {!selectedFinal && !selectedResultSummary && <div className="segmented overview-view-picker" role={narrow ? "radiogroup" : "group"} aria-label="เลือกมุมมอง">
                  {(["ranking", "pairing", "result"] as const).map((view) => {
                    const unavailable = viewUnavailable[view];
                    const active = views.has(view) && !unavailable;
                    const label = spectator ? spectatorViewLabel[view] : view === "ranking" ? "Ranking" : view === "pairing" ? "Pairing" : "Result";
                    return (
                      <button
                        key={view}
                        type="button"
                        className={`segment${active ? " segment--on" : ""}`}
                        role={narrow ? "radio" : undefined}
                        {...(narrow ? { "aria-checked": active } : { "aria-pressed": active })}
                        disabled={unavailable}
                        title={unavailable ? viewUnavailableTitle[view] : undefined}
                        onClick={() => toggleView(view)}
                      >{label}</button>
                    );
                  })}
                </div>}
              </div>
            )}
            {final && <Badge tone="warning">จบแล้ว</Badge>}
          </div>
        ) : undefined}
      />

      {/*
        D15/UX-F3: a publish used to swap the viewer's screen out from under them. It now announces
        itself and waits. `aria-live="polite"` so a screen reader hears it without being interrupted,
        and the dismiss is a real control rather than a timeout — an announcement the viewer has not
        acted on should still be there when they look up from the board.
      */}
      {announcement && !viewUnavailable[announcement.view] && (
        <div className="notice notice--info overview-announcement" role="status" aria-live="polite">
          <Megaphone size={20} />
          <p><strong>{announcementCopy[announcement.view](announcement.game).text}</strong></p>
          <div className="overview-announcement-actions">
            <Button size="sm" onClick={followAnnouncement}>
              {announcementCopy[announcement.view](announcement.game).action} <ArrowRight size={15} />
            </Button>
            <button
              type="button"
              className="overview-announcement-dismiss"
              aria-label="ปิดการแจ้งเตือน"
              onClick={() => setAnnouncement(null)}
            ><X size={16} /></button>
          </div>
        </div>
      )}

      {selectedFinal && spectator && <SpectatorFinals card={card} onOpenPlayer={openSpectatorPlayer} />}
      {selectedFinal && !spectator && card.finalRound && <FinalRoundBoard card={card} readOnly onSlotHistory={setFinalHistorySlot} />}

      {selectedResultSummary && (
        <Panel className="overview-data-panel overview-ranking-panel" title="ผลการแข่งขัน (อันดับสุดท้าย)" description={hasFinalRound ? "คำนวณผลรอบชิงแล้ว — ผู้ชนะคู่ชิงอยู่อันดับสูงกว่า" : undefined}>
          <FinalResultsList standings={finalResults} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} stacked={stacked} spectator={spectator} />
        </Panel>
      )}

      {canManage && !final && (
        <div className="notice notice--info workflow-notice"><ClipboardCheck size={20} /><p><strong>ขั้นตอนปัจจุบัน: {stageLabels[card.runtimeStage]}</strong><span>เกม {card.currentGame} จาก {card.games.length} · ทำงานต่อในหน้าที่ระบบกำหนด</span></p><Link prefetch={false} href={workflowHref(id, card.runtimeStage)}><Button size="sm">ทำงานต่อ <ArrowRight size={15} /></Button></Link></div>
      )}

      {/* Spectators see why the latest game has nothing yet, instead of a silently stale screen. */}
      {!canManage && !final && !selectedFinal && visibleSnapshots.length > 0
        && latestVisibleGame < card.currentGame && card.currentGame <= card.games.length && (
        <div className="notice notice--info"><Hourglass size={18} /><p>
          <strong>{card.runtimeStage === "TABLE_PAIRING" || card.runtimeStage === "PAIRING_PREVIEW"
            ? `กำลังจัดคู่เกม ${card.currentGame}`
            : `เกม ${card.currentGame} กำลังแข่งขัน`}</strong>
          <span>ข้อมูลจะอัปเดตที่นี่อัตโนมัติทันทีที่เผยแพร่</span>
        </p></div>
      )}

      {!selectedFinal && !selectedResultSummary && (visibleSnapshots.length === 0 ? (
        card.players.length > 0 ? <>
          <Panel className="overview-data-panel overview-ranking-panel" title={spectator ? "อันดับเริ่มต้น" : "Ranking เริ่มต้น"}>
            <RankingTable players={visibleRanking} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} emptyText={emptyRankingText} stacked={stacked} spectator={spectator} />
          </Panel>
          <Panel><EmptyState icon={<Trophy size={26} />} title={spectator ? "ยังไม่มีคู่แข่งขันที่เผยแพร่" : "ยังไม่มี Pairing ที่เผยแพร่"} description={spectator ? "คู่แข่งขันเกมแรกจะแสดงทันทีที่ผู้จัดเผยแพร่" : "เมื่อผู้อำนวยการยืนยัน Pairing เกมแรก ตารางคู่แข่งขันจะปรากฏที่นี่ทันที"} /></Panel>
        </> : <Panel><EmptyState icon={<Trophy size={26} />} title="กำลังรอรายชื่อผู้เล่น" description="รายชื่อและ Ranking เริ่มต้นจะปรากฏหลังผู้อำนวยการจบการลงทะเบียน" /></Panel>
      ) : (
        <>
          {views.size === 0 && <Panel><EmptyState icon={<ClipboardCheck size={24} />} title="ยังไม่ได้เลือกมุมมอง" description={spectator ? "เลือกอันดับ คู่แข่งขัน หรือผลการแข่งขัน" : "เลือกมุมมอง ผลการจัดอันดับ / ผลประกบคู่ / ผลการแข่งขัน เพื่อแสดงข้อมูลที่ต้องการ"} /></Panel>}

          {views.has("ranking") && (
            <Panel id="overview-view-ranking" className="overview-data-panel overview-view-section overview-ranking-panel" title={spectator
              ? selectedResultsPublished ? `อันดับ · หลังจบเกม ${selectedGame}` : selectedHasResults ? `อันดับ · ก่อนจบเกม ${selectedGame}` : `อันดับ · ก่อนเริ่มเกม ${selectedGame}`
              : selectedResultsPublished ? `RANKING (ผลการจัดอันดับ หลังจบเกม ${selectedGame})` : selectedHasResults ? `RANKING (ผลการจัดอันดับ ก่อนจบเกม ${selectedGame})` : `RANKING (ผลการจัดอันดับ ก่อนเริ่มเกม ${selectedGame})`} description={selectedResultsPublished && selectedSnapshot?.confirmedAt ? publishedAtText(selectedSnapshot.confirmedAt) : undefined}>
              <RankingTable players={visibleRanking} selectedId={selectedRankingPlayerId} onPlayerClick={selectRankingPlayer} resizableColumns={resizableColumns} emptyText={emptyRankingText} stacked={stacked} spectator={spectator} />
            </Panel>
          )}

          {views.has("pairing") && (
            <Panel id="overview-view-pairing" className="overview-data-panel overview-view-section" title={spectator ? `คู่แข่งขัน · เกม ${selectedGame}` : `PAIRING (ผลประกบคู่ เกม ${selectedGame})`}>
              <PairingGrid pairings={visiblePairings} players={players} resizableColumns={resizableColumns} emptyText={emptyPairingText} slotLabel={viewerSlotLabel} stacked={stacked} onPlayerClick={openSpectatorPlayer} />
            </Panel>
          )}

          {views.has("result") && selectedResultsVisible && (
            <Panel id="overview-view-result" className="overview-data-panel overview-view-section" title={spectator ? `ผลการแข่งขัน · เกม ${selectedGame}` : `RESULT (ผลการแข่งขัน เกม ${selectedGame})`} description={selectedSnapshot?.confirmedAt ? publishedAtText(selectedSnapshot.confirmedAt) : undefined}>
              <ResultTable pairings={visiblePairings} players={players} storageKey={`${id}:overview:results`} resizableColumns={resizableColumns} emptyText={emptyPairingText} slotLabel={viewerSlotLabel} stacked={stacked} onPlayerClick={openSpectatorPlayer} />
            </Panel>
          )}

          <nav className="overview-mobile-nav" aria-label="มุมมองข้อมูลการแข่งขัน">
            {(["ranking", "pairing", "result"] as const).map((view) => {
              const unavailable = viewUnavailable[view];
              const active = views.has(view) && !unavailable;
              return (
                <button key={view} type="button" className={active ? "overview-mobile-nav__button overview-mobile-nav__button--on" : "overview-mobile-nav__button"} aria-pressed={active} disabled={unavailable} title={unavailable ? viewUnavailableTitle[view] : undefined} onClick={() => toggleView(view)}>
                  {spectator ? spectatorViewLabel[view] : view === "ranking" ? "RANKING" : view === "pairing" ? "PAIRING" : "RESULT"}
                </button>
              );
            })}
          </nav>
        </>
      ))}

      {/* Back-office extras live below the spectator content: document export, then the danger zone. */}
      {allowDownloads && <DocumentDownloadPanel card={card} />}
      {canClose && (
        <Panel className="panel--danger" title="ปิดการ์ดถาวร" description="การ์ดที่ปิดแล้วจะแก้ไขข้อมูลใด ๆ ไม่ได้อีก — ทำเมื่อการแข่งขันจบสมบูรณ์แล้วเท่านั้น">
          <div className="panel-padding">
            <Button variant="danger" onClick={async () => {
              if (await appDialog.confirm("การ์ดที่ปิดแล้วจะไม่สามารถแก้ไขได้อีก", { title: "ปิดการ์ดถาวรหรือไม่?", confirmLabel: "ปิดการ์ด", danger: true })) await onClose?.(id);
            }}><LockKeyhole size={16} />ปิดการ์ดถาวร</Button>
          </div>
        </Panel>
      )}

      {!spectator && historyPlayer && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={historyDialog.onBackdropMouseDown}>
          <section ref={historyDialog.ref as React.RefObject<HTMLElement>} tabIndex={-1} className="history-table-dialog" role="dialog" aria-modal="true" aria-labelledby={historyDialog.titleId} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span>ประวัติการแข่งขัน</span><h2 id={historyDialog.titleId}>{historyPlayer.id} · {historyPlayer.firstName} {historyPlayer.lastName}</h2></div>
              <button type="button" className="confirm-dialog__close" aria-label="ปิดประวัติ" onClick={() => setHistoryPlayerId(null)}><X size={18} /></button>
            </header>
            <div className="history-table-dialog__summary">{historyPlayer.school} · แสดงประวัติถึงเกม {historyScope.throughGame}{historyScope.includeFinal ? " · รวมรอบชิง" : ""}</div>
            <PlayerHistoryTable card={rankingCard} players={players} playerId={historyPlayer.id} scope={historyScope} stacked={stacked} />
          </section>
        </div>
      )}
      {finalHistorySlot && <FinalHistoryDialog slot={finalHistorySlot} players={players} onClose={() => setFinalHistorySlot(null)} />}
    </>
  );
}
