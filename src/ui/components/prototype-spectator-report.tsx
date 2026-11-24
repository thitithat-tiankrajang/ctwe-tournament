"use client";

import { Activity, ArrowRight, ChevronDown, ClipboardList, Info, ListOrdered, Trophy, Users, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { rankingAfterGame } from "@/domain/tournament/history";
import { isRecordedPairing, isVoidPairing } from "@/domain/tournament/pairing-slot";
import type { FinalSlot, Pairing, PairingRuleType, Player, TournamentCard } from "@/domain/tournament/types";
import type { SpectatorDivision } from "@/application/tournament/spectator-read-model";
import type { SpectatorReportContext, SpectatorReportGame, SpectatorReportView } from "@/application/tournament/spectator-route";
import { PrototypeViewerGameSelect, PrototypeViewerHelp, PrototypeViewerPopover, PrototypeViewerStatus, type PrototypeGameOption } from "./prototype-spectator-chrome";

const controls = [
  { value: "ranking", label: "Ranking", Icon: ListOrdered },
  { value: "pairing", label: "Pairing", Icon: Users },
  { value: "result", label: "Result", Icon: ClipboardList },
] as const;
const signed = (value: number) => value > 0 ? `+${value}` : String(value);

const desktopViews: SpectatorReportView[] = controls.map(({ value }) => value);

type SearchMatch = (id: string | null) => boolean;
type OpenPlayer = (player: Player, target: HTMLElement) => void;
const displayName = (player: Player) => `${player.firstName} ${player.lastName}`.trim();

function PlayerName({ player, onOpen }: { player?: Player; onOpen: OpenPlayer }) {
  if (!player) return <span className="meta">บาย</span>;
  const name = displayName(player);
  return <button type="button" className="idn" onClick={event => onOpen(player, event.currentTarget)}>
    <span className="l1"><span className="code">{player.id}</span><span className="nm" title={name}>{name}</span></span>
    <span className="l2" title={player.school}>{player.school}</span>
  </button>;
}

// A function, not a module-level element: tsx tests import this file under the classic JSX runtime.
const schoolHead = () => <th scope="col" className="vrep-school">โรงเรียน/สถาบัน</th>;
function ReportPerson({ player, onOpen, match }: { player?: Player; onOpen: OpenPlayer; match?: SearchMatch }) {
  const highlighted = match?.(player?.id ?? null) || undefined;
  return <>
    <td className="vrep-person" data-v-search-match={highlighted}><PlayerName player={player} onOpen={onOpen} /></td>
    <td className="vrep-school" data-v-search-match={highlighted} title={player?.school}>{player?.school}</td>
  </>;
}

function ReportHeading({ title, publishedAt, children }: { title: string; publishedAt?: string; children?: React.ReactNode }) {
  const time = publishedAt ? new Date(publishedAt) : null;
  return <div className="panel-head"><div className="vrep-heading"><h2>{title}</h2>
    {time && Number.isFinite(time.getTime()) && <time dateTime={publishedAt} className="vrep-published">เผยแพร่ {publishTime.format(time)} น.</time>}
  </div>{children}</div>;
}

type LinkPair = (table: number, target: "pairing" | "result") => void;

function PairNumber({ number, onLink }: { number: number; onLink?: () => void }) {
  return onLink ? <button type="button" className="vrep-pair-link" onClick={onLink} aria-label={`ดูข้อมูลหมายเลข ${number} ในอีกตาราง`}>{number}</button> : number;
}

function ReportEmpty({ filter }: { filter: boolean }) {
  return <p className="panel-body meta">{filter ? "ไม่พบผู้เล่นตามคำค้น" : "ยังไม่มีข้อมูลการแข่งขัน"}</p>;
}

function Ranking({ card, throughGame, rows, filter, onOpen, match, publishedAt }: {
  card: TournamentCard; throughGame: number; rows: ReturnType<typeof rankingAfterGame>;
  filter: boolean; onOpen: OpenPlayer; match?: SearchMatch; publishedAt?: string;
}) {
  return <section className="panel vrep-panel vrep-ranking" aria-label="ตารางอันดับ">
    <ReportHeading title={throughGame > 0 ? `อันดับ · หลังเกม ${throughGame}` : "อันดับ · ก่อนเริ่มเกม 1"} publishedAt={publishedAt}>
      <PrototypeViewerHelp label="ผลต่าง">อันดับคิดจากผลที่ประกาศแล้ว ผลต่างที่นับมีเพดานรายเกม</PrototypeViewerHelp>
    </ReportHeading>
    {rows.length ? <div className="vrep-scroll"><table className="st vrep-table" aria-label="ตารางอันดับ">
      <colgroup><col className="vrep-position" /><col className="vrep-player" /><col className="vrep-school" /><col className="vrep-points" /><col className="vrep-diff" /></colgroup>
      <thead><tr><th scope="col" className="vrep-position">อันดับ</th><th scope="col">นักกีฬา</th>{schoolHead()}<th scope="col" className="vrep-number">คะแนนชนะ</th><th scope="col" className="vrep-number">ผลต่างสะสม</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id} id={`vr-${card.id}-${row.id}`} className={index % 2 ? "alt" : undefined}>
        <td className="pairno">{row.displayRank}</td><ReportPerson player={row} onOpen={onOpen} match={match} />
        <td className="n vrep-number vrep-score">{row.winPoints}</td><td className="n vrep-number">{signed(row.diff)}</td>
      </tr>)}</tbody>
    </table></div> : <ReportEmpty filter={filter} />}
  </section>;
}

function Pairings({ game, rows, players, seat, waiting, filter, onOpen, match, publishedAt, linked, onLink }: {
  game: number; rows: Pairing[]; players: Map<string, Player>; seat: boolean; waiting: boolean; filter: boolean; onOpen: OpenPlayer; match?: SearchMatch; publishedAt?: string; linked?: number; onLink?: LinkPair;
}) {
  const position = <th scope="col" className="vrep-position">{seat ? "ที่นั่ง" : "คู่ที่"}</th>;
  return <section className="panel vrep-panel vrep-pairing" aria-label="คู่แข่งขัน">
    <ReportHeading title={`คู่แข่งขัน · เกม ${game}`} publishedAt={publishedAt}>{waiting && <PrototypeViewerStatus tone="info">รอผล</PrototypeViewerStatus>}</ReportHeading>
    {rows.length ? <div className="vrep-scroll"><table className="st vrep-table" aria-label="คู่แข่งขัน">
      <colgroup><col className="vrep-position" /><col className="vrep-player" /><col className="vrep-school" />{seat && <col className="vrep-position" />}<col className="vrep-player" /><col className="vrep-school" /></colgroup>
      <thead><tr>{position}<th scope="col">ผู้เล่น</th>{schoolHead()}{seat && position}<th scope="col">ผู้เล่น</th>{schoolHead()}</tr></thead>
      <tbody>{rows.map((pair, index) => {
        const one = players.get(pair.playerOneId ?? "");
        const two = players.get(pair.playerTwoId ?? "");
        return <tr className={index % 2 ? "alt" : undefined} key={pair.id} data-table={pair.tableNumber} data-v-linked={linked === pair.tableNumber}>
          <td className="pairno"><PairNumber number={seat ? pair.tableNumber * 2 - 1 : pair.tableNumber} onLink={onLink && (() => onLink(pair.tableNumber, "result"))} /></td>
          <ReportPerson player={one} onOpen={onOpen} match={match} />
          {seat && <td className="pairno">{two ? pair.tableNumber * 2 : "—"}</td>}
          <ReportPerson player={two} onOpen={onOpen} match={match} />
        </tr>;
      })}</tbody>
    </table></div> : <ReportEmpty filter={filter} />}
  </section>;
}

function Results({ game, rows, players, seat, available, filter, onOpen, match, publishedAt, linked, onLink }: {
  game: number; rows: Pairing[]; players: Map<string, Player>; seat: boolean; available: boolean; filter: boolean; onOpen: OpenPlayer; match?: SearchMatch; publishedAt?: string; linked?: number; onLink?: LinkPair;
}) {
  const head = <ReportHeading title={`ผลการแข่งขัน · เกม ${game}`} publishedAt={publishedAt}>
    {!available && <PrototypeViewerStatus tone="info">รอผล</PrototypeViewerStatus>}
  </ReportHeading>;
  return <section className="panel vrep-panel vrep-result" aria-label="ผลการแข่งขัน">
    {head}
    {!available ? <div className="panel-body meta">ผลเกม {game} จะขึ้นที่นี่เมื่อประกาศ</div> : rows.length ? <div className="vrep-scroll"><table className="st st--viewer-result vrep-table" aria-label="ผลการแข่งขัน">
      <colgroup><col className="vrep-position" /><col className="vrep-player" /><col className="vrep-school" /><col className="vrep-points" /><col className="vrep-diff" /></colgroup>
      <thead><tr><th scope="col" className="vrep-position">{seat ? "ที่นั่ง" : "คู่ที่"}</th><th scope="col">ผู้เล่น</th>{schoolHead()}<th scope="col" className="vrep-number">คะแนน</th><th scope="col" className="vrep-number">ผลต่าง</th></tr></thead>
      {rows.map((pair, index) => {
        const one = players.get(pair.playerOneId ?? "");
        const two = players.get(pair.playerTwoId ?? "");
        const band = index % 2 ? "alt" : undefined;
        const recorded = isRecordedPairing(pair) && !pair.resultWithdrawn;
        const penalty = recorded && pair.resultType === "PENALTY";
        const cappedDiff = pair.calculatedDiff ?? 0;
        const diff = penalty ? `−${cappedDiff}` : two && recorded ? (cappedDiff ? `±${cappedDiff}` : "0") : "—";
        const score = (player: Player | undefined, value: number | undefined) =>
          <td data-v-search-match={match?.(player?.id ?? null) || undefined} className={`n vrep-number vrep-score${recorded && player && pair.winnerId === player.id ? " won" : ""}`}>{penalty && player ? "ลงดาบ" : recorded && player ? value ?? "—" : "—"}</td>;
        return <tbody className="vrep-match" key={pair.id} data-table={pair.tableNumber}>
          <tr className={band} data-v-linked={linked === pair.tableNumber}><td className="pairno" rowSpan={seat ? undefined : 2}><PairNumber number={seat ? pair.tableNumber * 2 - 1 : pair.tableNumber} onLink={onLink && (() => onLink(pair.tableNumber, "pairing"))} /></td>
            <ReportPerson player={one} onOpen={onOpen} match={match} />{score(one, pair.scoreOne)}
            <td className="n vrep-number vrep-pair-diff" rowSpan={2}>{diff}</td></tr>
          <tr className={band} data-v-linked={linked === pair.tableNumber}>{seat && <td className="pairno">{two ? pair.tableNumber * 2 : "—"}</td>}
            <ReportPerson player={two} onOpen={onOpen} match={match} />{score(two, pair.scoreTwo)}</tr>
        </tbody>;
      })}
    </table></div> : <ReportEmpty filter={filter} />}
  </section>;
}

function FinalMatch({ slot, players, onOpen }: { slot: FinalSlot; players: Map<string, Player>; onOpen: OpenPlayer }) {
  const major = slot.slot === 0;
  const first = players.get(slot.playerOneId);
  const second = players.get(slot.playerTwoId);
  const entered = slot.games.some(game => game.scoreOne != null && game.scoreTwo != null);
  const seriesWon = (code: string) => slot.winnerId && slot.winnerWins != null && slot.winnerLosses != null
    ? (code === slot.winnerId ? slot.winnerWins : slot.winnerLosses) : slot.games.filter(game => game.winnerId === code).length;
  const contender = (player: Player | undefined, side: string, code: string) => {
    const winner = Boolean(slot.winnerId && slot.winnerId === code);
    return <button type="button" className={`fin-c fin-c--${side}${winner ? " is-win" : ""}`} disabled={!player}
      onClick={event => { if (player) onOpen(player, event.currentTarget); }}>
      <span className="fin-c__line"><span className="code">{code}</span>{winner && <span className="fin-c__w">ผู้ชนะ</span>}</span><span className="fin-c__n">{player ? displayName(player) : "ยังไม่มีรายชื่อผู้เล่น"}</span>
      <span className="fin-c__s" title={player?.school}>{player?.school}</span>
    </button>;
  };
  return <article className={`fin-m${major ? " fin-m--major" : ""}`} aria-label={major ? "คู่ชิงอันดับ 1 - 2" : "คู่ชิงอันดับ 3 - 4"}>
    <header className="fin-m__head"><h3>{major ? "คู่ชิงอันดับ 1–2" : "คู่ชิงอันดับ 3–4"}</h3></header>
    <div className="fin-scoreboard">
      <div className="fin-duel">{contender(first, "one", slot.playerOneId)}{contender(second, "two", slot.playerTwoId)}</div>
      <div className="fin-series" role="group" aria-label="จำนวนเกมที่ชนะ">
        <strong>{entered || slot.winnerId ? seriesWon(slot.playerOneId) : "–"}</strong>
        <span className="fin-series__label">เกมที่ชนะ</span>
        <strong>{entered || slot.winnerId ? seriesWon(slot.playerTwoId) : "–"}</strong>
      </div>
    </div>
    <table className="fin-games" aria-label={`ผลรายเกม ชิงอันดับ ${major ? "1–2" : "3–4"}`}>
      <colgroup><col /><col className="fin-middle" /><col /></colgroup>
      <thead><tr><th scope="col"><span className="code">{slot.playerOneId}</span></th><th scope="col">ผลรายเกม</th>
        <th scope="col"><span className="code">{slot.playerTwoId}</span></th></tr></thead>
      <tbody>{slot.games.map(game => <tr key={game.gameIndex}>
        <td className={game.scoreOne == null ? "fin-pending" : game.winnerId === slot.playerOneId ? "fin-win" : undefined}>{game.scoreOne ?? "—"}</td>
        <th scope="row">เกม {game.gameIndex}</th>
        <td className={game.scoreTwo == null ? "fin-pending" : game.winnerId === slot.playerTwoId ? "fin-win" : undefined}>{game.scoreTwo ?? "—"}</td>
      </tr>)}</tbody>
    </table>
  </article>;
}

const pairingRules: Record<PairingRuleType, [string, string]> = {
  RANDOM: ["Random", "สุ่มคู่และกระจายผู้เล่นจากสถาบันเดียวกัน"],
  SWISS: ["Swiss Pairing", "จับคู่ตามคะแนนและผลต่าง"],
  PAIR_RESULT: ["สลับในโต๊ะตามผล", "ผู้ชนะพบผู้ชนะ ผู้แพ้พบผู้แพ้ เล่นสองเกมเป็นชุดเดียวกัน"],
  KING_OF_THE_HILL: ["King of the Hill", "ให้อันดับที่อยู่ใกล้กันพบกัน"],
};

function CompetitionDetails({ card, onDismiss }: { card: TournamentCard; onDismiss: () => void }) {
  const pairings = [{ fromGame: 0, toGame: 1, type: card.initialPairingRule }, ...card.rules];
  return <div className="vcard-pop competition-format">
    <header className="format-header"><div><h2>รายละเอียดการแข่งขัน</h2><p>{card.name} · {card.division}</p></div>
      <button type="button" className="format-close" aria-label="ปิดรายละเอียดการแข่งขัน" onClick={onDismiss}><X className="i" size={17} /></button>
    </header>
    <div className="format-body">
      <div className="format-section"><div className="format-disclosure">
        <details className="format-pairing"><summary><span><ListOrdered className="i" size={16} />ลำดับ Pairing</span>
          <span className="format-summary-end">{card.games.length} เกม <ChevronDown className="i" size={16} /></span></summary>
          <ol className="format-pairing-list">{pairings.map(rule => <li key={rule.toGame}>
            <span className="format-transition">{rule.fromGame > 0 && <><span className="format-game">เกม {rule.fromGame}</span><ArrowRight className="i" size={13} /></>}
              <span className="format-game">เกม {rule.toGame}</span></span>
            <span className="format-rule"><b>{pairingRules[rule.type][0]}</b><small>{pairingRules[rule.type][1]}</small></span>
          </li>)}</ol>
          {card.games.length > 1 && card.rules.length === 0 && <p className="format-meta">ยังไม่มีข้อมูลวิธีจับคู่เกมถัดไปในรายงานสาธารณะ</p>}
        </details>
        <PrototypeViewerHelp label="ลำดับ Pairing">เกม 1 ใช้กติกาเริ่มต้น ส่วนกติกาบนลูกศรใช้สร้างคู่ของเกมปลายทาง</PrototypeViewerHelp>
      </div></div>
      <section className="format-section" aria-labelledby="format-diff">
        <div className="format-title"><h3 id="format-diff"><Activity className="i" size={16} />Max diff รายเกม</h3>
          <PrototypeViewerHelp label="Max diff รายเกม">ผลต่างที่นำไปคิดอันดับถูกจำกัดตามเพดานของเกมนั้น คะแนนที่ทำจริงยังแสดงตามเดิม</PrototypeViewerHelp></div>
        <dl className="format-diffs">{card.games.map(game => <div key={game.number}><dt>เกม {game.number}</dt><dd>{game.maxDiff.toLocaleString("th-TH")} <span>คะแนน</span></dd></div>)}</dl>
      </section>
      <section className="format-section" aria-labelledby="format-final">
        <div className="format-title"><h3 id="format-final"><Trophy className="i" size={16} />รอบชิงชนะเลิศ</h3>
          <PrototypeViewerHelp label="รอบชิงชนะเลิศ">ผู้เข้าชิงมาจากอันดับหลังเกมปกติสุดท้าย รอบชิงไม่มี Max diff</PrototypeViewerHelp></div>
        {card.finalType !== "NONE" ? <ul className="format-finals">
          <li><b>ชิงอันดับ 1–2</b><span>{card.finalGames} เกม</span></li>
          {card.finalType === "CHAMPION_AND_THIRD" && <li><b>ชิงอันดับ 3–4</b><span>{card.finalGames} เกม</span></li>}
        </ul> : <p className="format-meta">ไม่มีรอบชิง</p>}
      </section>
    </div>
  </div>;
}

const blankFilter: SpectatorReportContext["filter"] = { mode: "player", playerIds: [], schools: [], query: "" };
const publishTime = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

export function PrototypeSpectatorReport({ card, division, mobile, theme, bottom, scroller, initialContext, initiallyShowDetails, onLens, onPlayer, highlightedId }: {
  card: TournamentCard;
  division: SpectatorDivision;
  mobile: boolean;
  theme: CSSProperties;
  bottom: HTMLDivElement | null;
  scroller: HTMLDivElement | null;
  initialContext?: SpectatorReportContext | null;
  initiallyShowDetails: boolean;
  highlightedId?: string;
  onLens: (game: SpectatorReportGame, views: SpectatorReportView[]) => void;
  onPlayer: (player: Player, target: HTMLElement, context: SpectatorReportContext) => void;
}) {
  const [historyGame, setHistoryGame] = useState(initialContext?.game ?? null);
  const [linkedPair, setLinkedPair] = useState<{ game: number; table: number }>();
  const reportStage = useRef<HTMLDivElement>(null);
  const [mobileView, setMobileView] = useState<SpectatorReportView>(initialContext?.views[0] ?? "pairing");
  const [filter, setFilter] = useState(initialContext?.filter ?? blankFilter);
  const [details, setDetails] = useState(initiallyShowDetails);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const views = mobile ? [mobileView] : desktopViews;
  const activeGames = new Set(division.publication.publishedGames);
  const officialGames = new Set(division.publication.officialGames);
  const options: PrototypeGameOption[] = card.games.map(game => ({
    value: String(game.number), label: `เกม ${game.number}`, disabled: !activeGames.has(game.number),
    detail: !activeGames.has(game.number) ? "รอประกาศคู่" : !officialGames.has(game.number) ? "รอผล" : undefined,
  }));
  if (card.finalType !== "NONE") options.push({
    value: "final", label: "รอบชิงชนะเลิศ", disabled: !division.finals,
    detail: !division.finals ? "รอประกาศคู่" : division.publication.phase !== "complete" ? "รอผล" : undefined,
  });
  const available = options.filter(option => !option.disabled);
  const selected = available.find(option => option.value === String(historyGame))?.value ?? available.at(-1)?.value ?? "";
  const game = selected && selected !== "final" ? Number(selected) : 0;
  useEffect(() => { onLens(selected === "final" ? "final" : game || null, views); }, [game, selected, views, onLens]);
  const players = new Map(card.players.map(player => [player.id, player]));
  const throughGame = division.publication.officialThroughGame ?? 0;
  const filtered = filter.playerIds.length > 0 || filter.schools.length > 0;
  const matches = (code: string | null) => Boolean(code && (code === highlightedId || filter.playerIds.includes(code) || filter.schools.includes(players.get(code)?.school ?? "")));
  const keeps = (code: string | null) => !filtered || matches(code);
  const rank = views.includes("ranking") ? rankingAfterGame(card, throughGame).filter(row => keeps(row.id)) : [];
  const pairings = new Map<string, { row: Pairing; confirmed: boolean }>();
  for (const snapshot of card.snapshots) {
    for (const row of snapshot.pairings) {
      if ((row.gameNumber ?? snapshot.gameNumbers[0]) !== game || (!snapshot.confirmedAt && !row.pairingPublished)) continue;
      if (snapshot.confirmedAt || !pairings.get(row.id)?.confirmed) pairings.set(row.id, { row, confirmed: Boolean(snapshot.confirmedAt) });
    }
  }
  const previous = [...pairings.values()].map(entry => entry.row).filter(row => !isVoidPairing(row));
  const rows = previous.filter(row => keeps(row.playerOneId) || keeps(row.playerTwoId));
  const unpublished = !officialGames.has(game);
  const resultsVisible = !unpublished || previous.some(row => isRecordedPairing(row) && !row.resultWithdrawn);
  const confirmedAt = (number: number) => card.snapshots.find(snapshot => snapshot.confirmedAt && snapshot.gameNumbers.includes(number))?.confirmedAt;
  const pairingAt = previous.flatMap(row => row.pairingPublishedAt ? [row.pairingPublishedAt] : []).sort().at(0);
  const select = (value: string) => {
    setHistoryGame(value === "final" ? "final" : Number(value));
    setLinkedPair(undefined);
  };
  const linkPair: LinkPair = (table, target) => {
    setLinkedPair({ game, table });
    reportStage.current?.querySelector(`.vrep-${target} [data-table="${table}"]`)?.scrollIntoView({
      block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };
  const transition = `${selected}:${mobile ? mobileView : "desktop"}`;
  const lastTransition = useRef(transition);
  useLayoutEffect(() => {
    if (lastTransition.current === transition) return;
    lastTransition.current = transition;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animations = Array.from(reportStage.current?.querySelectorAll(mobile ? ".vrep-scroll, .fin__matches" : ".vrep-main .vrep-scroll, .fin__matches") ?? []).map(panel => panel.animate(
      [{ opacity: 0.74, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 180, easing: "cubic-bezier(.22,.8,.25,1)" },
    ));
    return () => animations.forEach(animation => animation.cancel());
  }, [mobile, transition]);
  const openPlayer = (player: Player, target: HTMLElement) => onPlayer(player, target, { cardId: card.id, game: selected === "final" ? "final" : game, views, filter, scrollY: scroller?.scrollTop ?? 0 });
  const closeDetails = (focus = false) => { setDetails(false); if (focus) detailsButton.current?.focus({ preventScroll: true }); };

  const tabClick = (event: MouseEvent<HTMLButtonElement>, view: SpectatorReportView) => {
    setMobileView(view);
    event.currentTarget.focus({ preventScroll: true });
  };
  return <>
    <div className="vsub vsub--r6 vsub--r7 vsub--report">
      <button ref={detailsButton} type="button" className="vcard-trigger" aria-haspopup="dialog" aria-expanded={details} onClick={() => setDetails(!details)}>
        <Info className="i" size={17} /><span>รายละเอียดการแข่งขัน</span>
      </button>
      <PrototypeViewerGameSelect value={selected} theme={theme} options={selected ? options : [{ value: "", label: "ยังไม่ประกาศคู่", disabled: true }, ...options]} onChange={select} />
    </div>
    {details && <PrototypeViewerPopover anchor={detailsButton} kind="vcard" label="รายละเอียดการแข่งขัน" width={520} style={theme} onDismiss={closeDetails}>
      <CompetitionDetails card={card} onDismiss={() => closeDetails(true)} />
    </PrototypeViewerPopover>}
    <div className="content" id="vbody">
      {filtered && <p className="vsearch-filter" role="status">{filter.query && <>กรองด้วย “{filter.query}”</>} <button type="button" className="btn btn--sm btn--secondary" onClick={() => setFilter(blankFilter)}>แสดงทั้งหมด</button></p>}
      <div ref={reportStage} className="vreport-stage">
        {!selected ? <div className="notice notice--quiet"><p>{card.runtimeStage === "PLAYER_REGISTRATION" ? "กำลังรอรายชื่อผู้เล่นและการประกาศคู่" : "กำลังรอประกาศคู่แข่งขัน"}</p></div>
          : selected === "final" && division.finals ? <section className="fin" aria-label="รอบชิงชนะเลิศ">
            <div className="fin__matches">{division.finals.slots.map(slot => <FinalMatch key={slot.slot} slot={slot} players={players} onOpen={openPlayer} />)}</div>
          </section> : <div className={`vrep-layout${mobile ? " vrep-layout--mobile" : " vrep-layout--workspace"}`}>
            {(!mobile || mobileView === "ranking") && <Ranking card={card} throughGame={throughGame} rows={rank} filter={filtered}
              onOpen={openPlayer} match={matches} publishedAt={confirmedAt(throughGame)} />}
            {(!mobile || mobileView !== "ranking") && <div className="vrep-main">
              {(!mobile || mobileView === "pairing") && <Pairings game={game} rows={rows} players={players} seat={division.slotLabel === "SEAT"}
                waiting={unpublished} filter={filtered} onOpen={openPlayer} match={matches} publishedAt={pairingAt}
                linked={linkedPair?.game === game ? linkedPair.table : undefined} onLink={!mobile && resultsVisible ? linkPair : undefined} />}
              {(!mobile || mobileView === "result") && <Results game={game} rows={rows} players={players} seat={division.slotLabel === "SEAT"}
                available={resultsVisible} filter={filtered} onOpen={openPlayer} match={matches} publishedAt={confirmedAt(game)}
                linked={linkedPair?.game === game ? linkedPair.table : undefined} onLink={!mobile ? linkPair : undefined} />}
            </div>}
          </div>}
      </div>
    </div>
    {mobile && selected && selected !== "final" && bottom && createPortal(<nav className="vnav" role="radiogroup" aria-label="มุมมองข้อมูลการแข่งขัน">
      <span className="ind" style={{ transform: `translateX(${controls.findIndex(view => view.value === mobileView) * 100}%)` }} />
      {controls.map(({ value, label, Icon }, index) => <button key={value} type="button" role="radio" aria-checked={mobileView === value}
        onClick={event => tabClick(event, value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const next = (index + (event.key === "ArrowLeft" ? -1 : 1) + controls.length) % controls.length;
          setMobileView(controls[next].value);
          event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
        }}><Icon className="i" size={14} aria-hidden />{label.toUpperCase()}</button>)}
    </nav>, bottom)}
  </>;
}

/**
 * The accepted design's read-only report block for a back-office overview: the published ranking
 * beside the current game's announced pairings, with the final board above them once finals are
 * announced. Same panels and gating as the public report.
 */
export function PrototypeCardReport({ card, division, mobile, onOpen }: {
  card: TournamentCard;
  division: SpectatorDivision;
  mobile: boolean;
  onOpen: OpenPlayer;
}) {
  if (card.runtimeStage === "PLAYER_REGISTRATION") return <div className="notice notice--quiet">
    <p><strong>กำลังรอรายชื่อผู้เล่น</strong><span>{card.players.length} คนลงทะเบียนแล้ว</span></p>
  </div>;
  const players = new Map(card.players.map(player => [player.id, player]));
  const officialGames = new Set(division.publication.officialGames);
  const throughGame = division.publication.officialThroughGame ?? 0;
  const game = division.publication.currentGame;
  const pairings = new Map<string, { row: Pairing; confirmed: boolean }>();
  for (const snapshot of card.snapshots) {
    for (const row of snapshot.pairings) {
      if ((row.gameNumber ?? snapshot.gameNumbers[0]) !== game || (!snapshot.confirmedAt && !row.pairingPublished)) continue;
      if (snapshot.confirmedAt || !pairings.get(row.id)?.confirmed) pairings.set(row.id, { row, confirmed: Boolean(snapshot.confirmedAt) });
    }
  }
  const rows = [...pairings.values()].map(entry => entry.row).filter(row => !isVoidPairing(row));
  const rank = throughGame > 0 ? rankingAfterGame(card, throughGame) : [];
  return <>
    {division.finals && <section className="fin" aria-label="รอบชิงชนะเลิศ">
      <div className="fin__matches">{division.finals.slots.map(slot => <FinalMatch key={slot.slot} slot={slot} players={players} onOpen={onOpen} />)}</div>
    </section>}
    {(rank.length > 0 || division.publication.pairingAvailable) && <div className={`report-grid${mobile ? " report-grid--stack" : ""}`}>
      {rank.length > 0 && <Ranking card={card} throughGame={throughGame} rows={rank} filter={false} onOpen={onOpen} />}
      {division.publication.pairingAvailable && rows.length > 0 && <Pairings game={game} rows={rows} players={players}
        seat={division.slotLabel === "SEAT"} waiting={!officialGames.has(game)} filter={false} onOpen={onOpen} />}
    </div>}
  </>;
}
