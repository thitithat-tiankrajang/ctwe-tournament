import type { Pairing, Player } from "@/domain/tournament/types";
import type { PublicDivisionPayload } from "../spectator-read-model";

export const W1_DIVISION = "11111111-1111-4111-8111-111111111111";
export const W1_TOURNAMENT = "22222222-2222-4222-8222-222222222222";

const player = (id: string, firstName: string, lastName: string, school: string): Player => ({
  id, firstName, lastName, school, division: "ม.ต้น ชาย", wins: 0, draws: 0, losses: 0,
  winPoints: 0, diff: 0, terminated: false,
});

export function w1PlayerFixture(): PublicDivisionPayload {
  const gameOne: Pairing = { id: "w1-g1", gameNumber: 1, tableNumber: 1,
    playerOneId: "A001", playerTwoId: "A002", pairingPublished: true,
    resultType: "WIN", winnerId: "A001", scoreOne: 420, scoreTwo: 300, calculatedDiff: 120 };
  const gameTwo: Pairing = { id: "w1-g2", gameNumber: 2, tableNumber: 2,
    playerOneId: "A001", playerTwoId: "A003", pairingPublished: true,
    resultType: "WIN", winnerId: "A003", scoreOne: 312, scoreTwo: 450, calculatedDiff: 138 };
  const gameThree: Pairing = { id: "w1-g3", gameNumber: 3, tableNumber: 3,
    playerOneId: "A001", playerTwoId: "A004", pairingPublished: true };
  return {
    id: W1_DIVISION, tournamentId: W1_TOURNAMENT, name: "CTWE · W1", division: "ม.ต้น ชาย",
    status: "RUNNING", runtimeStage: "RESULT_COLLECTION", currentGame: 3, version: 7,
    games: [1, 2, 3].map(number => ({ id: `g${number}`, number, name: `เกม ${number}`, status: "OPEN", maxDiff: 350 })),
    players: [
      player("A001", "ประภัสสรานุวัฒน์", "ศรีสุวรรณวัฒนกิจจา", "โรงเรียนสาธิตมหาวิทยาลัยศรีนครินทรวิโรฒ ประสานมิตร (ฝ่ายมัธยม)"),
      player("A002", "สมชาย", "ใจดี", "โรงเรียนสวนกุหลาบ"),
      player("A003", "ธนกร", "พูนผล", "โรงเรียนเตรียมอุดมศึกษาพัฒนาการ รัชดา"),
      player("A004", "กมลชนก", "แสงทอง", "โรงเรียนสาธิตมหาวิทยาลัยศรีนครินทรวิโรฒ ประสานมิตร (ฝ่ายมัธยม)"),
    ],
    snapshots: [
      { id: "w1-s1", gameNumbers: [1], confirmedAt: "2026-09-16T03:00:00Z", pairings: [gameOne] },
      { id: "w1-open", gameNumbers: [2, 3], confirmedAt: "", pairings: [gameTwo, gameThree] },
    ],
    finalType: "NONE", finalGames: 0, finalRound: null, gibsonEnabled: false,
    createdAt: "2026-09-16T00:00:00Z", codePrefix: "A", initialPairingRule: "SWISS",
  };
}
