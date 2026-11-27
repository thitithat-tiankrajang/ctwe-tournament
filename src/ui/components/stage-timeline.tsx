"use client";

import { Check } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { RuntimeStage, TournamentCard } from "@/domain/tournament/types";

export const stageShort: Partial<Record<RuntimeStage, string>> = {
  TABLE_PAIRING: "จัดคู่", PAIRING_PREVIEW: "ตรวจคู่", RESULT_COLLECTION: "กรอกผล", RESULT_REVIEW: "ตรวจผล",
  FINAL_SEEDING: "จัดคู่ชิง", FINAL_COLLECTION: "แข่งรอบชิง",
};

export type FlowStep = { label: string; state: "done" | "current" | "todo"; sub: string };

/** Card flow as checkpoints: registration, each game, the final when configured, finished. */
export function stageSteps(card: Pick<TournamentCard, "runtimeStage" | "status" | "currentGame" | "games" | "finalType" | "players">, caption: string): FlowStep[] {
  const stage = card.runtimeStage;
  const finished = card.status === "CLOSED" || card.status === "FINISHED" || stage === "FINAL_PUBLISHED";
  const inFinal = stage.startsWith("FINAL") && !finished;
  const hasFinal = card.finalType !== "NONE" || stage.startsWith("FINAL") && stage !== "FINAL_PUBLISHED";
  const steps: FlowStep[] = [{ label: "ลงทะเบียน", state: stage === "PLAYER_REGISTRATION" ? "current" : "done",
    sub: stage === "PLAYER_REGISTRATION" ? `${card.players.length} คน` : "" }];
  for (let game = 1; game <= card.games.length; game++) {
    const state = finished || inFinal || game < card.currentGame ? "done"
      : game === card.currentGame && stage !== "PLAYER_REGISTRATION" ? "current" : "todo";
    steps.push({ label: `เกม ${game}`, state, sub: state === "current" ? caption : "" });
  }
  if (hasFinal) steps.push({ label: "รอบชิง", state: finished ? "done" : inFinal ? "current" : "todo", sub: inFinal ? stageShort[stage] ?? "" : "" });
  steps.push({ label: "จบการแข่งขัน", state: finished ? "done" : "todo", sub: "" });
  return steps;
}

const stateText = { done: "เสร็จแล้ว", current: "ขั้นตอนปัจจุบัน", todo: "ยังไม่ถึง" } as const;

export function StageTimeline({ steps }: { steps: FlowStep[] }) {
  const list = useRef<HTMLOListElement>(null);
  const currentIndex = steps.findIndex((step) => step.state === "current");
  // Keep the current checkpoint in view when the line scrolls (phones, many games).
  useLayoutEffect(() => {
    const flow = list.current;
    const now = flow?.querySelector<HTMLElement>(".flow__s--current");
    if (!flow || !now || flow.scrollWidth <= flow.clientWidth) return;
    flow.scrollLeft = now.offsetLeft - flow.clientWidth / 2 + now.offsetWidth / 2;
  }, [currentIndex]);
  return <ol ref={list} className="flow" aria-label="ขั้นตอนการแข่งขัน">
    {steps.map((step, index) => <li key={index} className={`flow__s flow__s--${step.state}`} aria-current={step.state === "current" ? "step" : undefined}>
      <span className="flow__dot" aria-hidden>{step.state === "done" && <Check className="i" size={11} strokeWidth={3} />}</span>
      <span className="flow__l">{step.label}</span>{step.sub && <span className="flow__sub">{step.sub}</span>}
      <span className="sr">{stateText[step.state]}</span>
    </li>)}
  </ol>;
}
