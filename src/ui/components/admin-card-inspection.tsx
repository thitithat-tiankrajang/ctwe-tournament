"use client";

import { useEffect, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import { createTournamentLookup, tournamentStateFor, type TournamentLookupResult } from "@/application/tournament/tournament-lookup";
import {
  canInspectCard, inspectCard, inspectionFinalTypeLabels, inspectionGameStatusLabels, inspectionRuleLabels,
  type InspectionGame, type InspectionState, type PairingState, type TournamentInspection,
} from "@/domain/tournament/card-inspection";
import { Badge, type BadgeTone } from "./badge";
import { ChevronDown } from "lucide-react";

/**
 * ADMIN-only, read-only inspection of a card's status and configuration.
 *
 * Rendered from the authenticated `/cards/[id]` route page ONLY — never from `CardOverview`, which
 * the public `/tour/[token]` viewer shares. It holds no buttons, no forms and calls no mutation; the
 * one request it may issue is the existing `GET /api/tournaments` to learn OPEN/CLOSED.
 */
export function AdminCardInspection({ cardId }: { cardId: string }) {
  const auth = useTournamentStore((state) => state.auth);
  const card = useTournamentStore((state) => selectCard(state.cards, cardId));
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const admin = canInspectCard(auth);
  const tournamentId = card?.tournamentId;
  // The settled result is tagged with the tournament it was requested for, so an earlier failure (or
  // success) for another tournament reads as "loading" here instead of leaking into this card.
  const [settled, setSettled] = useState<TournamentLookupResult | null>(null);

  useEffect(() => {
    if (!admin || !tournamentId) return;
    const lookup = createTournamentLookup(loadTournaments, setSettled);
    void lookup.request(tournamentId);
    return () => lookup.cancel();
  }, [admin, tournamentId, loadTournaments]);

  if (!admin) return null;
  const tournament = tournamentStateFor(settled, tournamentId);
  return <AdminCardInspectionView state={inspectCard(card)} tournament={tournament} />;
}

const pairingStateLabel: Record<PairingState, { label: string; tone: BadgeTone }> = {
  none: { label: "ยังไม่มีการจับคู่", tone: "neutral" },
  draft: { label: "ร่าง · ยังไม่เผยแพร่", tone: "warning" },
  partial: { label: "เผยแพร่บางส่วน", tone: "warning" },
  published: { label: "เผยแพร่การจับคู่แล้ว", tone: "info" },
  confirmed: { label: "ยืนยันผลแล้ว", tone: "success" },
};

const UNKNOWN = "ไม่มีข้อมูล";

function ruleText(game: InspectionGame) {
  if (!game.rule) return "ยังไม่กำหนด";
  return game.ruleSource === "initial" ? `${inspectionRuleLabels[game.rule]} (เกมแรก)` : inspectionRuleLabels[game.rule];
}

function tournamentText(tournament: TournamentInspection) {
  if (tournament.kind === "loading") return <span className="meta">กำลังโหลด…</span>;
  if (tournament.kind === "error") return <span className="meta">โหลดข้อมูลรายการแข่งขันไม่สำเร็จ</span>;
  if (tournament.kind === "unavailable") return <span className="meta">{UNKNOWN}</span>;
  return <>{tournament.name} <Badge tone={tournament.status === "OPEN" ? "success" : "neutral"}>{tournament.status === "OPEN" ? "เปิด (OPEN)" : "ปิด (CLOSED)"}</Badge></>;
}

const score = (value: number | null) => (value === null ? "—" : String(value));

export function AdminCardInspectionView({ state, tournament }: { state: InspectionState; tournament: TournamentInspection }) {
  const title = "ตรวจสอบการตั้งค่า (ผู้ดูแลระบบ)";
  const description = "อ่านอย่างเดียว — ไม่สามารถแก้ไขจากส่วนนี้";
  const head = <summary className="panel-head"><h2>{title}</h2><span className="desc">{description}</span>
    <ChevronDown className="i overview-tool-chevron" size={16} aria-hidden /></summary>;
  if (state.kind !== "ready") {
    return (
      <details className="panel overview-tools admin-inspection">
        {head}
        <p className="meta panel-body" data-inspection-state={state.kind}>
          {state.kind === "missing" ? "ไม่พบข้อมูลการ์ดนี้" : "กำลังโหลดข้อมูลการ์ดฉบับเต็ม…"}
        </p>
      </details>
    );
  }
  const card = state.inspection;
  return (
    <details className="panel overview-tools admin-inspection">
      {head}
      <div className="admin-inspection__body" data-inspection-state="ready">
        <table className="dt dt--kv" aria-label="สถานะและการตั้งค่าการ์ด">
          <tbody>
            <tr><th scope="row">รายการแข่งขัน</th><td>{tournamentText(tournament)}</td></tr>
            <tr><th scope="row">การ์ด / รุ่น</th><td>{card.name} · {card.division}</td></tr>
            <tr><th scope="row">สถานะการ์ด</th><td>{card.status}</td></tr>
            <tr><th scope="row">ขั้นตอนปัจจุบัน</th><td>{card.runtimeStage}</td></tr>
            <tr><th scope="row">เกมปัจจุบัน / ทั้งหมด</th><td>{card.currentGame} / {card.totalGames}</td></tr>
            <tr><th scope="row">กติกาจับคู่เกมแรก</th><td>{card.initialPairingRule ? inspectionRuleLabels[card.initialPairingRule] : "ยังไม่กำหนด"}</td></tr>
            <tr><th scope="row">รอบชิงชนะเลิศ</th><td>{inspectionFinalTypeLabels[card.finalType]}{card.finalGames !== null ? ` · ${card.finalGames} เกม` : ""}{card.finalSlotCount !== null ? ` · ตัดสินแล้ว ${card.finalDecidedCount}/${card.finalSlotCount} คู่` : ""}</td></tr>
            <tr><th scope="row">Gibson</th><td>{card.gibsonEnabled ? "เปิด" : "ปิด"}</td></tr>
            <tr><th scope="row">การแสดงตำแหน่ง</th><td>{card.slotLabel === "SEAT" ? "ที่นั่ง" : card.slotLabel === "PAIR" ? "คู่ที่" : UNKNOWN}</td></tr>
          </tbody>
        </table>
        {card.games.length === 0 ? <p className="meta">{UNKNOWN}</p> : (
          <table className="dt" aria-label="การตั้งค่าแต่ละเกม">
            <thead>
              <tr>
                <th scope="col" className="n">เกม</th>
                <th scope="col">สถานะเกม</th>
                <th scope="col">กติกาจับคู่</th>
                <th scope="col" className="n">Max Diff</th>
                <th scope="col">การจับคู่</th>
                <th scope="col" className="n">คู่</th>
                <th scope="col" className="n">เผยแพร่</th>
                <th scope="col" className="n">มีผล</th>
              </tr>
            </thead>
            <tbody>
              {card.games.map((game) => (
                <tr key={game.number} data-game={game.number}>
                  <td className="n">{game.number}</td>
                  <td>{inspectionGameStatusLabels[game.status] ?? game.status}</td>
                  <td>{ruleText(game)}</td>
                  <td className="n" data-max-diff>{game.maxDiff ?? UNKNOWN}</td>
                  <td><Badge tone={pairingStateLabel[game.pairingState].tone}>{pairingStateLabel[game.pairingState].label}</Badge></td>
                  <td className="n">{game.tableCount}</td>
                  <td className="n">{game.publishedCount}</td>
                  <td className="n">{game.resultCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {card.games.filter((game) => game.pairings.length > 0).map((game) => (
        <details className="admin-inspection__game" key={game.number}>
          <summary>รายละเอียดการจับคู่ เกม {game.number} ({game.tableCount} คู่){game.pairingSource === "seating" ? " · ร่างจากการจัดโต๊ะ ยังไม่ยืนยัน" : ""}</summary>
          <table className="dt" aria-label={`การจับคู่ เกม ${game.number}`}>
            <thead>
              <tr>
                <th scope="col" className="n">คู่ที่</th>
                <th scope="col">ผู้เล่น 1</th>
                <th scope="col">ผู้เล่น 2</th>
                <th scope="col" className="n">คะแนน</th>
                <th scope="col">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {game.pairings.map((row) => (
                <tr key={row.table}>
                  <td className="n">{row.table}</td>
                  <td>{row.playerOne ?? "—"}</td>
                  <td>{row.playerTwo ?? (row.bye ? "บาย" : "—")}</td>
                  <td className="n">{score(row.scoreOne)} : {score(row.scoreTwo)}</td>
                  <td>{row.voided ? "ยกเลิกโต๊ะ" : row.published ? "เผยแพร่แล้ว" : "ยังไม่เผยแพร่"}{row.bye ? " · บาย" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
      </div>
    </details>
  );
}
