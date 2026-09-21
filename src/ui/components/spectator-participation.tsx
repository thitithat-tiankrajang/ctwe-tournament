"use client";

import { ArrowLeft, Camera, ChevronRight, Hourglass, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SpectatorDivision } from "@/application/tournament/spectator-read-model";
import { spectatorPlayerView, type SpectatorPlayerGame, type SpectatorPlayerView } from "@/application/tournament/spectator-player";
import type { PublicDivisionPayload } from "@/application/tournament/spectator-read-model";
import { Badge, type BadgeTone } from "@/ui/components/badge";
import { EmptyState } from "@/ui/components/page";
import {
  beginSpectatorCapture,
  endSpectatorCapture,
  spectatorCapturePresentation,
  type SpectatorCaptureAttempt,
  type SpectatorOrientation,
} from "@/ui/components/spectator-capture";
import { SpectatorMemoryCard } from "@/ui/components/spectator-memory-card";
import { SpectatorHistoryRows } from "@/ui/components/spectator-report-lists";

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

/** The authoritative completed record on the normal Player page. */
export function CompletedPlayerHero({ eventName, contextLabel, view }: {
  eventName: string;
  contextLabel?: string;
  view: SpectatorPlayerView;
}) {
  const record = view.completedRecord;
  if (!record) return null;
  return (
    <section className="spectator-complete"
      aria-label="ผลการแข่งขันอย่างเป็นทางการ" data-completed-record="true">
      <header className="spectator-complete__event">
        <div>
          <p className="spectator-complete__event-name">{eventName}</p>
          <p className="spectator-complete__division">{contextLabel ?? view.divisionLabel}</p>
        </div>
        <span className="spectator-complete__official">ผลการแข่งขันอย่างเป็นทางการ</span>
      </header>
      <div className="spectator-complete__identity">
        <span className="spectator-complete__code">{view.participant.code}</span>
        <div>
          <h1>{view.participant.name}</h1>
          <p>{view.participant.school || "—"}</p>
        </div>
      </div>
      <div className="spectator-complete__achievement">
        <div className="spectator-complete__placing">
          <span>อันดับสุดท้าย</span>
          <strong>#{record.placing}</strong>
        </div>
        <div className="spectator-complete__record">
          <p>{record.statsScope === "qualifying" ? "สถิติรอบคัดเลือก" : "สถิติการแข่งขัน"} · แข่ง {record.gamesPlayed} เกม</p>
          <dl>
            <div><dt>ชนะ</dt><dd>{record.wins}</dd></div>
            <div><dt>เสมอ</dt><dd>{record.draws}</dd></div>
            <div><dt>แพ้</dt><dd>{record.losses}</dd></div>
            <div><dt>ผลต่างสะสม</dt><dd className={record.diff > 0 ? "is-positive" : record.diff < 0 ? "is-negative" : ""}>{signed(record.diff)}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  );
}

/** What the audience is allowed to conclude about this game, in the words the boards use. */
const assignmentState: Record<SpectatorPlayerGame["state"], { label: string; tone: BadgeTone }> = {
  "awaiting-result": { label: "รอผล", tone: "info" },
  recorded: { label: "บันทึกผลแล้ว · ยังไม่รวมอันดับ", tone: "warning" },
  official: { label: "ประกาศผลแล้ว", tone: "success" },
  withdrawn: { label: "ถอนผลแล้ว · รอผลใหม่", tone: "danger" },
  void: { label: "ยกเลิกคู่แข่งขัน", tone: "neutral" },
};

const outcomeLabel: Record<NonNullable<SpectatorPlayerGame["outcome"]>, { label: string; tone: BadgeTone }> = {
  W: { label: "ชนะ", tone: "success" },
  T: { label: "เสมอ", tone: "warning" },
  L: { label: "แพ้", tone: "danger" },
  PENALTY: { label: "ลงดาบ", tone: "danger" },
};

function CurrentGame({ view, onOpenPlayer }: {
  view: SpectatorPlayerView;
  onOpenPlayer?: (divisionId: string, code: string) => void;
}) {
  if (!view.participant.listedInStandings) return null;
  if (view.phase === "finals") return view.final ? null : (
    <section className="spectator-now spectator-now--pending" aria-label="สถานะการแข่งขัน">
      <p className="spectator-now__pending">การแข่งขันอยู่ในรอบชิงชนะเลิศ</p>
      <p className="spectator-now__note">คุณไม่มีคู่แข่งขันรอบชิง</p>
    </section>
  );
  if (view.phase === "complete") return (
    <section className="spectator-now spectator-now--pending" aria-label="สถานะการแข่งขัน">
      <p className="spectator-now__pending">การแข่งขันจบแล้ว</p>
    </section>
  );
  const assignment = view.assignment;
  if (!assignment && view.recordedCurrentGame) return (
    <section className="spectator-now spectator-now--pending" aria-label="รอสถานะเกมถัดไป">
      <p className="spectator-now__pending"><Hourglass size={16} aria-hidden />เกม {view.recordedCurrentGame.game} บันทึกผลแล้ว</p>
      <p className="spectator-now__note">รอประกาศคู่แข่งขันเกม {view.recordedCurrentGame.game + 1}</p>
    </section>
  );
  if (!assignment) return view.awaitingGame || view.phase === "registration" ? (
    <section className="spectator-now spectator-now--pending" aria-label="รอคู่แข่งขัน">
      <p className="spectator-now__pending"><Hourglass size={16} aria-hidden />
        {view.awaitingGame ? `ยังไม่ประกาศคู่แข่งขันเกม ${view.awaitingGame}` : "ยังไม่มีคู่แข่งขันที่ประกาศ"}</p>
    </section>
  ) : null;
  const state = assignmentState[assignment.state];
  const announcedLocation = view.slotLabel === "SEAT"
    ? { label: "ที่นั่ง", value: assignment.seat, secondary: `คู่ที่ ${assignment.pairNumber}` }
    : { label: "คู่ที่", value: assignment.pairNumber, secondary: `ที่นั่ง ${assignment.seat}` };
  return (
    <section className="spectator-now" aria-label="เกมปัจจุบัน" data-slot-label={view.slotLabel}>
      <header className="spectator-now__head">
        <div className="spectator-now__title">
          <span className="spectator-now__eyebrow">เกมปัจจุบัน</span>
          <h2>เกม {assignment.game}</h2>
        </div>
        <span className="spectator-now__status"><Badge tone={state.tone}>{state.label}</Badge></span>
      </header>
      {assignment.bye ? (
        <p className="spectator-now__note">บาย — ไม่มีคู่แข่งขันในเกมนี้</p>
      ) : (
        <>
          <div className={`spectator-seat spectator-location--${view.slotLabel.toLowerCase()}`}>
            <div className="spectator-seat__figure">
              <span className="spectator-seat__label">{announcedLocation.label}</span>
              <strong className="spectator-seat__value">{announcedLocation.value}</strong>
            </div>
            <div className="spectator-seat__pair">
              <span>{announcedLocation.secondary}</span>
              <span>ฝั่งที่ {assignment.side}</span>
            </div>
          </div>
          <div className="spectator-versus">
            <span className="spectator-versus__label">พบกับ</span>
            {assignment.opponent && onOpenPlayer ? (
              <button type="button" className="spectator-versus__link" onClick={() => onOpenPlayer(view.divisionId, assignment.opponent!.code)}>
                <span className="spectator-versus__code">{assignment.opponent.code}</span>
                <span className="spectator-versus__identity">
                  <span className="spectator-versus__name">{assignment.opponent.name}</span>
                  <span className="spectator-versus__school">{assignment.opponent.school || "—"}</span>
                </span>
              </button>
            ) : (
              <>
                <span className="spectator-versus__code">{assignment.opponent?.code ?? "—"}</span>
                <span className="spectator-versus__identity">
                  <span className="spectator-versus__name">{assignment.opponent?.name ?? "ยังไม่ระบุคู่แข่ง"}</span>
                  <span className="spectator-versus__school">{assignment.opponent?.school || "—"}</span>
                </span>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Each published qualifying game has one row, even while the next pairing is already visible. */
function PlayerGameRows({ games, view, onOpenPlayer }: {
  games: SpectatorPlayerGame[];
  view: SpectatorPlayerView;
  onOpenPlayer?: (divisionId: string, code: string) => void;
}) {
  return <ul className="spectator-history">
    {games.map(game => {
      const state = assignmentState[game.state];
      const outcome = game.outcome ? outcomeLabel[game.outcome] : null;
      // Keep the existing official history's differential calculation; W1 only repairs visibility.
      const officialRow = game.state === "official" ? view.history.qualifying.find(row => row.game === game.game) : undefined;
      const diff = officialRow?.diff ?? game.diff;
      return <li key={game.key} className="spectator-history__row" data-game={game.game} data-publication={game.state}>
        <span className="spectator-history__game">เกม {game.game}</span>
        {outcome ? <Badge tone={outcome.tone}>{outcome.label}</Badge> : <span />}
        <span className="spectator-history__score">{game.bye ? "บาย" : game.score ? `${game.score.own} - ${game.score.opponent}` : "—"}</span>
        <span className="spectator-history__diff">{diff !== null ? signed(diff) : "—"}</span>
        {game.state !== "official" && <span className="spectator-history__state"><Badge tone={state.tone}>{state.label}</Badge></span>}
        {game.bye && game.score && <span className="spectator-history__opponent">คะแนนตามกติกา {game.score.own}</span>}
        {!game.bye && game.opponent && (onOpenPlayer ? (
          <button type="button" className="spectator-history__opponent spectator-history__opponent-link" onClick={() => onOpenPlayer(view.divisionId, game.opponent!.code)}>
            {game.opponent.code} · {game.opponent.name}{game.opponent.school ? ` · ${game.opponent.school}` : ""}
          </button>
        ) : (
          <span className="spectator-history__opponent">
            {game.opponent.code} · {game.opponent.name}{game.opponent.school ? ` · ${game.opponent.school}` : ""}
          </span>
        ))}
      </li>;
    })}
  </ul>;
}

/**
 * The Player Participation destination.
 *
 * Order is the spectator's order, not the database's: identity, then the game they have to walk to
 * right now, then the official standing, then the record. Rank sits BELOW the current game on
 * purpose — a spectator standing in a hall needs a seat number before they need a placing.
 */
export function SpectatorParticipation({ card, division, code, tournamentName, onBack, onOpenPlayer, onBrowseDivision }: {
  card: PublicDivisionPayload;
  division: SpectatorDivision;
  code: string;
  tournamentName?: string;
  onBack: () => void;
  onOpenPlayer?: (divisionId: string, code: string) => void;
  onBrowseDivision: () => void;
}) {
  const playerKey = `${division.id}:${code}`;
  const [captureKey, setCaptureKey] = useState<string | null>(null);
  const capture = captureKey === playerKey;
  const captureRoot = useRef<HTMLDivElement>(null);
  const ownsFullscreen = useRef(false);
  const captureSession = useRef(0);
  const [captureAttempt, setCaptureAttempt] = useState<SpectatorCaptureAttempt | null>(null);
  const [capturePresentation, setCapturePresentation] = useState<"record" | "rotate">("rotate");
  useEffect(() => {
    if (!capture) return;
    const orientation = window.screen?.orientation as (ScreenOrientation & SpectatorOrientation) | undefined;
    const syncPresentation = () => setCapturePresentation(
      spectatorCapturePresentation(window.innerWidth, window.innerHeight),
    );
    const leave = () => {
      captureSession.current += 1;
      ownsFullscreen.current = false;
      try { orientation?.unlock?.(); } catch { /* Locking is optional browser chrome. */ }
      setCaptureKey(null);
      setCaptureAttempt(null);
    };
    const fullscreenChanged = () => {
      if (document.fullscreenElement === captureRoot.current) {
        ownsFullscreen.current = true;
        return;
      }
      if (ownsFullscreen.current && !document.fullscreenElement) leave();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") leave();
    };
    syncPresentation();
    document.addEventListener("fullscreenchange", fullscreenChanged);
    window.addEventListener("keydown", keydown);
    window.addEventListener("resize", syncPresentation);
    orientation?.addEventListener?.("change", syncPresentation);
    return () => {
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", syncPresentation);
      orientation?.removeEventListener?.("change", syncPresentation);
    };
  }, [capture]);
  const view = spectatorPlayerView(card, division, code);
  if (!view) return (
    <>
      <button type="button" className="tour-card-back" onClick={onBack}>
        <ArrowLeft size={18} aria-hidden="true" /><span className="tour-card-back__text">กลับไปค้นหา</span>
      </button>
      <div className="panel">
        <EmptyState icon={<Hourglass size={25} />} title={`ไม่พบนักกีฬารหัส ${code}`}
          description="รายชื่ออาจถูกปรับปรุงหลังจากเปิดหน้านี้ — ค้นหาอีกครั้งเพื่อดูข้อมูลล่าสุด" />
      </div>
    </>
  );
  const participant = view.participant;
  const byCode = new Map(division.participants.map((item) => [item.code, item]));
  const opponentName = (id: string) => byCode.get(id)?.name ?? id;
  const opponentSchool = (id: string) => byCode.get(id)?.school ?? "";
  const totals = view.history.qualifyingTotals;
  const pendingGames = view.ledger.filter(game => game.state !== "official" && game.key !== view.assignment?.key);
  const officialGames = view.ledger.filter(game => game.state === "official");

  if (view.completedRecord) {
    const completedGames = view.ledger.filter(game => game.state === "official" || game.state === "void");
    const eventName = tournamentName?.trim() || card.name;
    const contextLabel = card.name === eventName ? view.divisionLabel : `${card.name} · ${view.divisionLabel}`;
    const enterCapture = async () => {
      const session = captureSession.current + 1;
      captureSession.current = session;
      flushSync(() => {
        setCaptureAttempt(null);
        setCapturePresentation(spectatorCapturePresentation(window.innerWidth, window.innerHeight));
        setCaptureKey(playerKey);
      });
      const root = captureRoot.current;
      if (!root) return;
      const orientation = (window.screen?.orientation ?? {}) as SpectatorOrientation;
      const attempt = await beginSpectatorCapture(root, orientation);
      if (captureSession.current !== session) return;
      ownsFullscreen.current = attempt.fullscreen === "succeeded";
      setCaptureAttempt(attempt);
      setCapturePresentation(spectatorCapturePresentation(window.innerWidth, window.innerHeight));
    };
    const exitCapture = async () => {
      captureSession.current += 1;
      ownsFullscreen.current = false;
      const orientation = (window.screen?.orientation ?? {}) as SpectatorOrientation;
      await endSpectatorCapture(document, orientation);
      setCaptureKey(null);
      setCaptureAttempt(null);
    };

    if (capture) return (
      <div ref={captureRoot}
        className={`spectator-player--capture spectator-player--capture-${capturePresentation}`}
        data-capture-fullscreen={captureAttempt?.fullscreen ?? "pending"}
        data-capture-orientation={captureAttempt?.orientation ?? "pending"}>
        {capturePresentation === "record" ? (
          <div className="spectator-memory-stage">
            <SpectatorMemoryCard tournamentName={eventName} competitionName={card.name} view={view} />
          </div>
        ) : (
          <section className="spectator-memory-fallback" aria-live="polite" aria-label="หมุนโทรศัพท์เพื่อบันทึกภาพ">
            <div className="spectator-memory-fallback__brand"><strong>CTWE</strong><span>PLAYER RECORD</span></div>
            <RotateCcw size={42} strokeWidth={1.8} aria-hidden="true" />
            <p className="spectator-memory-fallback__eyebrow">พร้อมบันทึกผลงานของคุณ</p>
            <h2>หมุนโทรศัพท์เป็นแนวนอน</h2>
            <p>บัตรผลงานจะแสดงเต็มหน้าจอทันทีเมื่ออุปกรณ์อยู่ในแนวนอน</p>
          </section>
        )}
        <button type="button" className="spectator-memory-exit" onClick={() => void exitCapture()} aria-label="ออกจากบันทึกภาพ">
          <X size={19} aria-hidden="true" /><span>กลับ</span>
        </button>
      </div>
    );

    return (
      <div className="spectator-player spectator-player--complete">
        <button type="button" className="tour-card-back" onClick={onBack} aria-label="กลับไปหน้าก่อนหน้า">
          <ArrowLeft size={18} aria-hidden="true" /><span className="tour-card-back__text">กลับไปหน้าก่อนหน้า</span>
        </button>

        <CompletedPlayerHero eventName={eventName} contextLabel={contextLabel} view={view} />

        <button type="button" className="spectator-capture-toggle" onClick={() => void enterCapture()}>
          <Camera size={17} aria-hidden="true" />บันทึกภาพ
        </button>

        <>
          {view.final && (
            <section className="spectator-final" aria-label="รอบชิงชนะเลิศ">
              <h2>{view.final.label}</h2>
              <p className="spectator-final__versus">
                พบกับ {view.final.opponent && onOpenPlayer ? (
                  <button type="button" className="spectator-final__opponent-link" onClick={() => onOpenPlayer(view.divisionId, view.final!.opponent!.code)}>
                    {view.final.opponent.code} · {view.final.opponent.name}{view.final.opponent.school ? ` · ${view.final.opponent.school}` : ""}
                  </button>
                ) : view.final.opponent ? `${view.final.opponent.code} · ${view.final.opponent.name}` : "ยังไม่ระบุ"}
              </p>
              {view.history.final.length > 0 && <SpectatorHistoryRows rows={view.history.final}
                opponentName={opponentName} opponentSchool={opponentSchool}
                onOpenPlayer={onOpenPlayer ? (opponentCode) => onOpenPlayer(view.divisionId, opponentCode) : undefined} />}
            </section>
          )}

          <section className="spectator-record spectator-record--completed" aria-label="ประวัติการแข่งขันอย่างเป็นทางการ">
            <h2>ประวัติการแข่งขัน</h2>
            {completedGames.length === 0 ? (
              <p className="spectator-standing__none">ไม่มีเกมในประวัติการแข่งขัน</p>
            ) : (
              <>
                <PlayerGameRows games={completedGames} view={view} onOpenPlayer={onOpenPlayer} />
                <p className="spectator-record__totals">คะแนนสะสม {totals.winPoints} · ผลต่างสะสม {signed(totals.diff)}</p>
              </>
            )}
          </section>

          <button type="button" className="spectator-browse-link" onClick={onBrowseDivision}>
            ดูรายงานทั้งรุ่น {view.divisionLabel}<ChevronRight size={17} aria-hidden />
          </button>
        </>
      </div>
    );
  }

  return (
    <>
      <button type="button" className="tour-card-back" onClick={onBack} aria-label="กลับไปค้นหานักกีฬา">
        <ArrowLeft size={18} aria-hidden="true" /><span className="tour-card-back__text">กลับไปค้นหา</span>
      </button>

      <section className="spectator-identity" aria-label="ข้อมูลนักกีฬา">
        <div className="spectator-identity__primary">
          <span className="spectator-identity__code">{participant.code}</span>
          <div className="spectator-identity__details">
            <h1 className="spectator-identity__name">{participant.name}</h1>
            <div className="spectator-identity__meta-line">
              <p className="spectator-identity__meta">{participant.school || "—"}</p>
              <span className="spectator-identity__separator" aria-hidden="true">·</span>
              <p className="spectator-identity__division">{view.divisionLabel}</p>
            </div>
          </div>
        </div>
        {!participant.listedInStandings && <p className="spectator-identity__flag"><Badge tone="danger">ถอนตัว</Badge> ไม่อยู่ในตารางอันดับ</p>}
      </section>

      <CurrentGame view={view} onOpenPlayer={onOpenPlayer} />

      {view.final && (
        <section className="spectator-final" aria-label="รอบชิงชนะเลิศ">
          <h2>{view.final.label}</h2>
          <p className="spectator-final__versus">
            พบกับ {view.final.opponent && onOpenPlayer ? (
              <button type="button" className="spectator-final__opponent-link" onClick={() => onOpenPlayer(view.divisionId, view.final!.opponent!.code)}>
                {view.final.opponent.code} · {view.final.opponent.name}{view.final.opponent.school ? ` · ${view.final.opponent.school}` : ""}
              </button>
            ) : view.final.opponent ? `${view.final.opponent.code} · ${view.final.opponent.name}` : "ยังไม่ระบุ"}
            {view.final.opponent && !onOpenPlayer && view.final.opponent.school ? ` · ${view.final.opponent.school}` : ""}
          </p>
          <p className="spectator-final__note">
            {view.final.decided ? (view.final.won ? "ชนะคู่ชิง" : "แพ้คู่ชิง") : "รอผลรอบชิง"}
            {view.final.decided && !view.final.official ? " · รอประกาศผลรอบชิง" : ""}
            {view.phase === "finals" && participant.listedInStandings ? " · สถานที่แข่งขันรอบชิงกำหนดโดยผู้จัดการแข่งขัน" : ""}
          </p>
          {view.history.final.length > 0 && <>
            <p className="spectator-final__note">{view.final.official ? "ประกาศผลแล้ว" : "ผลยังไม่ทางการ"} · นับแยกจากรอบคัดเลือก</p>
            <SpectatorHistoryRows rows={view.history.final} opponentName={opponentName} opponentSchool={opponentSchool}
              onOpenPlayer={onOpenPlayer ? (opponentCode) => onOpenPlayer(view.divisionId, opponentCode) : undefined} />
          </>}
        </section>
      )}

      {pendingGames.length > 0 && <section className="spectator-record" aria-label="ผลและสถานะเกมที่ยังไม่เป็นทางการ">
        <h2>ผลและสถานะเกม</h2>
        <PlayerGameRows games={pendingGames} view={view} onOpenPlayer={onOpenPlayer} />
      </section>}

      <section className="spectator-standing" aria-label={view.standing?.isFinal ? "อันดับสุดท้าย" : "อันดับอย่างเป็นทางการ"}>
        <h2>{view.standing?.isFinal ? "อันดับสุดท้าย" : "อันดับอย่างเป็นทางการ"}</h2>
        {view.standing ? (
          <>
            <p className="spectator-standing__rank">
              <strong>#{view.standing.rank}</strong>
              <span className="spectator-standing__cutoff">{view.standing.isFinal ? `สถิติรอบคัดเลือก · หลังจบเกม ${view.standing.throughGame}` : `หลังจบเกม ${view.standing.throughGame}`}</span>
            </p>
            <dl className="spectator-standing__figures">
              <div><dt>ชนะ</dt><dd>{view.standing.wins}</dd></div>
              <div><dt>เสมอ</dt><dd>{view.standing.draws}</dd></div>
              <div><dt>แพ้</dt><dd>{view.standing.losses}</dd></div>
              <div><dt>ผลต่างสะสม</dt><dd className={view.standing.diff > 0 ? "is-positive" : view.standing.diff < 0 ? "is-negative" : ""}>{signed(view.standing.diff)}</dd></div>
            </dl>
          </>
        ) : (
          <p className="spectator-standing__none">
            {!participant.listedInStandings ? "นักกีฬารายนี้ถอนตัวแล้ว จึงไม่ปรากฏในตารางอันดับ"
              : view.officialThroughGame === null ? "ยังไม่มีการประกาศอันดับอย่างเป็นทางการ"
              : "ยังไม่มีอันดับของนักกีฬารายนี้"}
          </p>
        )}
      </section>

      <section className="spectator-record" aria-label="ประวัติการแข่งขัน">
        <h2>ผลที่ประกาศแล้ว{view.officialThroughGame !== null ? ` · ถึงเกม ${view.officialThroughGame}` : ""}</h2>
        {officialGames.length === 0 ? (
          <p className="spectator-standing__none">ยังไม่มีผลการแข่งขันที่ประกาศแล้ว</p>
        ) : (
          <>
            <PlayerGameRows games={officialGames} view={view} onOpenPlayer={onOpenPlayer} />
            <p className="spectator-record__totals">คะแนนสะสม {totals.winPoints} · ผลต่างสะสม {signed(totals.diff)}</p>
          </>
        )}
      </section>

      <button type="button" className="spectator-browse-link" onClick={onBrowseDivision}>
        ดูรายงานทั้งรุ่น {view.divisionLabel}<ChevronRight size={17} aria-hidden />
      </button>
    </>
  );
}
