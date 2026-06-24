import type { Pairing, Player } from "@/domain/tournament/types";
import type { GridFilter } from "@/ui/components/data-grid";

const includes = (haystack: string, needle: string) => haystack.toLocaleLowerCase("th").includes(needle.toLocaleLowerCase("th"));
const fullName = (player: Player | undefined) => `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim();
const playerOf = (players: Map<string, Player>, id: string | null) => id ? players.get(id) : undefined;

/** Multi-field filter set for any pairing table: pair number, code, name, school. */
export function pairingFilters(players: Map<string, Player>): GridFilter<Pairing>[] {
  return [
    { key: "pair", label: "หาคู่ที่", placeholder: "เลขคู่", predicate: (pairing, value) => `${pairing.tableNumber}`.includes(value) },
    { key: "id", label: "หารหัส", placeholder: "เช่น P0042", predicate: (pairing, value) => includes(`${playerOf(players, pairing.playerOneId)?.id ?? ""} ${playerOf(players, pairing.playerTwoId)?.id ?? ""}`, value) },
    { key: "name", label: "หาจากชื่อ", placeholder: "ชื่อหรือนามสกุล", predicate: (pairing, value) => includes(`${fullName(playerOf(players, pairing.playerOneId))} ${fullName(playerOf(players, pairing.playerTwoId))}`, value) },
    { key: "school", label: "หาโรงเรียน", placeholder: "ชื่อสถาบัน", predicate: (pairing, value) => includes(`${playerOf(players, pairing.playerOneId)?.school ?? ""} ${playerOf(players, pairing.playerTwoId)?.school ?? ""}`, value) },
  ];
}

/** Multi-field filter set for any ranking table: code, name, school, rank range, win-point range. */
export function rankingFilters(): GridFilter<{ player: Player; rank: number }>[] {
  return [
    { key: "id", label: "หารหัส", placeholder: "เช่น P0042", predicate: ({ player }, value) => includes(player.id, value) },
    { key: "name", label: "หาจากชื่อ", placeholder: "ชื่อหรือนามสกุล", predicate: ({ player }, value) => includes(`${player.firstName} ${player.lastName}`, value) },
    { key: "school", label: "หาโรงเรียน", placeholder: "ชื่อสถาบัน", predicate: ({ player }, value) => includes(player.school, value) },
    { key: "rank", label: "ช่วงอันดับ", kind: "range", predicate: ({ rank }, min, max) => (min === null || rank >= min) && (max === null || rank <= max) },
    { key: "wp", label: "ช่วงคะแนนชัยชนะ", kind: "range", predicate: ({ player }, min, max) => (min === null || player.winPoints >= min) && (max === null || player.winPoints <= max) },
  ];
}
