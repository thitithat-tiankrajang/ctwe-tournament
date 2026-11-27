import assert from "node:assert/strict";
import test from "node:test";
import type { Pairing, PairingSnapshot, Player, TournamentCard } from "@/domain/tournament/types";
import { useTournamentStore } from "./store";
import { parseSpectatorHash, spectatorCardFromHash, spectatorHash, type SpectatorRoute } from "./spectator-route";
import { publicDivisionPayload, spectatorDivision, type PublicDivisionPayload, type SpectatorDivision } from "./spectator-read-model";
import { applyPublicDelta } from "./spectator-state";
import { spectatorPlayerView } from "./spectator-player";
import {
  divisionOptions, schoolOptions, searchCoverageComplete, searchParticipants, spectatorQueryKind,
  type SpectatorSearchCriteria,
} from "./spectator-search";

const DIVISION_A = "11111111-1111-4111-8111-111111111111";
const DIVISION_B = "22222222-2222-4222-8222-222222222222";
const DIVISION_C = "33333333-3333-4333-8333-333333333333";

/** Real Thai names at realistic length: the long ones are what a phone layout has to survive. */
const LONG_NAME = { first: "ประภัสสรานุวัฒน์", last: "ศรีสุวรรณวัฒนกิจจา" };
const LONG_SCHOOL = "โรงเรียนสาธิตมหาวิทยาลัยศรีนครินทรวิโรฒ ประสานมิตร (ฝ่ายมัธยม)";

const player = (id: string, firstName: string, lastName: string, school: string, terminated = false): Player => ({
  id, firstName, lastName, school, division: "", wins: 0, draws: 0, losses: 0, winPoints: 0, diff: 0, terminated,
});

const pairing = (id: string, gameNumber: number, tableNumber: number,
  one: string | null, two: string | null, extra: Partial<Pairing> = {}): Pairing =>
  ({ id, gameNumber, tableNumber, playerOneId: one, playerTwoId: two, pairingPublished: true, ...extra });

const card = (overrides: Partial<TournamentCard> & { id: string }): PublicDivisionPayload => publicDivisionPayload({
  tournamentId: "tournament-1", name: "CTWE 2026", division: "ม.ต้น ชาย", status: "RUNNING",
  runtimeStage: "RESULT_COLLECTION", currentGame: 2, version: 7,
  games: [1, 2, 3].map(number => ({ id: `g${number}`, number, name: `เกม ${number}`, status: "OPEN" as const, maxDiff: 500 })),
  players: [], snapshots: [], finalType: "NONE", finalGames: 0, finalRound: null, gibsonEnabled: false,
  createdAt: "2026-01-01T00:00:00Z", codePrefix: "A", initialPairingRule: "SWISS",
  rules: [], tables: [], audit: [], ...overrides,
} as TournamentCard);

const confirmed = (gameNumbers: number[], pairings: Pairing[]): PairingSnapshot =>
  ({ id: `s${gameNumbers.join("-")}`, gameNumbers, pairings, confirmedAt: "2026-08-01T11:00:00Z" });
const open = (gameNumbers: number[], pairings: Pairing[]): PairingSnapshot =>
  ({ id: `open-${gameNumbers.join("-")}`, gameNumbers, pairings, confirmedAt: "" });

/**
 * Division A — the whole spectator matrix in one card: an official game, an open block holding an
 * awaiting pair, a recorded-but-unpublished pair and a bye, a terminated player, a player with no
 * assignment at all, and a high pair number whose seats collide with a player code elsewhere.
 */
function divisionA(): PublicDivisionPayload {
  return card({
    id: DIVISION_A,
    players: [
      player("A001", "สมชาย", "ใจดี", "โรงเรียนสวนกุหลาบ"),
      player("A002", "สมหญิง", "รักเรียน", "โรงเรียนเตรียมอุดม"),
      player("A003", "อนันต์", "มั่นคง", "โรงเรียนสาธิต", true),
      player("A004", LONG_NAME.first, LONG_NAME.last, LONG_SCHOOL),
      player("A005", "ปรีชา", "ตั้งใจ", "โรงเรียนสวนกุหลาบ"),
      player("A006", "วิชัย", "รุ่งเรือง", "โรงเรียนสวนกุหลาบ"),
      player("A007", "ธนกร", "พูนผล", "โรงเรียนเตรียมอุดม"),
      player("A008", "ณัฐพล", "ยิ่งยง", "โรงเรียนสาธิต"),
    ],
    snapshots: [
      confirmed([1], [
        pairing("a-1-1", 1, 1, "A001", "A002", { resultType: "WIN", winnerId: "A001", scoreOne: 420, scoreTwo: 300, calculatedDiff: 120 }),
        pairing("a-1-2", 1, 2, "A003", "A004", { resultType: "DRAW", scoreOne: 350, scoreTwo: 350, calculatedDiff: 0 }),
        pairing("a-1-14", 1, 14, "A007", "A008", { resultType: "WIN", winnerId: "A007", scoreOne: 400, scoreTwo: 360, calculatedDiff: 40 }),
      ]),
      open([2], [
        pairing("a-2-1", 2, 1, "A001", "A004"),
        pairing("a-2-2", 2, 2, "A002", "A003", { resultType: "WIN", winnerId: "A002", scoreOne: 400, scoreTwo: 380, calculatedDiff: 20 }),
        pairing("a-2-3", 2, 3, "A005", null),
      ]),
    ],
  });
}

/** Division B — same numeric codes under a different prefix, so bare numbers are ambiguous. */
function divisionB(): PublicDivisionPayload {
  return card({
    id: DIVISION_B, division: "ม.ปลาย หญิง", codePrefix: "B", currentGame: 1, runtimeStage: "TABLE_PAIRING",
    players: [
      player("B001", "สมปอง", "ใจงาม", "โรงเรียนเตรียมอุดม"),
      player("B002", "กมลชนก", "แสงทอง", LONG_SCHOOL),
    ],
    snapshots: [open([1], [pairing("b-1-1", 1, 1, "B001", "B002")])],
  });
}

const viewOf = (payload: PublicDivisionPayload, code: string) =>
  spectatorPlayerView(payload, spectatorDivision(payload), code);

const criteria = (over: Partial<SpectatorSearchCriteria> = {}): SpectatorSearchCriteria =>
  ({ query: "", divisionId: null, school: null, ...over });

const event = (): SpectatorDivision[] => [divisionA(), divisionB()].map(spectatorDivision);

// ---------------------------------------------------------------- Search

test("a numeric query is a player code, and a unique exact code is a destination", () => {
  assert.equal(spectatorQueryKind("27"), "code");
  assert.equal(spectatorQueryKind("A27"), "code");
  assert.equal(spectatorQueryKind("สมชาย"), "name");
  assert.equal(spectatorQueryKind("   "), "empty");
  const outcome = searchParticipants(event(), criteria({ query: "A1" }));
  assert.equal(outcome.total, 1);
  assert.equal(outcome.uniqueExactCode?.code, "A001");
  assert.equal(outcome.uniqueExactCode?.divisionId, DIVISION_A);
  // 016 / 16 / A16 are the same code; A011 is not.
  assert.deepEqual(searchParticipants(event(), criteria({ query: "007" })).results.map(r => r.code), ["A007"]);
});

test("an ambiguous code lists every division it can mean and opens none of them", () => {
  const outcome = searchParticipants(event(), criteria({ query: "1" }));
  assert.deepEqual(outcome.results.map(result => `${result.divisionLabel}:${result.code}`),
    ["ม.ต้น ชาย:A001", "ม.ปลาย หญิง:B001"]);
  assert.equal(outcome.uniqueExactCode, null);
});

test("a unique code inside a filter is still not auto-opened while the filter hides its rivals", () => {
  const filtered = searchParticipants(event(), criteria({ query: "1", divisionId: DIVISION_A }));
  assert.deepEqual(filtered.results.map(result => result.code), ["A001"]);
  assert.equal(filtered.uniqueExactCode, null);
});

test("name search runs across every division without choosing one first", () => {
  const outcome = searchParticipants(event(), criteria({ query: "สม" }));
  assert.deepEqual(outcome.results.map(result => result.code).sort(), ["A001", "A002", "B001"]);
  assert.equal(new Set(outcome.results.map(result => result.divisionId)).size, 2);
  assert.equal(searchParticipants(event(), criteria({ query: "ศรีสุวรรณวัฒนกิจจา" })).results[0].code, "A004");
});

test("division and institution narrow the same search without changing its meaning", () => {
  const byDivision = searchParticipants(event(), criteria({ query: "สม", divisionId: DIVISION_B }));
  assert.deepEqual(byDivision.results.map(result => result.code), ["B001"]);
  const bySchool = searchParticipants(event(), criteria({ query: "สม", school: "โรงเรียนเตรียมอุดม" }));
  assert.deepEqual(bySchool.results.map(result => result.code).sort(), ["A002", "B001"]);
  const both = searchParticipants(event(), criteria({ query: "สม", divisionId: DIVISION_A, school: "โรงเรียนเตรียมอุดม" }));
  assert.deepEqual(both.results.map(result => result.code), ["A002"]);
  assert.deepEqual(divisionOptions(event()).map(option => option.label), ["ม.ต้น ชาย", "ม.ปลาย หญิง"]);
  assert.deepEqual(schoolOptions(event(), DIVISION_B), ["โรงเรียนเตรียมอุดม", LONG_SCHOOL]);
  assert.ok(schoolOptions(event(), null).includes("โรงเรียนสวนกุหลาบ"));
});

test("a numeric query never answers with a seat", () => {
  const divisions = event();
  const seats = divisions[0].contests.flatMap(contest => contest.assignments.map(assignment => assignment.seat));
  assert.ok(seats.includes(27) && seats.includes(28), "fixture must contain the seats being ruled out");
  assert.equal(searchParticipants(divisions, criteria({ query: "27" })).total, 0);
  assert.equal(searchParticipants(divisions, criteria({ query: "28" })).total, 0);
});

test("search coverage is incomplete while any division publishes no roster", () => {
  assert.equal(searchCoverageComplete(event()), true);
  const registering = spectatorDivision(card({ id: DIVISION_C, runtimeStage: "PLAYER_REGISTRATION", status: "DRAFT" }));
  assert.equal(searchCoverageComplete([...event(), registering]), false);
  assert.equal(searchCoverageComplete([]), false);
});

// ---------------------------------------------------------------- Player destination

test("the current game answers seat, pair and opponent identity from the published pairing", () => {
  const view = viewOf(divisionA(), "A001")!;
  assert.equal(view.participant.name, "สมชาย ใจดี");
  assert.equal(view.participant.school, "โรงเรียนสวนกุหลาบ");
  assert.equal(view.divisionLabel, "ม.ต้น ชาย");
  assert.equal(view.assignment?.game, 2);
  assert.equal(view.assignment?.pairNumber, 1);
  assert.equal(view.assignment?.seat, 1);
  assert.equal(view.assignment?.side, 1);
  assert.equal(view.assignment?.opponent?.code, "A004");
  assert.equal(view.assignment?.opponent?.name, `${LONG_NAME.first} ${LONG_NAME.last}`);
  assert.equal(view.assignment?.opponent?.school, LONG_SCHOOL);
  assert.equal(view.assignment?.state, "awaiting-result");
  assert.equal(view.assignment?.score, null);
  assert.equal(view.awaitingGame, null);
  // Side two of the same pair reads the other seat and the mirrored opponent.
  const opponent = viewOf(divisionA(), "A004")!;
  assert.equal(opponent.assignment?.seat, 2);
  assert.equal(opponent.assignment?.side, 2);
  assert.equal(opponent.assignment?.opponent?.code, "A001");
});

test("seats derive from the pairing slot for every pair, including high ones", () => {
  const division = spectatorDivision(divisionA());
  const seatsOf = (code: string) => division.contests
    .filter(contest => contest.assignments.some(slot => slot.participantKey === `${DIVISION_A}:${code}`))
    .map(contest => contest.assignments.find(slot => slot.participantKey === `${DIVISION_A}:${code}`)!.seat);
  assert.deepEqual(seatsOf("A007"), [27]);
  assert.deepEqual(seatsOf("A008"), [28]);
  assert.deepEqual(seatsOf("A005"), [5]);
});

test("awaiting, recorded and official are three different answers", () => {
  const payload = divisionA();
  assert.equal(viewOf(payload, "A001")!.assignment?.state, "awaiting-result");
  const recorded = viewOf(payload, "A002")!;
  assert.equal(recorded.assignment, null, "a recorded game is a result, not an instruction to play again");
  assert.equal(recorded.ledger.at(-1)?.state, "recorded");
  assert.deepEqual(recorded.ledger.at(-1)?.score, { own: 400, opponent: 380 });
  assert.equal(recorded.ledger.at(-1)?.outcome, "W");
  assert.equal(recorded.ledger.at(-1)?.diff, 20);
  // The same player's OFFICIAL game 1 result is a loss, and it is the one the standings used.
  assert.equal(viewOf(payload, "A007")!.ledger.at(-1)?.state, "official");
});

test("a recorded result is not folded into the official standing before its game is published", () => {
  const view = viewOf(divisionA(), "A002")!;
  assert.equal(view.officialThroughGame, 1);
  assert.equal(view.standing?.throughGame, 1);
  // Game 1: lost to A001. Game 2's recorded win is deliberately absent from wins and diff.
  assert.deepEqual([view.standing?.wins, view.standing?.draws, view.standing?.losses, view.standing?.diff], [0, 0, 1, -120]);
  assert.deepEqual(view.history.qualifying.map(row => row.game), [1]);
  assert.equal(view.history.qualifyingTotals.diff, -120);
  const leader = viewOf(divisionA(), "A001")!;
  assert.equal(leader.standing?.rank, 1);
  assert.deepEqual([leader.standing?.wins, leader.standing?.diff], [1, 120]);
  const drawn = viewOf(divisionA(), "A004")!;
  assert.deepEqual([leader.standing?.winPoints, drawn.standing?.winPoints, view.standing?.winPoints], [2, 1, 0]);
});

test("a division with nothing published yet has no official standing and says so", () => {
  const view = viewOf(divisionB(), "B001")!;
  assert.equal(view.officialThroughGame, null);
  assert.equal(view.standing, null);
  assert.deepEqual(view.history.qualifying, []);
  assert.equal(view.assignment?.seat, 1);
  assert.equal(view.assignment?.state, "awaiting-result");
});

test("bye, unassigned and withdrawn are distinguishable states, not blanks", () => {
  const payload = divisionA();
  const bye = viewOf(payload, "A005")!;
  assert.equal(bye.assignment?.bye, true);
  assert.equal(bye.assignment?.opponent, null);
  assert.equal(bye.assignment?.seat, 5);
  const unassigned = viewOf(payload, "A006")!;
  assert.equal(unassigned.assignment, null);
  assert.equal(unassigned.awaitingGame, 2);
  const withdrawn = viewOf(payload, "A003")!;
  assert.equal(withdrawn.participant.listedInStandings, false);
  assert.equal(withdrawn.standing, null, "a terminated player holds no rank");
  assert.equal(withdrawn.assignment, null, "withdrawn players receive no live location instruction");
  assert.equal(withdrawn.ledger.at(-1)?.state, "recorded", "their published participation is still readable");
  assert.equal(viewOf(payload, "A999"), null);
});

test("a voided slot reports no contest to attend rather than an empty opponent", () => {
  const payload = divisionA();
  payload.snapshots[1].pairings.push(pairing("a-2-9", 2, 9, null, null, { voided: true }));
  const division = spectatorDivision(payload);
  assert.equal(division.contests.find(contest => contest.locator === "a-2-9")?.state, "void");
});

test("history and the official standing survive live pairing and result deltas", () => {
  const payload = divisionA();
  const before = viewOf(payload, "A001")!;
  const withPairings = applyPublicDelta(payload, { type: "pairings", cardId: payload.id, version: payload.version + 1,
    gameNumber: 2, pairings: [pairing("a-2-1", 2, 7, "A001", "A002")] })!;
  const afterPairings = viewOf(withPairings, "A001")!;
  assert.equal(afterPairings.assignment?.seat, 13, "the new slot moves the seat");
  assert.deepEqual(afterPairings.history, before.history);
  assert.deepEqual(afterPairings.standing, before.standing);
  const withResult = applyPublicDelta(withPairings, { type: "result", cardId: payload.id, version: withPairings.version + 1,
    changedPairings: [pairing("a-2-1", 2, 7, "A001", "A002", { resultType: "WIN", winnerId: "A001", scoreOne: 500, scoreTwo: 100, calculatedDiff: 400 })] })!;
  const afterResult = viewOf(withResult, "A001")!;
  assert.equal(afterResult.assignment, null);
  assert.equal(afterResult.ledger.at(-1)?.state, "recorded");
  assert.deepEqual(afterResult.history, before.history, "an unpublished result cannot rewrite history");
  assert.deepEqual(afterResult.standing, before.standing, "nor the official standing");
});

test("publishing the open block moves the cutoff, the history and the rank together", () => {
  const payload = divisionA();
  payload.snapshots[1].pairings = payload.snapshots[1].pairings.map(row => row.id === "a-2-1"
    ? { ...row, resultType: "WIN" as const, winnerId: "A001", scoreOne: 500, scoreTwo: 100, calculatedDiff: 400 } : row);
  const published = applyPublicDelta(payload, { type: "publish", cardId: payload.id, version: payload.version + 1,
    snapshotId: "s2", gameNumbers: [2], confirmedAt: "2026-08-01T13:00:00Z", currentGame: 3, runtimeStage: "TABLE_PAIRING" })!;
  const view = viewOf(published, "A001")!;
  assert.equal(view.officialThroughGame, 2);
  assert.deepEqual(view.history.qualifying.map(row => row.game), [1, 2]);
  assert.equal(view.assignment, null);
  assert.equal(view.ledger.at(-1)?.state, "official");
  assert.equal(view.standing?.diff, 520);
  assert.equal(view.awaitingGame, 3, "the next game is announced as a wait, not as missing data");
});

test("the championship round carries an opponent but never a seat or a table", () => {
  const payload = divisionA();
  payload.finalType = "CHAMPION";
  payload.runtimeStage = "FINAL_COLLECTION";
  payload.finalRound = { slots: [{ slot: 0, playerOneId: "A001", playerTwoId: "A002", games: [], winnerId: null, winnerWins: null, winnerLosses: null, totalDiff: null }] };
  const view = viewOf(payload, "A001")!;
  assert.equal(view.final?.label, "ชิงอันดับ 1 - 2");
  assert.equal(view.final?.opponent?.code, "A002");
  assert.equal(view.final?.decided, false);
  assert.ok(!("seat" in (view.final as object)) && !("table" in (view.final as object)));
  assert.equal(viewOf(payload, "A005")!.final, null);
});

// ---------------------------------------------------------------- URL state

test("every destination is a fragment, and the legacy card fragment is unchanged", () => {
  const routes: SpectatorRoute[] = [
    { kind: "home" },
    { kind: "card", cardId: DIVISION_A },
    { kind: "find", query: "สมชาย ใจดี", divisionId: DIVISION_A, school: LONG_SCHOOL },
    { kind: "find", query: "A001", divisionId: null, school: null },
    { kind: "player", divisionId: DIVISION_A, code: "A001" },
  ];
  for (const route of routes) assert.deepEqual(parseSpectatorHash(spectatorHash(route)), route, spectatorHash(route));
  assert.equal(spectatorHash({ kind: "card", cardId: DIVISION_A }), `#card=${DIVISION_A}`);
  assert.equal(spectatorCardFromHash(`#card=${DIVISION_A}`), DIVISION_A);
  assert.equal(spectatorHash({ kind: "home" }), "");
});

test("Back onto a search fragment restores the query and both filters", () => {
  const hash = spectatorHash({ kind: "find", query: "สม", divisionId: DIVISION_B, school: "โรงเรียนเตรียมอุดม" });
  const restored = parseSpectatorHash(hash);
  assert.equal(restored.kind, "find");
  assert.deepEqual(searchParticipants(event(), restored.kind === "find"
    ? { query: restored.query, divisionId: restored.divisionId, school: restored.school } : criteria())
    .results.map(result => result.code), ["B001"]);
});

test("an unusable fragment lands on the entrance instead of an error", () => {
  for (const hash of ["", "#", "#card=nope", "#player=not-a-division:A001", `#player=${DIVISION_A}:`, "#findme", "#anything"])
    assert.deepEqual(parseSpectatorHash(hash), { kind: "home" }, hash);
});

// ---------------------------------------------------------------- Isolation

for (const role of [null, "ROLE_DIRECTOR", "ROLE_STAFF", "ROLE_ADMIN"])
  test(`search and participation are identical for ${role ?? "an anonymous visitor"}`, () => {
    const anonymous = { search: searchParticipants(event(), criteria({ query: "สม" })), player: viewOf(divisionA(), "A001") };
    const original = useTournamentStore.getState();
    try {
      useTournamentStore.setState({ activeTournament: { id: "private", name: "Operator workspace" } as never,
        auth: { authenticated: role !== null, username: role, roles: role ? [role] : [], csrfToken: "private" } });
      assert.deepEqual(searchParticipants(event(), criteria({ query: "สม" })), anonymous.search);
      assert.deepEqual(viewOf(divisionA(), "A001"), anonymous.player);
    } finally { useTournamentStore.setState(original); }
  });
