"use client";

import Link from "next/link";
import { Check, LockKeyhole } from "lucide-react";
import type { PairingRuleType, TournamentCard } from "@/domain/tournament/types";

const ruleLabels: Record<PairingRuleType, string> = {
  RANDOM: "Random",
  PAIR_RESULT: "แพ้เจอแพ้ / ชนะเจอชนะ",
  SWISS: "Swiss",
  KING_OF_THE_HILL: "King of the Hill",
};

export function pairingRuleForGame(card: TournamentCard, gameNumber: number) {
  if (gameNumber === 1) return "Random / Initial";
  const rule = card.rules.find((item) => item.toGame === gameNumber);
  return rule ? ruleLabels[rule.type] : "ยังไม่กำหนด";
}

export function GameFlow({
  card,
  selectedGame,
  onSelect,
  linkTo,
  mode = "pairing",
}: {
  card: TournamentCard;
  selectedGame?: number;
  onSelect?: (gameNumber: number) => void;
  linkTo?: "tables" | "games";
  mode?: "pairing" | "results" | "ranking" | "overview";
}) {
  const ariaLabel = mode === "pairing" ? "Pairing แต่ละเกม" : mode === "results" ? "ผลการแข่งขันแต่ละเกม" : mode === "ranking" ? "อันดับหลังแต่ละเกม" : "ข้อมูลการแข่งขันแต่ละเกม";
  return (
    <div className="game-flow" aria-label={ariaLabel}>
      {card.games.map((game) => {
        const snapshot = card.snapshots.find((item) => item.gameNumbers.includes(game.number));
        const belongsToGame = (pairing: { id: string; gameNumber?: number }) => pairing.gameNumber === game.number || pairing.id.startsWith(`g${game.number}-`);
        const resultCount = snapshot?.pairings.filter((pairing) => belongsToGame(pairing) && pairing.scoreOne !== undefined && pairing.scoreTwo !== undefined).length ?? 0;
        const pairingCount = snapshot?.pairings.filter(belongsToGame).length ?? 0;
        const available = Boolean(snapshot);
        const active = game.number === (selectedGame ?? card.currentGame);
        const className = `game-flow__item ${active ? "game-flow__item--active" : ""} ${game.status === "COMPLETED" ? "game-flow__item--complete" : ""}`;
        const content = (
          <>
            <span className="game-flow__number">เกม {game.number}</span>
            <strong>{mode === "pairing" || mode === "overview" ? pairingRuleForGame(card, game.number) : mode === "ranking" ? "อันดับหลังเกม" : `${resultCount}/${pairingCount || "—"} ผล`}</strong>
            <small>{game.status === "COMPLETED" ? <><Check size={11} /> ผลเผยแพร่แล้ว</> : snapshot?.confirmedAt ? <><LockKeyhole size={11} /> ผลเผยแพร่แล้ว</> : snapshot ? <><LockKeyhole size={11} /> Pairing เผยแพร่แล้ว</> : game.status}</small>
          </>
        );
        if (linkTo && available) return <Link prefetch={false} key={game.id} className={className} href={`/cards/${card.id}/${linkTo}?game=${game.number}`}>{content}</Link>;
        return <button key={game.id} type="button" className={className} disabled={!available || !onSelect} onClick={() => onSelect?.(game.number)}>{content}</button>;
      })}
    </div>
  );
}
