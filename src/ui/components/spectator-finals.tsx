import { Trophy } from "lucide-react";
import type { FinalSlot, Player, TournamentCard } from "@/domain/tournament/types";

type FinalsState = "waiting" | "active" | "entered" | "official";
type WinnerState = "official" | "entered" | null;

const isPublished = (card: TournamentCard) => card.runtimeStage === "FINAL_PUBLISHED"
  || card.status === "FINISHED"
  || card.status === "CLOSED";

function finalsState(card: TournamentCard): FinalsState {
  if (!card.finalRound) return "waiting";
  if (isPublished(card)) return "official";
  if (card.finalRound.slots.some((slot) => slot.winnerId)) return "entered";
  return "active";
}

const stateLabel: Record<FinalsState, string> = {
  waiting: "ยังไม่เริ่มรอบชิง",
  active: "กำลังแข่งขัน",
  entered: "บันทึกผลแล้ว · รอประกาศ",
  official: "ผลการแข่งขันอย่างเป็นทางการ",
};

const matchTitle = (slot: number) => slot === 0 ? "คู่ชิงอันดับ 1 - 2" : "คู่ชิงอันดับ 3 - 4";
const playedGames = (slot: FinalSlot) => slot.games.filter((game) => game.scoreOne != null && game.scoreTwo != null);

function winsFor(slot: FinalSlot, playerId: string) {
  if (slot.winnerId && slot.winnerWins != null && slot.winnerLosses != null) {
    return slot.winnerId === playerId ? slot.winnerWins : slot.winnerLosses;
  }
  return playedGames(slot).filter((game) => game.winnerId === playerId).length;
}

function matchState(slot: FinalSlot, official: boolean) {
  if (official && slot.winnerId) return "เป็นทางการ";
  if (slot.winnerId) return "รอประกาศ";
  if (playedGames(slot).length > 0) return "กำลังแข่งขัน";
  return "ยังไม่มีผลการแข่งขัน";
}

function winnerState(slot: FinalSlot, playerId: string, official: boolean): WinnerState {
  if (slot.winnerId !== playerId) return null;
  return official ? "official" : "entered";
}

function PlayerIdentity({ player, winner, seriesWins, showSeries, onOpen }: {
  player?: Player;
  winner: WinnerState;
  seriesWins?: number;
  showSeries?: boolean;
  onOpen?: (player: Player) => void;
}) {
  const content = <>
    <span className="spectator-final-player__code">{player?.id ?? "—"}</span>
    <span className="spectator-final-player__identity">
      <strong>{player ? `${player.firstName} ${player.lastName}`.trim() : "ยังไม่มีรายชื่อผู้เล่น"}</strong>
      {player?.school && <small>{player.school}</small>}
      {winner && <span className={`spectator-final-player__winner spectator-final-player__winner--${winner}`}>
        {winner === "official" ? "ผู้ชนะอย่างเป็นทางการ" : "บันทึกเป็นผู้ชนะ"}
      </span>}
    </span>
    {seriesWins != null && <span className="spectator-final-player__series" aria-label={showSeries ? `${seriesWins} เกมชนะ` : "ยังไม่มีผลการแข่งขัน"}>
      <strong>{showSeries ? seriesWins : "—"}</strong><small>เกมชนะ</small>
    </span>}
  </>;
  const className = `spectator-final-player${winner ? " spectator-final-player--winner" : ""}`;
  return player && onOpen
    ? <button type="button" className={className} onClick={() => onOpen(player)}>{content}</button>
    : <div className={className}>{content}</div>;
}

function SeriesScore({ slot }: { slot: FinalSlot }) {
  const played = playedGames(slot);
  const showScore = played.length > 0 || Boolean(slot.winnerId);
  const one = winsFor(slot, slot.playerOneId);
  const two = winsFor(slot, slot.playerTwoId);
  return <div className="spectator-final-series" aria-label={showScore ? `${slot.playerOneId} ${one} เกมชนะ, ${slot.playerTwoId} ${two} เกมชนะ` : "ยังไม่มีผลการแข่งขัน"}>
    <span className="spectator-final-series__code">{slot.playerOneId}</span>
    <strong className="spectator-final-series__score">{showScore ? one : "—"}</strong>
    <span className="spectator-final-series__dash" aria-hidden="true">–</span>
    <strong className="spectator-final-series__score">{showScore ? two : "—"}</strong>
    <span className="spectator-final-series__code">{slot.playerTwoId}</span>
    <span className="spectator-final-series__caption">
      {showScore ? `ผลรวม ${played.length} เกม` : "รอผลการแข่งขัน"}
      {slot.totalDiff != null && <> · ผลต่าง {slot.totalDiff > 0 ? "+" : ""}{slot.totalDiff}</>}
    </span>
  </div>;
}

function GameBreakdown({ slot, compact = false }: { slot: FinalSlot; compact?: boolean }) {
  return <section className={`spectator-final-games${compact ? " spectator-final-games--compact" : ""}`} aria-label={`ผลรายเกม ${matchTitle(slot.slot)}`}>
    <div className="spectator-final-games__head" aria-hidden="true">
      <span>ผลรายเกม</span><strong>{slot.playerOneId}</strong><span /><strong>{slot.playerTwoId}</strong>
    </div>
    {slot.games.map((game) => <div className="spectator-final-game" key={game.gameIndex}>
      <span>เกม {game.gameIndex}</span>
      <strong className={game.winnerId === slot.playerOneId ? "spectator-final-game__winner" : undefined}>{game.scoreOne ?? "—"}</strong>
      <i>–</i>
      <strong className={game.winnerId === slot.playerTwoId ? "spectator-final-game__winner" : undefined}>{game.scoreTwo ?? "—"}</strong>
    </div>)}
  </section>;
}

function Championship({ slot, players, official, onOpenPlayer }: {
  slot: FinalSlot;
  players: Map<string, Player>;
  official: boolean;
  onOpenPlayer?: (player: Player) => void;
}) {
  return <article className="spectator-final-championship spectator-final-match--championship">
    <header className="spectator-final-championship__header">
      <div><span>คู่เอก</span><h3>{matchTitle(slot.slot)}</h3></div>
      <strong>{matchState(slot, official)}</strong>
    </header>
    <div className="spectator-final-championship__duel">
      <div className={`spectator-final-contender spectator-final-contender--one${slot.winnerId === slot.playerOneId ? " spectator-final-contender--winner" : ""}`}>
        <PlayerIdentity player={players.get(slot.playerOneId)} winner={winnerState(slot, slot.playerOneId, official)} onOpen={onOpenPlayer} />
      </div>
      <SeriesScore slot={slot} />
      <div className={`spectator-final-contender spectator-final-contender--two${slot.winnerId === slot.playerTwoId ? " spectator-final-contender--winner" : ""}`}>
        <PlayerIdentity player={players.get(slot.playerTwoId)} winner={winnerState(slot, slot.playerTwoId, official)} onOpen={onOpenPlayer} />
      </div>
    </div>
    {slot.games.length > 0 && <GameBreakdown slot={slot} />}
  </article>;
}

function ThirdPlace({ slot, players, official, onOpenPlayer }: {
  slot: FinalSlot;
  players: Map<string, Player>;
  official: boolean;
  onOpenPlayer?: (player: Player) => void;
}) {
  const played = playedGames(slot);
  const showSeries = played.length > 0 || Boolean(slot.winnerId);
  return <section className="spectator-final-third spectator-final-match--placement">
    <header className="spectator-final-third__header">
      <div><span>อันดับ 3 - 4</span><h3>{matchTitle(slot.slot)}</h3></div>
      <strong>{matchState(slot, official)}</strong>
    </header>
    <div className="spectator-final-third__players">
      <PlayerIdentity player={players.get(slot.playerOneId)} winner={winnerState(slot, slot.playerOneId, official)}
        seriesWins={winsFor(slot, slot.playerOneId)} showSeries={showSeries} onOpen={onOpenPlayer} />
      <PlayerIdentity player={players.get(slot.playerTwoId)} winner={winnerState(slot, slot.playerTwoId, official)}
        seriesWins={winsFor(slot, slot.playerTwoId)} showSeries={showSeries} onOpen={onOpenPlayer} />
    </div>
    {slot.games.length > 0 && <GameBreakdown slot={slot} compact />}
  </section>;
}

export function SpectatorFinals({ card, onOpenPlayer }: {
  card: TournamentCard;
  onOpenPlayer?: (player: Player) => void;
}) {
  const state = finalsState(card);
  const players = new Map(card.players.map((player) => [player.id, player]));
  const slots = card.finalRound?.slots.slice().sort((a, b) => a.slot - b.slot) ?? [];
  const championship = slots.find((slot) => slot.slot === 0);
  const placements = slots.filter((slot) => slot.slot !== 0);

  return <section className="spectator-finals" aria-labelledby="spectator-finals-title">
    <header className="spectator-finals__header">
      <div className="spectator-finals__heading">
        <Trophy size={21} aria-hidden="true" />
        <div>{card.division && <p>{card.division}</p>}<h2 id="spectator-finals-title">รอบชิงชนะเลิศ</h2></div>
      </div>
      <span className={`spectator-finals__state spectator-finals__state--${state}`}>{stateLabel[state]}</span>
    </header>

    {slots.length === 0 ? <div className="spectator-finals__empty">
      <strong>ยังไม่เริ่มรอบชิง</strong><span>รายชื่อผู้เล่นจะแสดงเมื่อจัดคู่รอบชิงแล้ว</span>
    </div> : <div className="spectator-finals__matches">
      {championship && <Championship slot={championship} players={players} official={state === "official"} onOpenPlayer={onOpenPlayer} />}
      {placements.map((slot) => <ThirdPlace key={slot.slot} slot={slot} players={players} official={state === "official"} onOpenPlayer={onOpenPlayer} />)}
    </div>}
  </section>;
}
