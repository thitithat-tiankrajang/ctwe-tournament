"use client";

import type { PlayerHistoryRow } from "@/domain/tournament/history";
import type { Pairing, Player, SlotLabel } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { ReportTable } from "@/ui/components/report-table";

/**
 * Portrait-phone presentation of the public reports.
 *
 * The same rows, in the same order, already filtered by the same page controls as the desktop
 * grids — only the shape changes. Nine columns cannot fit a 390px phone, so each report keeps the
 * columns a spectator actually came for and spends the leftover width on the one that needs it: the
 * athlete. Every other column is sized to its own content and never wraps, because a number split
 * across two lines, or clipped, is worse than a narrow name.
 *
 * These are real tables with a real sticky header, and the header is what pays for the layout: a
 * column headed คะแนนสะสม does not repeat that label forty times, and a pair number under a คู่ที่
 * header does not need the words. Sticking it means the reader still knows which number is which
 * after scrolling past pair 30.
 *
 * Nothing here computes anything. Scores, winners, diffs and ranks arrive decided.
 */

/** Seat number for a player in a pairing (pair n → seats 2n-1 / 2n) — the same rule the grid uses. */
const seatOf = (tableNumber: number, side: 1 | 2) => (tableNumber - 1) * 2 + side;
const athleteName = (player?: Player) => player ? `${player.firstName} ${player.lastName}`.trim() : "";
const isRecorded = (pairing: Pairing) => pairing.scoreOne != null && pairing.scoreTwo != null && Boolean(pairing.resultType);

/** One competitor in a pairing: their seat cell, when the card names slots by seat, then themselves. */
function PairSide({ pairing, players, side, slotLabel, onOpenPlayer }: {
  pairing: Pairing;
  players: Map<string, Player>;
  side: 1 | 2;
  slotLabel: SlotLabel;
  onOpenPlayer?: (player: Player) => void;
}) {
  const playerId = side === 1 ? pairing.playerOneId : pairing.playerTwoId;
  const player = playerId ? players.get(playerId) : undefined;
  const gibsonized = side === 1 ? pairing.playerOneGibsonized : pairing.playerTwoGibsonized;
  const identity = (
    <span className="spectator-side__identity">
      <span className="spectator-side__primary">
        <span className="spectator-side__code">{player?.id ?? "—"}</span>
        <span className="spectator-side__name">
          {athleteName(player) || (playerId ? playerId : "บาย")}
          {gibsonized && <span className="gibson-mark">GIB</span>}
        </span>
      </span>
      {player?.school && <span className="spectator-side__school">{player.school}</span>}
    </span>
  );
  return (
    <>
      {slotLabel === "SEAT" && <td className="spectator-cell--seat">{seatOf(pairing.tableNumber, side)}</td>}
      <td>
        {player && onOpenPlayer
          ? <button type="button" className="spectator-side-link" onClick={() => onOpenPlayer(player)}>{identity}</button>
          : identity}
      </td>
    </>
  );
}

/** The athlete on one line: code, name, school. */
function AthleteLine({ player, playerId, gibsonized, onOpenPlayer }: {
  player: Player | undefined;
  playerId: string | null;
  gibsonized?: boolean;
  onOpenPlayer?: (player: Player) => void;
}) {
  const identity = (
    <span className="spectator-line">
      <span className="spectator-line__primary">
        <span className="spectator-line__code">{player?.id ?? "—"}</span>{" "}
        {athleteName(player) || (playerId ? playerId : "บาย")}
        {gibsonized && <span className="gibson-mark">GIB</span>}
      </span>
      {player?.school && <span className="spectator-line__school">{player.school}</span>}
    </span>
  );
  return player && onOpenPlayer
    ? <button type="button" className="spectator-athlete-link spectator-line-link" onClick={() => onOpenPlayer(player)}>{identity}</button>
    : identity;
}

/** คู่ที่ · ที่นั่ง · ผู้เล่น · ที่นั่ง · ผู้เล่น — both competitors of a pair on one row. */
export function SpectatorPairList({ pairings, players, mode, slotLabel, onOpenPlayer, emptyText }: {
  pairings: Pairing[];
  players: Map<string, Player>;
  mode: "pairing" | "result";
  /**
   * Which number this card announces. Pair n holds seats 2n-1 and 2n, so showing both spends a
   * column of a phone on a number half the room is not listening for — the card picks one.
  */
  slotLabel: SlotLabel;
  onOpenPlayer?: (player: Player) => void;
  emptyText: string;
}) {
  if (pairings.length === 0) return <p className="spectator-report-list__empty">{emptyText}</p>;

  // Two shapes, because the two reports carry different amounts. A pairing is two names and nothing
  // else, so both fit on one row side by side. A result adds a score and a player-perspective
  // difference per competitor, which will not fit beside two names on a phone — so a result spends
  // a row per competitor and gives identity its own line before the school.
  if (mode === "result") {
    return (
      <div>
        <ReportTable label="ผลการแข่งขัน" className="spectator-report--result" head={(
          <tr>
            {slotLabel === "PAIR" && <th scope="col" className="spectator-table__fit">คู่ที่</th>}
            {slotLabel === "SEAT" && <th scope="col" className="spectator-table__fit">ที่นั่ง</th>}
            <th scope="col">ผู้เล่น</th>
            <th scope="col" className="spectator-table__fit">คะแนน</th>
            <th scope="col" className="spectator-table__fit">ผลต่าง</th>
          </tr>
        )}>
          {pairings.flatMap((pairing, index) => {
            const recorded = isRecorded(pairing);
            const penalty = pairing.resultType === "PENALTY";
            const draw = pairing.resultType === "DRAW";
            const pairDiff = !recorded ? null : penalty ? -(pairing.calculatedDiff ?? 0) : draw ? 0 : pairing.calculatedDiff ?? 0;
            // A drawn pair already says so with a difference of 0; the word under it is the same
            // fact told twice.
            const status = !recorded ? "รอผล" : penalty ? "ลงดาบ" : null;
            // Banded by PAIR, not by row: shading the two competitors of one pair differently would
            // present them as two records rather than one contest.
            const band = index % 2 === 1 ? " is-alt" : "";
            return ([1, 2] as const).map((side) => {
              const playerId = side === 1 ? pairing.playerOneId : pairing.playerTwoId;
              const player = playerId ? players.get(playerId) : undefined;
              const won = Boolean(pairing.winnerId) && pairing.winnerId === playerId;
              const score = side === 1 ? pairing.scoreOne : pairing.scoreTwo;
              return (
                <tr key={`${pairing.id}:${side}`} className={`spectator-row--half${band}`}>
                  {slotLabel === "PAIR" && side === 1 && (
                    <td className="spectator-cell--pair" rowSpan={2}>{pairing.tableNumber}</td>
                  )}
                  {slotLabel === "SEAT" && (
                    <td className="spectator-cell--seat">{seatOf(pairing.tableNumber, side)}</td>
                  )}
                  <td className={won ? "spectator-cell--won" : undefined}>
            <AthleteLine
              player={player}
              playerId={playerId}
              gibsonized={side === 1 ? pairing.playerOneGibsonized : pairing.playerTwoGibsonized}
              onOpenPlayer={onOpenPlayer}
            />
                  </td>
                  <td className={won ? "spectator-cell--num spectator-cell--score is-won" : "spectator-cell--num spectator-cell--score"}>
                    {playerId && recorded && !penalty ? score : "—"}
                  </td>
                  <td className="spectator-cell--num spectator-cell--diff">
                    {!playerId || pairDiff === null ? "—" : signed(penalty ? -(pairing.calculatedDiff ?? 0) : side === 1 ? pairDiff : -pairDiff)}
                    {status && side === 1 && playerId && <span className="spectator-cell__status">{status}</span>}
                  </td>
                </tr>
              );
            });
          })}
        </ReportTable>
      </div>
    );
  }

  return (
    <div>
      <ReportTable label="คู่แข่งขัน" className="spectator-report--pair" head={(
        <tr>
          {slotLabel === "PAIR" && <th scope="col" className="spectator-table__fit">คู่ที่</th>}
          {slotLabel === "SEAT" && <th scope="col" className="spectator-table__fit">ที่นั่ง</th>}
          <th scope="col">ผู้เล่น</th>
          {slotLabel === "SEAT" && <th scope="col" className="spectator-table__fit">ที่นั่ง</th>}
          <th scope="col">ผู้เล่น</th>
        </tr>
      )}>
        {pairings.map((pairing, index) => (
          <tr key={pairing.id} className={index % 2 === 1 ? "is-alt" : undefined}>
            {slotLabel === "PAIR" && <td className="spectator-cell--pair">{pairing.tableNumber}</td>}
            <PairSide pairing={pairing} players={players} side={1} slotLabel={slotLabel} onOpenPlayer={onOpenPlayer} />
            <PairSide pairing={pairing} players={players} side={2} slotLabel={slotLabel} onOpenPlayer={onOpenPlayer} />
          </tr>
        ))}
      </ReportTable>
    </div>
  );
}

export interface StandingRow {
  rank: number;
  id: string;
  name: string;
  school: string;
  /** Omitted by the final-placings view, which is decided by the bracket rather than by points. */
  figures?: { winPoints: number; diff: number; scoreFor: number; average: string };
}

/**
 * Rank, athlete, points, difference — four columns, and only the athlete grows.
 *
 * Total score and average decide ties and still arrive on every row, but they are not shown here:
 * two more numeric columns on a phone would leave the name nothing to live on, and the desktop grid
 * remains the place to read a tie-break apart.
 */
export function SpectatorStandingList({ rows, selectedId, onRowClick, emptyText }: {
  rows: StandingRow[];
  selectedId?: string | null;
  onRowClick?: (id: string) => void;
  emptyText: string;
}) {
  if (rows.length === 0) return <p className="spectator-report-list__empty">{emptyText}</p>;
  const scored = rows.some((row) => row.figures);
  return (
    <div>
      <ReportTable
        label="ตารางอันดับ"
        head={(
          <tr>
            <th scope="col" className="spectator-table__fit">อันดับ</th>
            <th scope="col">นักกีฬา</th>
            {scored && <th scope="col" className="spectator-table__fit">คะแนนสะสม</th>}
            {scored && <th scope="col" className="spectator-table__fit">ผลต่างสะสม</th>}
          </tr>
        )}
      >
        {rows.map((row, index) => {
          const identity = (
            <>
              <span className="spectator-standrow__name"><b>{row.id}</b> {row.name}</span>
              {row.school && <span className="spectator-standrow__school">{row.school}</span>}
            </>
          );
          return (
            <tr key={row.id} className={`${index % 2 === 1 ? "is-alt" : ""}${selectedId === row.id ? " spectator-standrow--active" : ""}`.trim() || undefined}>
              <td className="spectator-cell--rank">{row.rank}</td>
              <td>
                {onRowClick
                  ? <button type="button" className="spectator-who" onClick={() => onRowClick(row.id)}>{identity}</button>
                  : <span className="spectator-who">{identity}</span>}
              </td>
              {scored && <td className="spectator-cell--num"><b>{row.figures?.winPoints ?? "—"}</b></td>}
              {scored && (
                <td className="spectator-cell--num">
                  {row.figures ? `${row.figures.diff > 0 ? "+" : ""}${row.figures.diff}` : "—"}
                </td>
              )}
            </tr>
          );
        })}
      </ReportTable>
    </div>
  );
}

const historyResultLabel: Record<PlayerHistoryRow["result"], string> = { W: "ชนะ", T: "เสมอ", L: "แพ้" };
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

/**
 * One player's per-game record. Shared by the Player Participation page and the history dialog the
 * standings report opens, so a spectator meets the same row wherever they arrive from.
 */
export function SpectatorHistoryRows({ rows, opponentName, opponentSchool, onOpenPlayer }: {
  rows: PlayerHistoryRow[];
  opponentName: (code: string) => string;
  opponentSchool: (code: string) => string;
  /** Public Player pages use this to keep every real opponent in the canonical Player graph. */
  onOpenPlayer?: (code: string) => void;
}) {
  return (
    <ul className="spectator-history">
      {rows.map((row) => (
        <li className="spectator-history__row" key={row.key}>
          <span className="spectator-history__game">{row.final ? row.gameLabel : `เกม ${row.game}`}</span>
          <Badge tone={row.result === "W" ? "success" : row.result === "T" ? "warning" : "danger"}>{historyResultLabel[row.result]}</Badge>
          <span className="spectator-history__score">{row.ownScore} - {row.opponentScore}</span>
          <span className="spectator-history__diff">{signed(row.diff)}</span>
          {row.opponentId && onOpenPlayer ? (
            <button type="button" className="spectator-history__opponent spectator-history__opponent-link" onClick={() => onOpenPlayer(row.opponentId)}>
              {row.opponentId} · {opponentName(row.opponentId)}
              {opponentSchool(row.opponentId) ? ` · ${opponentSchool(row.opponentId)}` : ""}
            </button>
          ) : (
            <span className="spectator-history__opponent">
              {row.opponentId ? `${row.opponentId} · ${opponentName(row.opponentId)}` : "บาย"}
              {row.opponentId && opponentSchool(row.opponentId) ? ` · ${opponentSchool(row.opponentId)}` : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
