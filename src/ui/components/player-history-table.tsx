"use client";

import { playerHistory, type HistoryScope, type PlayerHistoryRow } from "@/domain/tournament/history";
import type { Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { DataGrid, type DataColumn } from "@/ui/components/data-grid";
import { SpectatorHistoryRows } from "@/ui/components/spectator-report-lists";

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

/** Per-game play history table for one player (game, pair, result, running totals, opponent). */
export function PlayerHistoryTable({ card, players, playerId, scope, stacked = false }: { card: TournamentCard; players: Map<string, Player>; playerId: string; scope: HistoryScope; stacked?: boolean }) {
  const { qualifying, final } = playerHistory(card, playerId, scope);
  const opponentName = (id: string) => { const player = players.get(id); return `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim() || "—"; };
  // A portrait phone cannot hold ten aligned columns inside a dialog. Same rows, read as the record
  // list the Player Participation page already uses.
  if (stacked) return (
    <>
      {qualifying.length === 0
        ? <p className="spectator-report-list__empty">ยังไม่มีประวัติการเล่นที่เผยแพร่</p>
        : <SpectatorHistoryRows rows={qualifying} opponentName={opponentName} opponentSchool={(id) => players.get(id)?.school ?? ""} />}
      {final.length > 0 && (
        <>
          <p className="spectator-record__section">รอบชิงชนะเลิศ · นับแยกจากรอบคัดเลือก</p>
          <SpectatorHistoryRows rows={final} opponentName={opponentName} opponentSchool={(id) => players.get(id)?.school ?? ""} />
        </>
      )}
    </>
  );
  const columns: DataColumn<PlayerHistoryRow>[] = [
    { key: "game", label: "เกมที่", min: 52, width: 72, align: "right", render: (row) => <strong>{row.final ? row.gameLabel : row.game}</strong> },
    { key: "table", label: "คู่ที่", min: 48, width: 60, align: "right", render: (row) => row.final ? "—" : row.table },
    { key: "result", label: "ผล", min: 54, width: 70, align: "center", render: (row) => <Badge tone={row.result === "W" ? "success" : row.result === "T" ? "warning" : "danger"}>{row.result}</Badge> },
    { key: "cwp", label: "แต้มชัยชนะสะสม", min: 96, width: 124, align: "right", render: (row) => <strong>{row.cumulativeWinPoints}</strong> },
    { key: "own", label: "แต้มของเจ้าของ", min: 88, width: 110, align: "right", cellClassName: "cell-score", render: (row) => row.ownScore },
    { key: "opp", label: "แต้มของคู่แข่ง", min: 88, width: 110, align: "right", cellClassName: "cell-score", render: (row) => row.opponentScore },
    { key: "diff", label: "Diff", min: 60, width: 84, align: "right", render: (row) => signed(row.diff) },
    { key: "cdiff", label: "ผลต่างสะสม", min: 88, width: 116, align: "right", render: (row) => <strong>{signed(row.cumulativeDiff)}</strong> },
    { key: "oppName", label: "ชื่อ-นามสกุลคู่แข่ง", min: 130, width: 200, render: (row) => <span title={opponentName(row.opponentId)}>{opponentName(row.opponentId)}</span> },
    { key: "oppSchool", label: "โรงเรียน/สถาบันคู่แข่ง", min: 130, width: 210, render: (row) => <span title={players.get(row.opponentId)?.school}>{players.get(row.opponentId)?.school}</span> },
  ];
  // Qualification and the championship are rendered as two records, never one running list: the
  // final decides placings, it does not add to the totals a player qualified on. Each grid carries
  // its own cumulative columns, which start from zero in the championship section.
  return (
    <>
      {final.length > 0 && <p className="history-section-label">รอบคัดเลือก · แต้มและผลต่างสะสมของการคัดเลือก</p>}
      <DataGrid ariaLabel="ประวัติการแข่งขันของนักกีฬา" columns={columns} rows={qualifying} getRowKey={(row) => row.key} storageKey={`${card.id}:history:detail`} emptyText="ยังไม่มีประวัติการเล่นที่เผยแพร่" />
      {final.length > 0 && (
        <>
          <p className="history-section-label">รอบชิงชนะเลิศ · นับแยกจากรอบคัดเลือก ไม่รวมเข้ากับแต้มสะสมด้านบน</p>
          <DataGrid ariaLabel="ประวัติรอบชิงชนะเลิศของนักกีฬา" columns={columns} rows={final} getRowKey={(row) => row.key} storageKey={`${card.id}:history:final`} emptyText="ยังไม่มีผลรอบชิง" />
        </>
      )}
    </>
  );
}
