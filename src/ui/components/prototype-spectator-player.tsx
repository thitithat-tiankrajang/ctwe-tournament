"use client";

import { ChevronDown, ListOrdered, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { PublicDivisionPayload, SpectatorDivision } from "@/application/tournament/spectator-read-model";
import { spectatorPlayerView, type SpectatorOpponent, type SpectatorPlayerGame, type SpectatorPlayerView } from "@/application/tournament/spectator-player";
import { editableResultGames } from "@/domain/tournament/flow";
import { isRecordedPairing } from "@/domain/tournament/pairing-slot";
import type { TournamentCard } from "@/domain/tournament/types";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";
import { PrototypeViewerHelp, PrototypeViewerStatus, useViewerPlacement } from "./prototype-spectator-chrome";

const signed = (value: number) => value > 0 ? `+${value}` : String(value);
function outcome(game: SpectatorPlayerGame) {
  if (game.outcome === "PENALTY") return ["danger", "ลงดาบ"] as const;
  if (game.outcome === "W") return ["success", "ชนะ"] as const;
  if (game.outcome === "L") return ["danger", "แพ้"] as const;
  if (game.outcome === "T") return ["neutral", "เสมอ"] as const;
  return ["warning", "รอผล"] as const;
}
function score(game: SpectatorPlayerGame) {
  return !game.score ? "—" : game.bye ? game.score.own : `${game.score.own}–${game.score.opponent}`;
}
function Opponent({ player, open, inline = false }: { player: SpectatorOpponent; open: (code: string) => void; inline?: boolean }) {
  return <button type="button" className={`idn${inline ? " idn--inline" : ""}`} onClick={() => open(player.code)}>
    {inline ? <><span className="code">{player.code}</span>{" "}<span className="nm">{player.name}</span></>
      : <><span className="nm">{player.name}</span><span className="code">{player.code}</span></>}
  </button>;
}

function PlayerSignal({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className="pm-signal" data-pm-tone={tone}>{children}</span>;
}

function PlayerMasterStatus({ card, view, operational, onOpenPlayer }: {
  card: PublicDivisionPayload; view: SpectatorPlayerView; operational?: TournamentCard; onOpenPlayer: (code: string) => void;
}) {
  const code = view.participant.code;
  const assignment = view.assignment;
  const rounds = operational ? editableResultGames(operational).map((game) => {
    const pairing = operational.snapshots.filter((snapshot) => !snapshot.confirmedAt).flatMap((snapshot) => snapshot.pairings)
      .find((pair) => (pair.gameNumber ?? operational.currentGame) === game && (pair.playerOneId === code || pair.playerTwoId === code));
    const other = pairing?.playerOneId === code ? pairing.playerTwoId : pairing?.playerOneId;
    const opponent = card.players.find((player) => player.id === other);
    const held = operational.screeningPool?.some((hold) => hold.player === code && (hold.fromGame ?? 1) <= game);
    const player = card.players.find((entry) => entry.id === code);
    const withdrawn = Boolean(player?.terminated && (player.withdrawnFromGame ?? 0) <= game);
    const source = operational.snapshots.filter((snapshot) => !snapshot.confirmedAt).flatMap((snapshot) => snapshot.pairings)
      .filter((pair) => (pair.gameNumber ?? operational.currentGame) === operational.currentGame
        && Math.floor((pair.tableNumber - 1) / 2) === Math.floor(((pairing?.tableNumber ?? 1) - 1) / 2));
    const waiting = Boolean(pairing && !other && game > operational.currentGame && !pairing.resultType && !pairing.manualPairing
      && source.some((pair) => (pair.playerOneId || pair.playerTwoId) && !isRecordedPairing(pair)));
    return { game, pair: pairing?.tableNumber, seat: pairing ? (pairing.tableNumber - 1) * 2 + (pairing.playerOneId === code ? 1 : 2) : undefined,
      opponent: opponent ? { code: opponent.id, name: `${opponent.firstName} ${opponent.lastName}`, school: opponent.school } : undefined,
      label: withdrawn ? "ถอนแล้ว" : held ? "คัดชั่วคราว" : pairing?.resultType ? "บันทึกผลแล้ว" : waiting ? "รอคู่แข่ง"
        : operational.runtimeStage === "PAIRING_PREVIEW" && pairing ? "รอยืนยันคู่" : pairing ? "รอผล"
        : game > operational.currentGame ? "รอผลจากเกมก่อนหน้า" : "รอประกาศคู่",
      waiting, saved: Boolean(pairing?.resultType), withdrawn };
  }) : [{
    game: assignment?.game ?? view.awaitingGame ?? view.recordedCurrentGame?.game ?? card.currentGame,
    pair: assignment?.pairNumber ?? view.recordedCurrentGame?.pairNumber,
    seat: assignment?.seat ?? view.recordedCurrentGame?.seat,
    opponent: assignment?.opponent ?? view.recordedCurrentGame?.opponent,
    label: !view.participant.listedInStandings ? "ถอนแล้ว" : assignment ? "รอผล" : view.recordedCurrentGame ? "บันทึกผลแล้ว" : "รอประกาศคู่",
    waiting: false, saved: !assignment && Boolean(view.recordedCurrentGame), withdrawn: !view.participant.listedInStandings,
  }];
  return <section className="player-master" aria-label="สถานะปัจจุบัน">
    {rounds.map((round) => {
      const tone = round.withdrawn ? "danger" : round.saved ? "success" : round.pair || round.waiting ? "warning" : "neutral";
      return <article className="player-master-round" data-pm-tone={tone} key={round.game}>
      <header><strong>เกม {round.game}</strong><PlayerSignal tone={tone}>{round.label}</PlayerSignal></header>
      {round.pair != null && <dl className="player-master-facts">
        <div><dt>คู่</dt><dd className="num">{round.pair}</dd></div><div><dt>ที่นั่ง</dt><dd className="num">{round.seat}</dd></div>
        <div><dt>คู่แข่ง</dt><dd>{round.opponent ? <><Opponent player={round.opponent} open={onOpenPlayer} inline />
          <span className="sub">{round.opponent.school}</span></> : round.waiting ? "—" : "บาย"}</dd></div>
      </dl>}
    </article>;
    })}
  </section>;
}

function PlayerStatus({ card, view, onOpenPlayer, master, operational }: {
  card: PublicDivisionPayload; view: SpectatorPlayerView; onOpenPlayer: (code: string) => void;
  master?: boolean; operational?: TournamentCard;
}) {
  const history = view.ledger.filter(game => game.state === "official" || game.state === "recorded");
  const last = history.at(-1);
  const assignment = view.assignment;
  const final = view.final;
  const slot = card.finalRound?.slots.find(item => item.playerOneId === view.participant.code || item.playerTwoId === view.participant.code);
  const seat = view.slotLabel === "SEAT";
  const ranking = view.standing;
  const code = view.participant.code;
  const reviewingSeeds = operational?.runtimeStage === "FINAL_SEEDING";
  const seriesWins = (player: string) => slot?.winnerId && slot.winnerWins != null && slot.winnerLosses != null
    ? player === slot.winnerId ? slot.winnerWins : slot.winnerLosses
    : slot?.games.filter(game => game.winnerId === player).length ?? 0;
  const [state, label] = !view.participant.listedInStandings ? ["danger", "ถอนตัวแล้ว"]
    : view.phase === "complete" ? ["success", "จบการแข่งขัน"]
    : view.phase === "finals" ? final ? ["comp", `รอบ${final.label}`] : ["neutral", "ไม่ได้เข้ารอบชิง"]
    : reviewingSeeds ? operational.finalRound?.seedPlayerIds?.includes(code) ? ["comp", "รอตรวจรายชื่อผู้เข้าชิง"] : ["neutral", "จบรอบปกติ"]
    : assignment ? ["info", "รอผล"]
    : view.phase === "registration" ? ["neutral", "ยังไม่มีคู่แข่งขัน"]
    : view.recordedCurrentGame ? ["neutral", `รอคู่เกม ${view.recordedCurrentGame.game + 1}`]
    : ["neutral", `รอคู่เกม ${view.awaitingGame ?? card.currentGame}`];
  return <div className="pm-body">
    {master && view.phase === "regular" && !reviewingSeeds ? <PlayerMasterStatus card={card} view={view} operational={operational} onOpenPlayer={onOpenPlayer} /> : <section className="now5" aria-label="สถานะปัจจุบัน">
      <div className="now5__status">
        <PlayerSignal tone={state}>{label}</PlayerSignal>
        {assignment && <span className="now5__game">เกม {assignment.game}</span>}
        {!reviewingSeeds && <PrototypeViewerHelp label="สถานะ">รอผลหมายถึงคู่แข่งขันประกาศแล้ว ส่วนรอคู่เกมหมายถึงคู่ใหม่ยังไม่ประกาศ หน้านี้อัปเดตตามการประกาศ</PrototypeViewerHelp>}
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
    </section>}
    {ranking && <dl className="pm-stats"><div className="pm-rank" data-pm-tone="info"><dt>อันดับ</dt><dd>{ranking.rank}</dd></div>
      <div><dt>คะแนนสะสม</dt><dd>{ranking.winPoints}</dd></div>
      <div data-pm-tone={ranking.diff > 0 ? "success" : ranking.diff < 0 ? "danger" : "neutral"}><dt>ผลต่าง</dt><dd>{signed(ranking.diff)}</dd></div>
    </dl>}
    {history.length > 0 && <details className="pm-hist"><summary className="pm-hist__head">
      <strong><ListOrdered className="i" size={15} />ประวัติการแข่งขัน</strong><span className="pm-hist__count">{history.length} เกม</span><ChevronDown className="i pm-hist__chev" size={14} />
    </summary>
      <table className="pm-hist__table" aria-label="ผลการแข่งขันรายเกม"><colgroup><col /><col /><col /><col /></colgroup>
        <thead><tr><th scope="col">เกม</th><th scope="col">คู่แข่ง</th><th scope="col" aria-label="คะแนนผู้เล่น ต่อ คะแนนคู่แข่ง">คะแนน</th><th scope="col">ผล</th></tr></thead>
        <tbody>{[...history].reverse().map((game) => {
          const [tone, label] = outcome(game);
          return <tr key={game.key}>
            <th scope="row">{game.game}</th><td>{game.opponent ? <Opponent player={game.opponent} open={onOpenPlayer} /> : game.bye ? "บาย" : "—"}</td>
            <td><span className="pm-hist__score">{game.score ? <><strong>{game.score.own}</strong>{!game.bye && <><span>–</span><span>{game.score.opponent}</span></>}</> : "—"}</span></td>
            <td><PlayerSignal tone={tone}>{label}</PlayerSignal></td>
          </tr>;
        })}</tbody>
      </table>
    </details>}
  </div>;
}

export function PrototypeSpectatorPlayer({ card, division, code, theme, mobile, anchor, onClose, onOpenPlayer, master = false, operational, viewer = false }: {
  card: PublicDivisionPayload; division: SpectatorDivision; code: string; theme: CSSProperties; mobile: boolean;
  master?: boolean; operational?: TournamentCard; viewer?: boolean;
  anchor: RefObject<HTMLElement | null>; onClose: () => void; onOpenPlayer: (code: string) => void;
}) {
  const player = spectatorPlayerView(card, division, code);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);
  const previousCode = useRef(code);
  const drag = useRef<{ id: number; x: number; y: number; start: number; offset: number } | null>(null);
  const finishClose = () => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    onClose();
  };
  const close = () => {
    if (closing || timer.current !== undefined) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    const panel = modal.ref.current;
    if (viewer && panel) {
      const style = getComputedStyle(panel);
      panel.style.setProperty("--pm-exit-transform", style.transform);
      panel.style.setProperty("--pm-exit-opacity", style.opacity);
      if (panel.parentElement) {
        panel.parentElement.style.setProperty("--pm-exit-opacity", getComputedStyle(panel.parentElement).opacity);
      }
    }
    setClosing(true);
    timer.current = setTimeout(finishClose, viewer ? 450 : 140);
  };
  const modal = useModalDialog({ open: true, onDismiss: close, dismissible: !closing, focusDialog: viewer });
  const anchored = useViewerPlacement(anchor, modal.ref, mobile ? 560 : 440, 240, false, true, !viewer);
  const placed = master ? { sheet: mobile, centered: !mobile, direction: undefined, style: undefined } : anchored;
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!viewer || previousCode.current === code || !body.current) return;
    previousCode.current = code;
    body.current.scrollTop = 0;
    modal.ref.current?.focus({ preventScroll: true });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = body.current.querySelector(".pm-body")?.animate([
      { transform: "translateY(4px)" }, { transform: "none" },
    ], { duration: 180, easing: "cubic-bezier(.22,.8,.25,1)" });
    return () => animation?.cancel();
  }, [code, modal.ref, viewer]);
  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    if (!viewer || !mobile || closing || !event.isPrimary || event.pointerType === "mouse" || (event.target as Element).closest("button")) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: event.timeStamp, offset: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current, box = modal.ref.current;
    if (!current || !box || current.id !== event.pointerId) return;
    const distance = event.clientY - current.y;
    if (!box.classList.contains("is-dragging") && (distance < 6 || distance < Math.abs(event.clientX - current.x))) return;
    current.offset = Math.max(0, distance);
    box.classList.add("is-dragging");
    box.style.setProperty("--pm-drag", `${current.offset}px`);
  };
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current, box = modal.ref.current;
    if (!current || !box || current.id !== event.pointerId) return;
    drag.current = null;
    const far = current.offset >= Math.max(80, Math.min(135, box.offsetHeight * .24));
    const fast = current.offset >= 48 && current.offset / Math.max(1, event.timeStamp - current.start) > .65;
    box.classList.remove("is-dragging");
    if (event.type === "pointerup" && mobile && (far || fast)) close();
    else box.style.removeProperty("--pm-drag");
  };
  return <div className={`pm-layer pm-layer--viewer${viewer ? " pm-layer--public" : placed?.sheet || placed?.centered ? " pm-layer--modal" : ""}${closing ? " closing" : ""}`}
    onPointerDown={event => { if (event.target === event.currentTarget) modal.onBackdropMouseDown(); }}>
    <section ref={modal.ref} role="dialog" aria-modal="true" aria-labelledby={modal.titleId} tabIndex={-1}
      className={`pm pm--pop sport-theme${viewer ? " pm--viewer pm--public pm--master" : `${operational ? "" : " pm--viewer"}${master ? " pm--master" : ""}${placed?.sheet ? " pm--sheet" : placed?.centered ? " pm--center" : ""}`}`}
      style={viewer ? theme : { ...theme, ...placed?.style, visibility: placed ? undefined : "hidden" }}
      onAnimationEnd={event => {
        if (viewer && closing && event.target === event.currentTarget && event.animationName.endsWith("-out")) finishClose();
      }}
      data-side={viewer ? undefined : placed?.direction}>
      <header className="pm__head" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {viewer && <><span className="pm__handle" aria-hidden="true" /><button type="button" className="pm__dismiss" aria-label="ปิดรายละเอียดนักกีฬา" onClick={close}><X size={18} aria-hidden /></button></>}
        <div className="pm__title"><span className="pm__sub">{card.name} · {card.division}</span>
        <h2 id={modal.titleId}><span className="code">{code}</span> {player?.participant.name ?? "ไม่พบรายชื่อนักกีฬา"}</h2>
        <span className="pm__school">{player?.participant.school}</span></div>
        {!viewer && <button type="button" className="pm__close" aria-label="ปิดรายละเอียดนักกีฬา" onClick={close}><X className="i" size={17} /></button>}</header>
      <div ref={body} key={viewer ? undefined : code} className={viewer ? "pm__scroll" : "pm__scroll pm-swap"}>
        {player ? <PlayerStatus card={card} view={player} master={viewer || master} operational={operational} onOpenPlayer={onOpenPlayer} /> : <p className="pm-body">รายชื่ออาจถูกปรับหลังจากเปิดหน้านี้</p>}
      </div>
    </section>
  </div>;
}
