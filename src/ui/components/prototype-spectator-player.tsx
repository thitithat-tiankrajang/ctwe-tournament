"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PublicDivisionPayload, SpectatorDivision } from "@/application/tournament/spectator-read-model";
import { spectatorPlayerView, type SpectatorOpponent, type SpectatorPlayerGame, type SpectatorPlayerView } from "@/application/tournament/spectator-player";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";
import { PrototypeViewerHelp, PrototypeViewerStatus, useViewerPlacement } from "./prototype-spectator-chrome";

const signed = (value: number) => value > 0 ? `+${value}` : String(value);
function outcome(game: SpectatorPlayerGame) {
  if (game.outcome === "PENALTY") return ["danger", "ลงดาบ"] as const;
  if (game.bye && game.outcome === "W") return ["success", "ชนะ (บาย)"] as const;
  if (game.outcome === "W") return ["success", "ชนะ"] as const;
  if (game.outcome === "L") return ["danger", "แพ้"] as const;
  if (game.outcome === "T") return ["neutral", "เสมอ"] as const;
  return ["neutral", "รอผล"] as const;
}
function score(game: SpectatorPlayerGame) {
  return !game.score ? "—" : game.bye ? game.score.own : `${game.score.own}–${game.score.opponent}`;
}
function Opponent({ player, open, inline = false }: { player: SpectatorOpponent; open: (code: string) => void; inline?: boolean }) {
  return <button type="button" className={`idn${inline ? " idn--inline" : ""}`} onClick={() => open(player.code)}>
    <span className={inline ? undefined : "l1"}><span className="code">{player.code}</span>{" "}<span className="nm">{player.name}</span></span>
  </button>;
}

function PlayerStatus({ card, view, onOpenPlayer }: {
  card: PublicDivisionPayload; view: SpectatorPlayerView; onOpenPlayer: (code: string) => void;
}) {
  const history = view.ledger.filter(game => game.state === "official" || game.state === "recorded");
  const last = history.at(-1);
  const assignment = view.assignment;
  const final = view.final;
  const slot = card.finalRound?.slots.find(item => item.playerOneId === view.participant.code || item.playerTwoId === view.participant.code);
  const seat = view.slotLabel === "SEAT";
  const ranking = view.standing;
  const code = view.participant.code;
  const seriesWins = (player: string) => slot?.winnerId && slot.winnerWins != null && slot.winnerLosses != null
    ? player === slot.winnerId ? slot.winnerWins : slot.winnerLosses
    : slot?.games.filter(game => game.winnerId === player).length ?? 0;
  const [state, label] = !view.participant.listedInStandings ? ["danger", "ถอนตัวแล้ว"]
    : view.phase === "complete" ? ["success", "จบการแข่งขัน"]
    : view.phase === "finals" ? final ? ["comp", `รอบ${final.label}`] : ["neutral", "ไม่ได้เข้ารอบชิง"]
    : assignment ? ["info", "รอผล"]
    : view.phase === "registration" ? ["neutral", "ยังไม่มีคู่แข่งขัน"]
    : view.recordedCurrentGame ? ["neutral", `รอคู่เกม ${view.recordedCurrentGame.game + 1}`]
    : ["neutral", `รอคู่เกม ${view.awaitingGame ?? card.currentGame}`];
  return <div className="pm-body">
    <section className="now5" aria-label="สถานะปัจจุบัน">
      <div className="now5__status">
        <PrototypeViewerStatus tone={state}>{label}</PrototypeViewerStatus>
        {assignment && <span className="now5__game">เกม {assignment.game}</span>}
        <PrototypeViewerHelp label="สถานะ">รอผลหมายถึงคู่แข่งขันประกาศแล้ว ส่วนรอคู่เกมหมายถึงคู่ใหม่ยังไม่ประกาศ หน้านี้อัปเดตตามการประกาศ</PrototypeViewerHelp>
      </div>
      {assignment && <div className="now5__grid">
        <div className="now5__cell">
          <span className="now5__place"><span className="lbl">{seat ? "ที่นั่ง" : "คู่ที่"}</span><b className="now5__big">{seat ? assignment.seat : assignment.pairNumber}</b></span>
          <span className="sub">{seat ? `คู่ที่ ${assignment.pairNumber}` : `ที่นั่ง ${assignment.seat}`} · ฝั่ง {assignment.side}</span>
        </div>
        <div className="now5__cell now5__opp"><span className="lbl">คู่แข่ง</span>
          {assignment.opponent ? <><Opponent player={assignment.opponent} open={onOpenPlayer} inline /><span className="sub">{assignment.opponent.school}</span></> : <b>บาย</b>}
        </div>
      </div>}
      {view.phase === "finals" && final?.opponent && <div className="now5__grid">
        <div className="now5__cell"><span className="lbl">ชนะ–แพ้</span><b className="now5__big">{seriesWins(code)}–{seriesWins(final.opponent.code)}</b></div>
        <div className="now5__cell now5__opp"><span className="lbl">คู่แข่ง</span><Opponent player={final.opponent} open={onOpenPlayer} inline /><span className="sub">{final.opponent.school}</span></div>
      </div>}
      {view.phase === "complete" && ranking && <div className="now5__grid"><div className="now5__cell"><span className="lbl">อันดับสุดท้าย</span><b className="now5__big">{ranking.rank}</b></div></div>}
      {view.phase === "regular" && !assignment && last && <div className="now5__last">
        <span className="lbl">ล่าสุด · เกม {last.game}</span><PrototypeViewerStatus tone={outcome(last)[0]}>{outcome(last)[1]}</PrototypeViewerStatus>
        <span className="num">{score(last)}</span>{last.opponent && <Opponent player={last.opponent} open={onOpenPlayer} inline />}
      </div>}
    </section>
    {ranking && <div className="pm-stats"><span>อันดับ <b>{ranking.rank}</b></span><span>คะแนนสะสม <b>{ranking.wins + ranking.draws / 2}</b></span><span>ผลต่าง <b>{signed(ranking.diff)}</b></span></div>}
    {history.length > 0 && <details className="pm-hist"><summary>ประวัติการแข่งขัน · {history.length} เกม</summary>
      <table className="st" aria-label="ประวัติการแข่งขัน"><thead><tr><th scope="col" className="fitw">เกม</th><th scope="col">คู่แข่ง</th><th scope="col" className="n" style={{ width: 76 }}>คะแนน</th><th scope="col" style={{ width: 70 }}>ผล</th></tr></thead>
        <tbody>{history.map((game, index) => <tr key={game.key} className={index % 2 ? "alt" : undefined}>
          <td className="pairno">{game.game}</td><td>{game.opponent ? <Opponent player={game.opponent} open={onOpenPlayer} /> : "บาย"}</td>
          <td className="n" style={{ whiteSpace: "nowrap" }}>{score(game)}</td><td><PrototypeViewerStatus tone={outcome(game)[0]}>{outcome(game)[1]}</PrototypeViewerStatus></td>
        </tr>)}</tbody>
      </table>
    </details>}
  </div>;
}

export function PrototypeSpectatorPlayer({ card, division, code, theme, mobile, anchor, onClose, onOpenPlayer }: {
  card: PublicDivisionPayload; division: SpectatorDivision; code: string; theme: CSSProperties; mobile: boolean;
  anchor: RefObject<HTMLElement | null>; onClose: () => void; onOpenPlayer: (code: string) => void;
}) {
  const player = spectatorPlayerView(card, division, code);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = () => {
    if (closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    setClosing(true);
    timer.current = setTimeout(onClose, 140);
  };
  const modal = useModalDialog({ open: true, onDismiss: close, dismissible: !closing });
  const placed = useViewerPlacement(anchor, modal.ref, mobile ? 560 : 440, 240, false, true);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div className={`pm-layer pm-layer--viewer${placed?.sheet || placed?.centered ? " pm-layer--modal" : ""}${closing ? " closing" : ""}`}
    onMouseDown={modal.onBackdropMouseDown}>
    <section ref={modal.ref} role="dialog" aria-modal="true" aria-labelledby={modal.titleId} tabIndex={-1}
      className={`pm pm--pop pm--viewer sport-theme${placed?.sheet ? " pm--sheet" : placed?.centered ? " pm--center" : ""}`}
      style={{ ...theme, ...placed?.style, visibility: placed ? undefined : "hidden" }}
      data-side={placed?.direction} onMouseDown={event => event.stopPropagation()}>
      <header className="pm__head"><div className="pm__title"><span className="pm__sub">{card.name} · {card.division}</span>
        <h2 id={modal.titleId}><span className="code">{code}</span> {player?.participant.name ?? "ไม่พบรายชื่อนักกีฬา"}</h2>
        <span className="pm__school">{player?.participant.school}</span></div>
        <button type="button" className="pm__close" aria-label="ปิดรายละเอียดนักกีฬา" onClick={close}><X className="i" size={17} /></button></header>
      <div key={code} className="pm__scroll pm-swap">
        {player ? <PlayerStatus card={card} view={player} onOpenPlayer={onOpenPlayer} /> : <p className="pm-body">รายชื่ออาจถูกปรับหลังจากเปิดหน้านี้</p>}
      </div>
    </section>
  </div>;
}
