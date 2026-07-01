"use client";

import type { Pairing, Player } from "@/domain/tournament/types";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";

/** Standings table (rank, code, name, school, win points, total diff, W/D/L) shared by every page. */
export function RankingGrid({ ranked, storageKey, resetKey, emptyText = "ไม่พบผู้เล่นตามตัวกรอง", onRowClick, activeId }: {
  ranked: Player[];
  storageKey: string;
  resetKey?: string;
  emptyText?: string;
  onRowClick?: (player: Player) => void;
  activeId?: string | null;
}) {
  const rows = ranked.map((player, index) => ({ player, rank: index + 1 }));
  const columns: DataColumn<{ player: Player; rank: number }>[] = [
    { key: "rank", label: "อันดับ", min: 68, width: 84, align: "right", value: ({ rank }) => rank, filterable: false, render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัส", min: 54, width: 70, filterKind: "playerCode", cellClassName: "cell-id", value: ({ player }) => player.id, render: ({ player }) => player.id },
    { key: "name", label: "ชื่อ-นามสกุล", min: 110, width: 170, cellClassName: "cell-person-name", value: ({ player }) => `${player.firstName} ${player.lastName}`, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 110, width: 170, cellClassName: "cell-person-school cell-ranking-school", value: ({ player }) => player.school, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนสะสม", min: 104, width: 132, align: "right", value: ({ player }) => player.winPoints, render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 104, width: 132, align: "right", value: ({ player }) => player.diff, filterable: false, render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
    { key: "wdl", label: "ชนะ / เสมอ / แพ้", min: 100, width: 142, align: "center", value: ({ player }) => `${player.wins} / ${player.draws} / ${player.losses}`, render: ({ player }) => `${player.wins} / ${player.draws} / ${player.losses}` },
  ];
  return <DataGrid columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey={`${storageKey}:ranking-v2`} resetKey={resetKey} tableClassName="entry-grid--ranking" unit="คน" emptyText={emptyText} onRowClick={onRowClick ? (row) => onRowClick(row.player) : undefined} rowClassName={activeId ? (row) => row.player.id === activeId ? "egrid-row--active" : undefined : undefined} />;
}

/** Pairing table (pair number, both players with a "พบกับ" divider) shared by every page. */
export function PairingGrid({ pairings, players, storageKey, resetKey, emptyText = "ไม่พบคู่ตามตัวกรอง" }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  storageKey: string;
  resetKey?: string;
  emptyText?: string;
}) {
  const playerOf = (playerId: string | null) => playerId ? players.get(playerId) : undefined;
  const fullName = (playerId: string | null) => { const player = playerOf(playerId); return `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim() || "รอคู่แข่ง"; };
  const seatOne = (pairing: Pairing) => (pairing.tableNumber - 1) * 2 + 1;
  const columns: DataColumn<Pairing>[] = [
    { key: "pair", label: "คู่", min: 44, width: 56, align: "right", value: (pairing) => pairing.tableNumber, filterable: false, render: (pairing) => <strong>{pairing.tableNumber}</strong> },
    { key: "seat1", label: "ที่นั่ง", min: 44, width: 52, align: "right", cellClassName: "cell-seat", render: (pairing) => seatOne(pairing) },
    { key: "id1", label: "รหัส 1", min: 58, width: 72, filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerOneId)?.id ?? "—" },
    { key: "name1", label: "ชื่อ - นามสกุล", min: 120, width: 184, cellClassName: "cell-person-name", value: (pairing) => fullName(pairing.playerOneId), render: (pairing) => <span title={fullName(pairing.playerOneId)}>{fullName(pairing.playerOneId)}</span> },
    { key: "school1", label: "โรงเรียน/สถาบัน", min: 110, width: 174, cellClassName: "cell-person-school", value: (pairing) => playerOf(pairing.playerOneId)?.school ?? "—", render: (pairing) => <span title={playerOf(pairing.playerOneId)?.school}>{playerOf(pairing.playerOneId)?.school ?? "—"}</span> },
    { key: "vs", label: "", min: 56, width: 74, align: "center", cellClassName: "cell-vs", render: () => "พบกับ" },
    { key: "seat2", label: "ที่นั่ง", min: 44, width: 52, align: "right", cellClassName: "cell-seat", render: (pairing) => seatOne(pairing) + 1 },
    { key: "id2", label: "รหัส 2", min: 58, width: 72, filterKind: "playerCode", cellClassName: "cell-id", value: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—", render: (pairing) => playerOf(pairing.playerTwoId)?.id ?? "—" },
    { key: "name2", label: "ชื่อ - นามสกุล", min: 120, width: 184, cellClassName: "cell-person-name", value: (pairing) => fullName(pairing.playerTwoId), render: (pairing) => <span title={fullName(pairing.playerTwoId)}>{fullName(pairing.playerTwoId)}</span> },
    { key: "school2", label: "โรงเรียน/สถาบัน", min: 110, width: 174, cellClassName: "cell-person-school", value: (pairing) => playerOf(pairing.playerTwoId)?.school ?? "—", render: (pairing) => <span title={playerOf(pairing.playerTwoId)?.school}>{playerOf(pairing.playerTwoId)?.school ?? "—"}</span> },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={storageKey} resetKey={resetKey} tableClassName="entry-grid--match" unit="คู่" emptyText={emptyText} />;
}
