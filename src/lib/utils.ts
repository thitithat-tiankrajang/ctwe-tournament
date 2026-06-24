import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Pairing, Player } from "@/domain/tournament/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Flatten a player into one searchable string (code, name, school) for table filtering. */
export function playerSearchText(player: Player | undefined) {
  return player ? `${player.id} ${player.firstName} ${player.lastName} ${player.school}` : "";
}

/** Flatten a pairing (table number + both players) into one searchable string. */
export function pairingSearchText(pairing: Pairing, players: Map<string, Player>) {
  const playerOne = pairing.playerOneId ? players.get(pairing.playerOneId) : undefined;
  const playerTwo = pairing.playerTwoId ? players.get(pairing.playerTwoId) : undefined;
  return `คู่ ${pairing.tableNumber} ${playerSearchText(playerOne)} ${playerSearchText(playerTwo)}`;
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function downloadText(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
