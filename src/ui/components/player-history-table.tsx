"use client";

import { playerHistory, type PlayerHistoryRow } from "@/domain/tournament/history";
import type { Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

/** Per-game play history table for one player (game, pair, result, running totals, opponent). */
export function PlayerHistoryTable({ card, players, playerId }: { card: TournamentCard; players: Map<string, Player>; playerId: string }) {
  const history = playerHistory(card, playerId);
  const opponentName = (id: string) => { const player = players.get(id); return `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim() || "—"; };
  const columns: DataColumn<PlayerHistoryRow>[] = [
    { key: "game", label: "เกมที่", min: 52, width: 64, align: "right", render: (row) => <strong>{row.game}</strong> },
    { key: "table", label: "คู่ที่", min: 48, width: 60, align: "right", render: (row) => row.table },
    { key: "result", label: "ผล", min: 54, width: 70, align: "center", render: (row) => <Badge tone={row.result === "W" ? "success" : row.result === "T" ? "warning" : "danger"}>{row.result}</Badge> },
    { key: "cwp", label: "แต้มชัยชนะสะสม", min: 96, width: 124, align: "right", render: (row) => <strong>{row.cumulativeWinPoints}</strong> },
    { key: "own", label: "แต้มของเจ้าของ", min: 88, width: 110, align: "right", cellClassName: "cell-score", render: (row) => row.ownScore },
    { key: "opp", label: "แต้มของคู่แข่ง", min: 88, width: 110, align: "right", cellClassName: "cell-score", render: (row) => row.opponentScore },
    { key: "diff", label: "Diff", min: 60, width: 84, align: "right", render: (row) => signed(row.diff) },
    { key: "cdiff", label: "ผลต่างสะสม", min: 88, width: 116, align: "right", render: (row) => <strong>{signed(row.cumulativeDiff)}</strong> },
    { key: "oppName", label: "ชื่อ-นามสกุลคู่แข่ง", min: 130, width: 200, render: (row) => <span title={opponentName(row.opponentId)}>{opponentName(row.opponentId)}</span> },
    { key: "oppSchool", label: "โรงเรียน/สถาบันคู่แข่ง", min: 130, width: 210, render: (row) => <span title={players.get(row.opponentId)?.school}>{players.get(row.opponentId)?.school}</span> },
  ];
  return <DataGrid columns={columns} rows={history} getRowKey={(row) => `${row.game}`} storageKey={`${card.id}:history:detail`} unit="เกม" emptyText="ยังไม่มีประวัติการเล่นที่เผยแพร่" />;
}
