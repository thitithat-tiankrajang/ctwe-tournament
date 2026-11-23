"use client";

import { Activity, ArrowRight, ChevronDown, ClipboardList, Info, ListOrdered, Trophy, Users, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
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
function School({ player }: { player?: Player }) {
  return <td className="vrep-school" title={player?.school}>{player?.school}</td>;
}

function ReportEmpty({ filter }: { filter: boolean }) {
  return <p className="panel-body meta">{filter ? "ไม่พบผู้เล่นตามคำค้น" : "ยังไม่มีข้อมูลการแข่งขัน"}</p>;
}

function Ranking({ card, throughGame, rows, filter, onOpen }: {
  card: TournamentCard; throughGame: number; rows: ReturnType<typeof rankingAfterGame>;
  filter: boolean; onOpen: OpenPlayer;
}) {
  return <section className="panel vrep-panel vrep-ranking" aria-label="ตารางอันดับ">
    <div className="panel-head"><h2>{throughGame > 0 ? `อันดับ · หลังเกม ${throughGame}` : "อันดับ · ก่อนเริ่มเกม 1"}</h2>
      <PrototypeViewerHelp label="ผลต่าง">อันดับคิดจากผลที่ประกาศแล้ว ผลต่างที่นับมีเพดานรายเกม</PrototypeViewerHelp></div>
    {rows.length ? <table className="st vrep-table" aria-label="ตารางอันดับ">
      <colgroup><col className="vrep-position" /><col className="vrep-player" /><col className="vrep-points" /><col className="vrep-diff" /><col className="vrep-school" /></colgroup>
      <thead><tr><th scope="col" className="vrep-position">อันดับ</th><th scope="col">นักกีฬา</th><th scope="col" className="vrep-number">คะแนนชนะ</th><th scope="col" className="vrep-number">ผลต่างสะสม</th>{schoolHead()}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id} id={`vr-${card.id}-${row.id}`} className={index % 2 ? "alt" : undefined}>
        <td className="pairno">{row.displayRank}</td><td className="vrep-person"><PlayerName player={row} onOpen={onOpen} /></td>
        <td className="n vrep-number vrep-score">{row.winPoints}</td><td className="n vrep-number">{signed(row.diff)}</td><School player={row} />
      </tr>)}</tbody>
    </table> : <ReportEmpty filter={filter} />}
  </section>;
}

function Pairings({ game, rows, players, seat, waiting, filter, onOpen }: {
  game: number; rows: Pairing[]; players: Map<string, Player>; seat: boolean; waiting: boolean; filter: boolean; onOpen: OpenPlayer;
}) {
  const position = <th scope="col" className="vrep-position">{seat ? "ที่นั่ง" : "คู่ที่"}</th>;
  return <section className="panel vrep-panel vrep-pairing" aria-label="คู่แข่งขัน">
    <div className="panel-head"><h2>คู่แข่งขัน · เกม {game}</h2>{waiting && <PrototypeViewerStatus tone="info">รอผล</PrototypeViewerStatus>}</div>
    {rows.length ? <table className="st vrep-table" aria-label="คู่แข่งขัน">
      <colgroup><col className="vrep-position" /><col className="vrep-player" /><col className="vrep-school" />{seat && <col className="vrep-position" />}<col className="vrep-player" /><col className="vrep-school" /></colgroup>
      <thead><tr>{position}<th scope="col">ผู้เล่น</th>{schoolHead()}{seat && position}<th scope="col">ผู้เล่น</th>{schoolHead()}</tr></thead>
      <tbody>{rows.map((pair, index) => {
        const one = players.get(pair.playerOneId ?? "");
        const two = players.get(pair.playerTwoId ?? "");
        return <tr className={index % 2 ? "alt" : undefined} key={pair.id}>
          <td className="pairno">{seat ? pair.tableNumber * 2 - 1 : pair.tableNumber}</td>
          <td className="vrep-person"><PlayerName player={one} onOpen={onOpen} /></td><School player={one} />
          {seat && <td className="pairno">{two ? pair.tableNumber * 2 : "—"}</td>}
          <td className="vrep-person"><PlayerName player={two} onOpen={onOpen} /></td><School player={two} />
        </tr>;
      })}</tbody>
    </table> : <ReportEmpty filter={filter} />}
  </section>;
}

function Results({ game, rows, players, seat, waiting, available, filter, onOpen }: {
  game: number; rows: Pairing[]; players: Map<string, Player>; seat: boolean; waiting: boolean; available: boolean; filter: boolean; onOpen: OpenPlayer;
}) {
  const head = <div className="panel-head"><h2>ผลการแข่งขัน · เกม {game}</h2>{waiting && <PrototypeViewerStatus tone="info">รอผล</PrototypeViewerStatus>}</div>;
  if (!available) return <section className="panel">{head}<div className="panel-body meta">ผลเกม {game} จะขึ้นที่นี่เมื่อประกาศ</div></section>;
  return <section className="panel vrep-panel vrep-result" aria-label="ผลการแข่งขัน">
    {head}
    {rows.length ? <table className="st st--viewer-result vrep-table" aria-label="ผลการแข่งขัน">
      <colgroup><col className="vrep-position" /><col className="vrep-player" /><col className="vrep-points" /><col className="vrep-diff" /><col className="vrep-school" /></colgroup>
      <thead><tr><th scope="col" className="vrep-position">{seat ? "ที่นั่ง" : "คู่ที่"}</th><th scope="col">ผู้เล่น</th><th scope="col" className="vrep-number">คะแนน</th><th scope="col" className="vrep-number">ผลต่าง</th>{schoolHead()}</tr></thead>
      {rows.map((pair, index) => {
        const one = players.get(pair.playerOneId ?? "");
        const two = players.get(pair.playerTwoId ?? "");
        const band = index % 2 ? "alt" : undefined;
        const recorded = isRecordedPairing(pair) && !pair.resultWithdrawn;
        const penalty = recorded && pair.resultType === "PENALTY";
        const cappedDiff = pair.calculatedDiff ?? 0;
        const diff = penalty ? `−${cappedDiff}` : two && recorded ? (cappedDiff ? `±${cappedDiff}` : "0") : "—";
        const score = (player: Player | undefined, value: number | undefined) =>
          <td className={`n vrep-number vrep-score${recorded && player && pair.winnerId === player.id ? " won" : ""}`}>{penalty && player ? "ลงดาบ" : recorded && player ? value ?? "—" : "—"}</td>;
        return <tbody className="vrep-match" key={pair.id}>
          <tr className={band}><td className="pairno" rowSpan={seat ? undefined : 2}>{seat ? pair.tableNumber * 2 - 1 : pair.tableNumber}</td>
            <td className="vrep-person"><PlayerName player={one} onOpen={onOpen} /></td>{score(one, pair.scoreOne)}
            <td className="n vrep-number vrep-pair-diff" rowSpan={2}>{diff}</td><School player={one} /></tr>
          <tr className={band}>{seat && <td className="pairno">{two ? pair.tableNumber * 2 : "—"}</td>}
            <td className="vrep-person"><PlayerName player={two} onOpen={onOpen} /></td>{score(two, pair.scoreTwo)}<School player={two} /></tr>
        </tbody>;
      })}
    </table> : <ReportEmpty filter={filter} />}
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
      <span className="code">{code}</span><span className="fin-c__n">{player ? displayName(player) : "ยังไม่มีรายชื่อผู้เล่น"}</span>
      <span className="fin-c__s">{player?.school}</span>{winner && <span className="fin-c__w">ผู้ชนะ</span>}
    </button>;
  };
  return <article className={`fin-m${major ? " fin-m--major" : ""}`} aria-label={major ? "คู่ชิงอันดับ 1 - 2" : "คู่ชิงอันดับ 3 - 4"}>
    <header className="fin-m__head"><h3>{major ? "อันดับ 1 – 2" : "อันดับ 3 – 4"}</h3><span className="meta">ชนะ {Math.floor(slot.games.length / 2) + 1} ใน {slot.games.length} เกม</span></header>
    <div className="fin-duel">
      {contender(first, "one", slot.playerOneId)}
      <div className="fin-series"><span className="code">{slot.playerOneId}</span><strong>{entered || slot.winnerId ? seriesWon(slot.playerOneId) : "–"}</strong>
        <span className="fin-series__dash">:</span><strong>{entered || slot.winnerId ? seriesWon(slot.playerTwoId) : "–"}</strong><span className="code">{slot.playerTwoId}</span></div>
      {contender(second, "two", slot.playerTwoId)}
    </div>
    <table className="fin-games" aria-label={`ผลรายเกม ชิงอันดับ ${major ? "1–2" : "3–4"}`}><thead><tr><th scope="col">เกม</th><th scope="col" className="n"><span className="code">{slot.playerOneId}</span></th><th scope="col" className="n"><span className="code">{slot.playerTwoId}</span></th></tr></thead>
      <tbody>{slot.games.map(game => <tr key={game.gameIndex}><td>{game.gameIndex}</td>
        <td className="n"><span className={game.winnerId === slot.playerOneId ? "fin-win" : undefined}>{game.scoreOne ?? "—"}</span></td>
        <td className="n"><span className={game.winnerId === slot.playerTwoId ? "fin-win" : undefined}>{game.scoreTwo ?? "—"}</span></td></tr>)}</tbody></table>
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
      <div className="format-section format-options"><div><span><b>หมายเลขที่ประกาศ</b><small>{card.slotLabel === "SEAT" ? "ที่นั่ง" : "คู่ที่"}</small></span>
        <PrototypeViewerHelp label="หมายเลขที่ประกาศ">คู่ที่ 1 ตรงกับที่นั่ง 1 และ 2 ใช้ดูตำแหน่งผู้เล่นในตารางคู่แข่งขัน</PrototypeViewerHelp>
      </div></div>
    </div>
  </div>;
}

const blankFilter: SpectatorReportContext["filter"] = { mode: "player", playerIds: [], schools: [], query: "" };
const publishTime = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

export function PrototypeSpectatorReport({ card, division, mobile, theme, bottom, scroller, initialContext, initiallyShowDetails, onLens, onPlayer }: {
  card: TournamentCard;
  division: SpectatorDivision;
  mobile: boolean;
  theme: CSSProperties;
  bottom: HTMLDivElement | null;
  scroller: HTMLDivElement | null;
  initialContext?: SpectatorReportContext | null;
  initiallyShowDetails: boolean;
  onLens: (game: SpectatorReportGame, views: SpectatorReportView[]) => void;
  onPlayer: (player: Player, target: HTMLElement, context: SpectatorReportContext) => void;
}) {
  const [historyGame, setHistoryGame] = useState(initialContext?.game ?? null);
  const [desktopViews, setDesktopViews] = useState<SpectatorReportView[]>(initialContext?.views ?? ["ranking", "pairing"]);
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
  const throughGame = [...officialGames].filter(number => number <= game).at(-1) ?? 0;
  const filtered = filter.playerIds.length > 0 || filter.schools.length > 0;
  const keeps = (code: string | null) => !filtered || (code !== null && (filter.playerIds.includes(code) || filter.schools.includes(players.get(code)?.school ?? "")));
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
  const updated = card.snapshots.flatMap(snapshot => snapshot.confirmedAt ? [snapshot.confirmedAt] : []).sort().at(-1);
  const publishAt = updated ? new Date(updated) : null;
  const select = (value: string) => setHistoryGame(value === "final" ? "final" : Number(value));
  const switchView = (view: SpectatorReportView) => setDesktopViews(previous => previous.includes(view)
    ? previous.filter(item => item !== view) : [...previous, view]);
  const openPlayer = (player: Player, target: HTMLElement) => onPlayer(player, target, { cardId: card.id, game: selected === "final" ? "final" : game, views, filter, scrollY: scroller?.scrollTop ?? 0 });
  const closeDetails = (focus = false) => { setDetails(false); if (focus) detailsButton.current?.focus({ preventScroll: true }); };

  const tabClick = (event: MouseEvent<HTMLButtonElement>, view: SpectatorReportView) => {
    setMobileView(view);
    event.currentTarget.focus({ preventScroll: true });
  };
  return <>
    <div className="vsub vsub--r6 vsub--r7">
      <button ref={detailsButton} type="button" className="vcard-trigger" aria-haspopup="dialog" aria-expanded={details} onClick={() => setDetails(!details)}>
        <Info className="i" size={17} /><span>รายละเอียดการแข่งขัน</span>
      </button>
      {!mobile && <div className="vt" role="group" aria-label="มุมมอง (เลือกได้หลายแบบ)">{controls.map(({ value, label, Icon }) =>
        <button type="button" className="vt__b" key={value} aria-pressed={desktopViews.includes(value)} onClick={() => switchView(value)}>
          <Icon className="i" size={15} /><span>{label}</span>
        </button>)}</div>}
      <PrototypeViewerGameSelect value={selected} theme={theme} options={selected ? options : [{ value: "", label: "ยังไม่ประกาศคู่", disabled: true }, ...options]} onChange={select} />
    </div>
    {details && <PrototypeViewerPopover anchor={detailsButton} kind="vcard" label="รายละเอียดการแข่งขัน" width={520} style={theme} onDismiss={closeDetails}>
      <CompetitionDetails card={card} onDismiss={() => closeDetails(true)} />
    </PrototypeViewerPopover>}
    <div key={[selected, ...views].join(":")} className="content v-fade" id="vbody">
      {filtered && <p className="vsearch-filter" role="status">{filter.query && <>กรองด้วย “{filter.query}”</>} <button type="button" className="btn btn--sm btn--secondary" onClick={() => setFilter(blankFilter)}>แสดงทุกคู่</button></p>}
      {!selected ? <div className="notice notice--quiet"><p>{card.runtimeStage === "PLAYER_REGISTRATION" ? "กำลังรอรายชื่อผู้เล่นและการประกาศคู่" : "กำลังรอประกาศคู่แข่งขัน"}</p></div>
        : selected === "final" && division.finals ? <section className="fin" aria-labelledby="public-fin-title">
          <header className="fin__head"><div><span className="fin__div">{card.name} · {card.division}</span><h2 id="public-fin-title">รอบชิงชนะเลิศ</h2></div>
            <PrototypeViewerStatus tone={division.publication.phase === "complete" ? "success" : "comp"}>{division.publication.phase === "complete" ? "ประกาศผลแล้ว" : "กำลังแข่งขัน"}</PrototypeViewerStatus></header>
          <div className="fin__matches">{division.finals.slots.map(slot => <FinalMatch key={slot.slot} slot={slot} players={players} onOpen={openPlayer} />)}</div>
        </section> : views.length ? <div key={game} className={`vrep-layout${views.length > 1 ? " vrep-layout--multiple" : ""}`}>
          {views.map(view => view === "ranking" ? <Ranking key={view} card={card} throughGame={throughGame} rows={rank} filter={filtered} onOpen={openPlayer} />
            : view === "pairing" ? <Pairings key={view} game={game} rows={rows} players={players} seat={division.slotLabel === "SEAT"} waiting={unpublished} filter={filtered} onOpen={openPlayer} />
            : <Results key={view} game={game} rows={rows} players={players} seat={division.slotLabel === "SEAT"} waiting={!resultsVisible} available={resultsVisible} filter={filtered} onOpen={openPlayer} />)}
        </div> : <div className="notice notice--quiet"><p>ยังไม่ได้เลือกมุมมอง</p></div>}
      {publishAt && Number.isFinite(publishAt.getTime()) && <p className="meta">เผยแพร่ล่าสุด {publishTime.format(publishAt)} น.</p>}
    </div>
    {mobile && selected && selected !== "final" && bottom && createPortal(<nav className="vnav" role="radiogroup" aria-label="มุมมองข้อมูลการแข่งขัน">
      <span className="ind" style={{ transform: `translateX(${controls.findIndex(view => view.value === mobileView) * 100}%)` }} />
      {controls.map(({ value, label }, index) => <button key={value} type="button" role="radio" aria-checked={mobileView === value}
        onClick={event => tabClick(event, value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const next = (index + (event.key === "ArrowLeft" ? -1 : 1) + controls.length) % controls.length;
          setMobileView(controls[next].value);
          event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
        }}>{label.toUpperCase()}</button>)}
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
    {division.finals && <section className="fin" aria-labelledby={`fin-${card.id}`}>
      <header className="fin__head"><div><span className="fin__div">{card.name} · {card.division}</span><h2 id={`fin-${card.id}`}>รอบชิงชนะเลิศ</h2></div>
        <PrototypeViewerStatus tone={division.publication.phase === "complete" ? "success" : "comp"}>{division.publication.phase === "complete" ? "ประกาศผลแล้ว" : "กำลังแข่งขัน"}</PrototypeViewerStatus></header>
      <div className="fin__matches">{division.finals.slots.map(slot => <FinalMatch key={slot.slot} slot={slot} players={players} onOpen={onOpen} />)}</div>
    </section>}
    {(rank.length > 0 || division.publication.pairingAvailable) && <div className={`report-grid${mobile ? " report-grid--stack" : ""}`}>
      {rank.length > 0 && <Ranking card={card} throughGame={throughGame} rows={rank} filter={false} onOpen={onOpen} />}
      {division.publication.pairingAvailable && rows.length > 0 && <Pairings game={game} rows={rows} players={players}
        seat={division.slotLabel === "SEAT"} waiting={!officialGames.has(game)} filter={false} onOpen={onOpen} />}
    </div>}
  </>;
}
