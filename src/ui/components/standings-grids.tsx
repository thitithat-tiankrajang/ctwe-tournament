"use client";

import type { Pairing, Player } from "@/domain/tournament/types";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { pairingFilters, rankingFilters } from "@/ui/components/grid-filters";

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
    { key: "rank", label: "#", min: 42, width: 56, align: "right", render: ({ rank }) => <strong>{rank}</strong> },
    { key: "id", label: "รหัสผู้เล่น", min: 80, width: 120, cellClassName: "cell-id", render: ({ player }) => player.id },
    { key: "name", label: "ชื่อ-นามสกุล", min: 130, width: 210, render: ({ player }) => <span title={`${player.firstName} ${player.lastName}`}>{player.firstName} {player.lastName}</span> },
    { key: "school", label: "โรงเรียน/สถาบัน", min: 120, width: 200, render: ({ player }) => <span title={player.school}>{player.school}</span> },
    { key: "wp", label: "คะแนนชัยชนะ", min: 90, width: 124, align: "right", render: ({ player }) => <strong>{player.winPoints}</strong> },
    { key: "diff", label: "ผลต่างสะสม", min: 90, width: 124, align: "right", render: ({ player }) => `${player.diff > 0 ? "+" : ""}${player.diff}` },
    { key: "wdl", label: "ชนะ / เสมอ / แพ้", min: 100, width: 142, align: "center", render: ({ player }) => `${player.wins} / ${player.draws} / ${player.losses}` },
  ];
  return <DataGrid columns={columns} rows={rows} getRowKey={({ player }) => player.id} storageKey={storageKey} resetKey={resetKey} unit="คน" emptyText={emptyText} filters={rankingFilters()} onRowClick={onRowClick ? (row) => onRowClick(row.player) : undefined} rowClassName={activeId ? (row) => row.player.id === activeId ? "egrid-row--active" : undefined : undefined} />;
}

/** Pairing table (pair number, both players with a "พบกับ" divider) shared by every page. */
export function PairingGrid({ pairings, players, storageKey, resetKey, emptyText = "ไม่พบคู่ตามตัวกรอง" }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  storageKey: string;
  resetKey?: string;
  emptyText?: string;
}) {
  const fullName = (playerId: string) => { const player = players.get(playerId); return `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim(); };
  const columns: DataColumn<Pairing>[] = [
    { key: "pair", label: "คู่", min: 44, width: 60, align: "right", render: (pairing) => <strong>{pairing.tableNumber}</strong> },
    { key: "id1", label: "รหัสฝ่ายที่ 1", min: 80, width: 118, cellClassName: "cell-id", render: (pairing) => players.get(pairing.playerOneId)?.id },
    { key: "name1", label: "ชื่อ - นามสกุล", min: 120, width: 190, render: (pairing) => <span title={fullName(pairing.playerOneId)}>{fullName(pairing.playerOneId)}</span> },
    { key: "school1", label: "โรงเรียน/สถาบัน", min: 110, width: 180, render: (pairing) => <span title={players.get(pairing.playerOneId)?.school}>{players.get(pairing.playerOneId)?.school}</span> },
    { key: "vs", label: "", min: 60, width: 78, align: "center", cellClassName: "cell-vs", render: () => "พบกับ" },
    { key: "id2", label: "รหัสฝ่ายที่ 2", min: 80, width: 118, cellClassName: "cell-id", render: (pairing) => players.get(pairing.playerTwoId)?.id },
    { key: "name2", label: "ชื่อ - นามสกุล", min: 120, width: 190, render: (pairing) => <span title={fullName(pairing.playerTwoId)}>{fullName(pairing.playerTwoId)}</span> },
    { key: "school2", label: "โรงเรียน/สถาบัน", min: 110, width: 180, render: (pairing) => <span title={players.get(pairing.playerTwoId)?.school}>{players.get(pairing.playerTwoId)?.school}</span> },
  ];
  return <DataGrid columns={columns} rows={pairings} getRowKey={(pairing) => pairing.id} storageKey={storageKey} resetKey={resetKey} unit="คู่" emptyText={emptyText} filters={pairingFilters(players)} />;
}
