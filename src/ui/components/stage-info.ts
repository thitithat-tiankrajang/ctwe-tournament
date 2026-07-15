import type { RuntimeStage, TournamentCard } from "@/domain/tournament/types";
import type { BadgeTone } from "@/ui/components/badge";

/** Thai labels for every workflow stage — the only place stage wording lives (no raw enums in UI). */
export const stageLabels: Record<RuntimeStage, string> = {
  PLAYER_REGISTRATION: "ลงทะเบียนผู้เล่น",
  TABLE_PAIRING: "รอสร้าง Pairing",
  PAIRING_PREVIEW: "ตรวจและยืนยัน Pairing",
  RESULT_COLLECTION: "กรอกผลการแข่งขัน",
  RESULT_REVIEW: "Review ก่อน Publish",
  FINAL_SEEDING: "ตรวจผู้เข้าชิงรอบชิง",
  FINAL_COLLECTION: "กรอกผลรอบชิงชนะเลิศ",
  FINAL_PUBLISHED: "ประกาศผลแล้ว",
};

export type StageTone = BadgeTone;

/**
 * Compact stage/progress summary for a card-list row. `audience` picks the wording:
 * back-office users see the operational step, public viewers see spectator language.
 */
export function cardStageInfo(card: TournamentCard, audience: "staff" | "viewer"): { label: string; tone: StageTone } {
  const playerCount = card.playerCount ?? card.players.length;
  const gameCount = card.gameCount ?? card.games.length;
  const finished = card.status === "FINISHED" || card.status === "CLOSED" || card.runtimeStage === "FINAL_PUBLISHED";
  if (finished) return { label: "จบการแข่งขันแล้ว", tone: "success" };
  if (card.runtimeStage === "PLAYER_REGISTRATION") {
    return audience === "staff"
      ? { label: `ลงทะเบียน · ${playerCount} คน`, tone: "info" }
      : { label: "ยังไม่เริ่มแข่งขัน", tone: "neutral" };
  }
  if (card.runtimeStage === "FINAL_SEEDING" || card.runtimeStage === "FINAL_COLLECTION")
    return { label: "รอบชิงชนะเลิศ", tone: "warning" };
  const progress = gameCount > 0 ? `เกม ${card.currentGame}/${gameCount}` : `เกม ${card.currentGame}`;
  if (audience === "viewer") return { label: `${progress} · กำลังแข่งขัน`, tone: "info" };
  const phase = card.runtimeStage === "RESULT_COLLECTION" ? "กรอกผล"
    : card.runtimeStage === "RESULT_REVIEW" ? "รอเผยแพร่ผล"
    : "จับคู่";
  return { label: `${progress} · ${phase}`, tone: card.runtimeStage === "RESULT_REVIEW" ? "warning" : "info" };
}
