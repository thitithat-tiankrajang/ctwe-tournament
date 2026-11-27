"use client";

import type { RankedPlayer } from "@/domain/tournament/history";
import type { Pairing, Player, SlotLabel } from "@/domain/tournament/types";
import { isVoidPairing } from "@/domain/tournament/pairing-slot";

type OpenPlayer = (player: Player) => void;

function Identity({ player, open, gibson }: { player?: Player; open?: OpenPlayer; gibson?: boolean }) {
  if (!player) return <span className="report-bye">บาย</span>;
  const name = `${player.firstName} ${player.lastName}`.trim();
  const body = <>
    <span className="report-name-line"><b className="report-code">{player.id}</b><strong title={name}>{name}</strong>{gibson && <span className="gibson-mark">GIB</span>}</span>
    <small className="report-school-inline" title={player.school}>{player.school}</small>
  </>;
  return open
    ? <button className="report-identity" type="button" onClick={() => open(player)}>{body}</button>
    : <span className="report-identity">{body}</span>;
}

function School({ player }: { player?: Player }) {
  return <td className="report-school" title={player?.school}>{player?.school}</td>;
}

const signed = (value: number) => value > 0 ? `+${value}` : String(value);

export function CompetitionRankingTable({ rows, open, emptyText }: { rows: readonly RankedPlayer[]; open?: OpenPlayer; emptyText: string }) {
  if (!rows.length) return <p className="panel-padding report-empty">{emptyText}</p>;
  return <div className="competition-report competition-report--ranking">
    <table aria-label="ตารางอันดับ"><colgroup>
      <col className="report-position" /><col className="report-player" /><col className="report-points" /><col className="report-diff" /><col className="report-school" />
    </colgroup><thead><tr><th scope="col">อันดับ</th><th scope="col">นักกีฬา</th><th scope="col" className="report-number">คะแนนชนะ</th><th scope="col" className="report-number">ผลต่างสะสม</th><th scope="col" className="report-school">โรงเรียน/สถาบัน</th></tr></thead>
      <tbody>{rows.map((player) => <tr key={player.id}>
        <th scope="row" className="report-number">{player.displayRank}</th>
        <td><Identity player={player} open={open} /></td>
        <td className="report-number report-score" title={`คะแนนรวม ${player.scoreFor} · คะแนนเฉลี่ย ${player.games > 0 ? player.average.toFixed(1) : "—"}`}>
          {player.winPoints}<small className="report-tiebreak">{player.scoreFor} รวม</small>
        </td>
        <td className="report-number">{signed(player.diff)}<small className="report-tiebreak">{player.games > 0 ? player.average.toFixed(1) : "—"} เฉลี่ย</small></td>
        <School player={player} />
      </tr>)}</tbody>
    </table>
  </div>;
}

export function CompetitionMatchTable({ rows, players, slotLabel, result = false, open, emptyText }: {
  rows: readonly Pairing[];
  players: ReadonlyMap<string, Player>;
  slotLabel: SlotLabel;
  result?: boolean;
  open?: OpenPlayer;
  emptyText: string;
}) {
  if (!rows.length) return <p className="panel-padding report-empty">{emptyText}</p>;
  const seat = slotLabel === "SEAT";
  const slotTitle = seat ? "ที่นั่ง" : "คู่ที่";
  const position = (number: number, side: 1 | 2) => seat ? (number - 1) * 2 + side : number;
  const schoolHead = <th scope="col" className="report-school">โรงเรียน/สถาบัน</th>;
  if (!result) return <div className="competition-report competition-report--pairing">
    <table aria-label="ตารางคู่แข่งขัน"><colgroup><col className="report-position" /><col className="report-player" /><col className="report-school" />{seat && <col className="report-position" />}<col className="report-player" /><col className="report-school" /></colgroup>
      <thead><tr><th scope="col">{slotTitle}</th><th scope="col">ผู้เล่น</th>{schoolHead}{seat && <th scope="col">{slotTitle}</th>}<th scope="col">ผู้เล่น</th>{schoolHead}</tr></thead>
      <tbody>{rows.filter((pair) => !isVoidPairing(pair)).map((pair) => {
        const one = pair.playerOneId ? players.get(pair.playerOneId) : undefined;
        const two = pair.playerTwoId ? players.get(pair.playerTwoId) : undefined;
        return <tr key={pair.id}>
          <th scope="row" className="report-number">{position(pair.tableNumber, 1)}</th>
          <td><Identity player={one} open={open} gibson={pair.playerOneGibsonized} /></td><School player={one} />
          {seat && <td className="report-number">{two ? position(pair.tableNumber, 2) : "—"}</td>}
          <td><Identity player={two} open={open} gibson={pair.playerTwoGibsonized} /></td><School player={two} />
        </tr>;
      })}</tbody>
    </table>
  </div>;
  return <div className="competition-report competition-report--result">
    <table aria-label="ตารางผลการแข่งขัน"><colgroup><col className="report-position" /><col className="report-player" /><col className="report-points" /><col className="report-diff" /><col className="report-school" /></colgroup>
      <thead><tr><th scope="col">{slotTitle}</th><th scope="col">ผู้เล่น</th><th scope="col" className="report-number">คะแนน</th><th scope="col" className="report-number">ผลต่าง</th>{schoolHead}</tr></thead>
      {rows.filter((pair) => !isVoidPairing(pair)).map((pair) => {
        const penalty = pair.resultType === "PENALTY";
        const recorded = Boolean(pair.resultType) && pair.scoreOne != null && pair.scoreTwo != null;
        const diff = pair.calculatedDiff ?? 0;
        const one = pair.playerOneId ? players.get(pair.playerOneId) : undefined;
        const two = pair.playerTwoId ? players.get(pair.playerTwoId) : undefined;
        const summary = penalty ? `−${diff}` : recorded && one && two ? diff ? `±${diff}` : "0" : "—";
        return <tbody key={pair.id} className="report-match">
          {([1, 2] as const).map((side) => {
            const player = side === 1 ? one : two;
            const score = side === 1 ? pair.scoreOne : pair.scoreTwo;
            return <tr key={side}>
              {(seat || side === 1) && <th scope={seat ? "row" : "rowgroup"} rowSpan={seat ? undefined : 2} className="report-number">{seat && !player ? "—" : position(pair.tableNumber, side)}</th>}
              <td><Identity player={player} open={open} gibson={side === 1 ? pair.playerOneGibsonized : pair.playerTwoGibsonized} /></td>
              <td className={pair.winnerId === player?.id && player ? "report-number report-score" : "report-number"}>{penalty ? "ลงดาบ" : recorded && player ? score : "—"}</td>
              {side === 1 && <td className="report-number report-pair-diff" rowSpan={2}>{summary}</td>}
              <School player={player} />
            </tr>;
          })}
        </tbody>;
      })}
    </table>
  </div>;
}
