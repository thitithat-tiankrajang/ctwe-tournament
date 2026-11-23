"use client";

import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronRight, ClipboardCheck, FileDown, Flag, Gamepad2, LockKeyhole, TableProperties, Trophy, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { StageTimeline, stageShort, stageSteps } from "@/ui/components/stage-timeline";
import { useRouter } from "next/navigation";
import { useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { rankingAfterGame } from "@/domain/tournament/history";
import { isRecordedPairing, isVoidPairing } from "@/domain/tournament/pairing-slot";
import type { Player, TournamentCard } from "@/domain/tournament/types";
import { stageLabels } from "@/ui/components/stage-info";

function OverviewLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: string }) {
  return <Link prefetch={false} href={href} className={`btn btn--${variant}`}>{children}<ArrowRight className="i" size={15} /></Link>;
}

const displayName = (player: Player) => `${player.firstName} ${player.lastName}`;
const gameLink = (cardId: string) => `/cards/${cardId}/games`;

export function OperatorRoundSummary({ card, role, nextHref, finalBoard, documents, closeCard, openPlayer }: {
  card: TournamentCard;
  role: "director" | "staff";
  nextHref: string;
  finalBoard?: ReactNode;
  documents?: ReactNode;
  closeCard?: () => void;
  openPlayer: (player: Player) => void;
}) {
  const router = useRouter();
  const reviewResults = useTournamentStore((state) => state.reviewResults);
  const [reviewing, setReviewing] = useState(false);
  const director = role === "director";
  const collecting = card.runtimeStage === "RESULT_COLLECTION";
  const currentBlock = collecting ? card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.includes(card.currentGame)) : undefined;
  const active = currentBlock?.pairings.filter((pair) =>
    (pair.gameNumber ?? card.currentGame) === card.currentGame && !isVoidPairing(pair) && Boolean(pair.playerOneId || pair.playerTwoId)) ?? [];
  const awaiting = active.filter((pair) => !isRecordedPairing(pair)).sort((a, b) => a.tableNumber - b.tableNumber);
  const finished = card.status === "FINISHED" || card.status === "CLOSED" || card.runtimeStage === "FINAL_PUBLISHED";
  const published = card.snapshots.filter((item) => item.confirmedAt);
  const latest = Math.max(0, ...published.flatMap((item) => item.gameNumbers));
  const latestSnapshot = published.find((item) => item.gameNumbers.includes(latest));
  const ranked = latest ? rankingAfterGame({ ...card, snapshots: published }, latest) : [];
  const names = new Map(card.players.map((player) => [player.id, player]));
  const progress = active.length - awaiting.length;
  const games = gameLink(card.id);
  const players = `/cards/${card.id}/players`;

  const startReview = async () => {
    setReviewing(true);
    try {
      await reviewResults(card.id);
      router.push(games);
    } catch (error) {
      await appDialog.alert(error instanceof Error ? error.message : "เปิดหน้าตรวจผลไม่สำเร็จ", "เปิดหน้าตรวจผลไม่สำเร็จ", true);
    } finally {
      setReviewing(false);
    }
  };

  let task = { title: "รอบชิงชนะเลิศ", icon: Trophy, body: "", action: <OverviewLink href={games}>{director ? "จัดการรอบชิง" : "ดูผลรอบชิง"}</OverviewLink> as ReactNode };
  if (finished) task = { title: card.status === "CLOSED" ? "ปิดการแข่งขันแล้ว" : "การแข่งขันจบแล้ว", body: "", icon: Flag, action: null };
  else if (collecting) {
    const reviewReady = director && active.length > 0 && !awaiting.length && Boolean(currentBlock?.pairings.every((pair) => isVoidPairing(pair) || isRecordedPairing(pair)));
    task = { title: `${director ? "ติดตามผลเกม" : "กรอกผลเกม"} ${card.currentGame}`, icon: Gamepad2, body: `จากทั้งหมด ${card.games.length} เกม`,
      action: reviewReady ? <button type="button" className="btn btn--success" disabled={reviewing} onClick={() => void startReview()}>ตรวจผลเกม {card.currentGame}<ArrowRight className="i" size={15} /></button>
        : <OverviewLink href={games} variant={awaiting.length ? "primary" : "secondary"}>{awaiting.length ? "ไปหน้ากรอกผล" : "ดูผลที่บันทึก"}</OverviewLink> };
  } else if (card.runtimeStage === "PLAYER_REGISTRATION") {
    task = { title: "ลงทะเบียนผู้เล่น", icon: Users, body: `ลงทะเบียนแล้ว ${card.players.length} คน`,
      action: director ? <OverviewLink href={players}>เปิดทะเบียนผู้เล่น</OverviewLink> : null };
  } else if (card.runtimeStage === "TABLE_PAIRING" || card.runtimeStage === "PAIRING_PREVIEW") {
    task = { title: director ? stageLabels[card.runtimeStage] : "รอประกาศคู่แข่งขัน", icon: TableProperties,
      body: `เกม ${card.currentGame} จาก ${card.games.length}`,
      action: director ? <OverviewLink href={nextHref}>{card.runtimeStage === "PAIRING_PREVIEW" ? "ตรวจคู่แข่งขัน" : "ไปหน้าสร้างคู่"}</OverviewLink> : null };
  } else if (card.runtimeStage === "RESULT_REVIEW") {
    task = { title: director ? "ตรวจและเผยแพร่ผล" : "รอผู้อำนวยการตรวจผล", icon: ClipboardCheck, body: `เกม ${card.currentGame} จาก ${card.games.length}`,
      action: <OverviewLink href={games} variant="secondary">{director ? "ไปหน้าตรวจผล" : "ดูผลที่บันทึก"}</OverviewLink> };
  }

  const participant = (id: string | null) => {
    const player = id ? names.get(id) : undefined;
    return player ? <span className="overview-queue-player" title={displayName(player)}><span className="code">{id}</span><span>{displayName(player)}</span></span> : <span className="meta">บาย</span>;
  };

  return <div className={`operator-overview overview--${role}`}>
    <h1 className="sr">ภาพรวมการแข่งขัน</h1>
    <section className="overview-task" aria-label="งานปัจจุบัน">
      <div className="overview-task-main"><span className="overview-task-icon" aria-hidden><task.icon className="i" size={21} /></span>
        <div className="overview-task-copy"><h2>{task.title}</h2>{task.body && <p>{task.body}</p>}</div>{task.action}
      </div>
      <StageTimeline steps={stageSteps(card, active.length ? `${stageShort[card.runtimeStage] ?? ""} ${progress}/${active.length}` : stageShort[card.runtimeStage] ?? "")} />
      {active.length > 0 && <div className="overview-progress">
        <progress value={progress} max={active.length} aria-label="คู่ที่บันทึกผลแล้ว" />
        <span><strong>{progress}/{active.length}</strong> บันทึกแล้ว</span>
        <span className="overview-progress-rest">{awaiting.length ? `รอผล ${awaiting.length} คู่` : "ครบทุกคู่"}</span>
      </div>}
    </section>
    {finalBoard}
    <div className={`overview-panels${director || collecting ? " overview-panels--split" : ""}`}>
      {director ? <aside className="overview-aside">
        <section className="panel overview-round" aria-labelledby="overview-round-title">
          <header className="overview-panel-head"><div><h2 id="overview-round-title">สถานะรุ่นแข่งขัน</h2></div></header>
          <dl className="overview-facts">
            <div><dt>เผยแพร่ล่าสุด</dt><dd>{latest ? <>เกม {latest} {latestSnapshot?.confirmedAt && <small>{new Date(latestSnapshot.confirmedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })} น.</small>}</> : "รอผลเกมแรก"}</dd></div>
            <div><dt>ลงทะเบียน</dt><dd>{card.players.length} คน</dd></div>
            <div><dt>คัดชั่วคราว</dt><dd>{card.screeningPool?.length ?? 0} คน</dd></div>
            <div><dt>ถอนผู้เล่น</dt><dd>{card.players.filter((player) => player.terminated).length} คน</dd></div>
          </dl>
          <div className="overview-panel-foot"><OverviewLink href={players} variant="secondary">ดูทะเบียนผู้เล่น</OverviewLink></div>
        </section>
        {(documents || closeCard) && <details className="panel overview-tools">
          <summary><FileDown className="i" size={16} />เอกสารและการจัดการรุ่น<ChevronDown className="i overview-tool-chevron" size={15} /></summary>
          <div className="overview-tools-body">{documents}
            {closeCard && <div><button type="button" className="btn btn--danger" onClick={closeCard}><LockKeyhole className="i" size={15} />ปิดการ์ดถาวร</button></div>}
          </div>
        </details>}
      </aside> : collecting && <section className="panel overview-pending" aria-labelledby="overview-pending-title">
        <header className="overview-panel-head"><div><h2 id="overview-pending-title">คู่ที่รอบันทึก</h2><span className="meta">เกม {card.currentGame} · {awaiting.length} คู่</span></div></header>
        {awaiting.length ? <><ul className="overview-queue">{awaiting.slice(0, 5).map((pair) => <li key={pair.id}>
          <button type="button" aria-label={`ไปกรอกผลคู่ ${pair.tableNumber}`} onClick={() => router.push(`${games}#entry-${pair.id}`)}>
            <b className="overview-pair-no">คู่ {pair.tableNumber}</b><span className="overview-opponents">{participant(pair.playerOneId)}{participant(pair.playerTwoId)}</span><ChevronRight className="i" size={15} />
          </button></li>)}</ul>
          {awaiting.length > 5 && <div className="overview-panel-foot"><OverviewLink href={games} variant="secondary">ดูคู่ที่รอผลทั้งหมด</OverviewLink></div>}
        </> : <p className="overview-empty">{active.length ? "บันทึกครบแล้ว รอผู้อำนวยการตรวจผล" : "ยังไม่มีคู่ที่เปิดให้บันทึก"}</p>}
      </section>}
      <section className="panel overview-ranking" aria-labelledby="overview-rank-title">
        <header className="overview-panel-head"><div><h2 id="overview-rank-title">อันดับที่เผยแพร่</h2>{latest > 0 && <span className="meta">หลังเกม {latest}</span>}</div></header>
        {ranked.length ? <table className="overview-rank-table" aria-label="อันดับที่เผยแพร่"><colgroup>
          <col className="rank-index" /><col className="rank-player" /><col className="rank-score" /><col className="rank-diff" /><col className="rank-record" /><col className="rank-school" />
        </colgroup><thead><tr><th scope="col" className="rank-index">อันดับ</th><th scope="col">ผู้เล่น</th><th scope="col" className="rank-score">คะแนนชนะ</th>
          <th scope="col" className="rank-diff">ผลต่างสะสม</th><th scope="col" className="rank-record">ชนะ / เสมอ / แพ้</th><th scope="col" className="rank-school">โรงเรียน/สถาบัน</th></tr></thead>
          <tbody>{ranked.map((player) => <tr key={player.id}>
            <th scope="row" className="rank-index"><span>{player.displayRank}</span></th>
            <td className="rank-person"><button className="overview-player" type="button" title={`${displayName(player)} · ${player.school}`} onClick={() => openPlayer(player)}>
              <span className="code">{player.id}</span><strong>{displayName(player)}</strong></button>
              <small className="rank-school-inline" title={player.school}>{player.school}</small></td>
            <td className="rank-score">{player.winPoints}</td>
            <td className="rank-diff" data-negative={player.diff < 0 || undefined}>{player.diff > 0 ? "+" : ""}{player.diff}</td>
            <td className="rank-record">{player.wins} / {player.draws} / {player.losses}</td><td className="rank-school" title={player.school}>{player.school}</td>
          </tr>)}</tbody></table> : <p className="overview-empty">{latest ? "ยังไม่มีผู้เล่นในตารางอันดับ" : "อันดับจะขึ้นหลังเผยแพร่ผลเกมแรก"}</p>}
      </section>
    </div>
  </div>;
}
