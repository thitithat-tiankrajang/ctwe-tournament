import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { applyColumnControls, fieldGroupsOf, filterTargets, playerCodeKeysOf } from "./data-grid";
import { ACTION_WIDTH, editColumns } from "./result-entry-grid";

/**
 * The result-entry grid's two code columns are ONE searchable field.
 *
 * รหัส 1 owns the search affordance; รหัส 2 is a read-only mirror with no menu and no sort. But a
 * player's seat parity decides which column holds their code, and the operator cannot know it
 * before searching — so the filter typed into รหัส 1 must still match รหัส 2, or roughly half of
 * all code searches return an empty board and the operator concludes the player is not in the game.
 *
 * The styling half is asserted from source because the repo has no React test setup
 * (18_P4_CLOSURE.md §9); these catch the omission, which is the failure mode that actually happens.
 */

const COMPONENT = join(process.cwd(), "src", "ui", "components", "result-entry-grid.tsx");
const GLOBALS = join(process.cwd(), "src", "app", "globals.css");

type Row = { one: string; two: string };
const accessors = { id1: (row: Row) => row.one, id2: (row: Row) => row.two };
const rows: Row[] = [
  { one: "A045", two: "A012" },
  { one: "A012", two: "A045" },
  { one: "A007", two: "A099" },
];
const CODE_KEYS = ["id1", "id2"];
const CODE_GROUP = { id1: CODE_KEYS, id2: CODE_KEYS };

test("a filter key inside the group targets the whole group; everything else targets itself", () => {
  assert.deepEqual(filterTargets("id1", CODE_GROUP), CODE_KEYS);
  assert.deepEqual(filterTargets("id2", CODE_GROUP), CODE_KEYS);
  assert.deepEqual(filterTargets("school1", CODE_GROUP), ["school1"]);
  // No group configured is the default, and must leave every column filtering only itself.
  assert.deepEqual(filterTargets("id1"), ["id1"]);
});

test("groups are derived from the columns, and a lone member is no group at all", () => {
  // The declaration that matters is on the column; keeping a second list beside it is what drifts.
  const columns = [
    { key: "id1", label: "รหัส 1", min: 0, width: 0, filterKind: "playerCode" as const, field: "code" },
    { key: "name1", label: "ชื่อ", min: 0, width: 0, field: "name" },
    { key: "id2", label: "รหัส 2", min: 0, width: 0, filterKind: "playerCode" as const, searchable: false as const, field: "code" },
    { key: "pair", label: "คู่", min: 0, width: 0 },
  ];
  assert.deepEqual(fieldGroupsOf(columns), { id1: CODE_KEYS, id2: CODE_KEYS });
  // `name` has one member here, so it must not become a group: a filter on it stays on it.
  assert.deepEqual(filterTargets("name1", fieldGroupsOf(columns)), ["name1"]);
  assert.deepEqual(playerCodeKeysOf(columns), CODE_KEYS);
  assert.deepEqual(fieldGroupsOf([]), {});
});

test("searching รหัส 1 finds the player on either side of the pairing", () => {
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "45" }, CODE_KEYS, CODE_GROUP);
  // Both the row where 045 sits on side one AND the row where it sits on side two.
  assert.deepEqual(found.map((row) => row.one), ["A045", "A012"]);
});

test("a code that is in no pairing still narrows to nothing", () => {
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "500" }, CODE_KEYS, CODE_GROUP);
  assert.deepEqual(found, []);
});

test("exact-digit code matching survives the group hop", () => {
  // matchesPlayerCode is exact: 1 matches A001, never A012. The group must not degrade that to a
  // substring match, or "1" would drag in every code containing a 1.
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "12" }, CODE_KEYS, CODE_GROUP);
  assert.deepEqual(found.map((row) => row.one), ["A045", "A012"]);
  assert.deepEqual(applyColumnControls(rows, accessors, {}, null, { id1: "1" }, CODE_KEYS, CODE_GROUP), []);
});

test("without a group, a column filter still matches only its own column", () => {
  // Guards the default for DataGrid and ResultViewGrid, which keep per-column semantics.
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "45" }, CODE_KEYS);
  assert.deepEqual(found.map((row) => row.one), ["A045"]);
});

test("one รหัส filter takes several codes at once, on either side", () => {
  // "4 012 58 002 210" is a call-list: five codes, one box, leading zeros optional.
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "7 45" }, CODE_KEYS, CODE_GROUP);
  assert.deepEqual(found.map((row) => row.one), ["A045", "A012", "A007"]);
  // Normalisation is the domain's, not a second implementation: 4 is 004 and never 040.
  const padded = applyColumnControls(
    [{ one: "A004", two: "A040" }], { id1: (row: Row) => row.one, id2: (row: Row) => row.two },
    {}, null, { id1: "4" }, CODE_KEYS, CODE_GROUP,
  );
  assert.equal(padded.length, 1);
  assert.deepEqual(applyColumnControls(rows, accessors, {}, null, { id1: "500 600" }, CODE_KEYS, CODE_GROUP), []);
});

test("a term that is not code-shaped keeps the single-term fallback", () => {
  // A bare prefix has no digits, so parseSearchQuery calls it text. It must not be tokenised, and
  // must still reach matchesPlayerCode's substring fallback the way it did before multi-code.
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "A" }, CODE_KEYS, CODE_GROUP);
  assert.equal(found.length, rows.length);
});

test("a grouped TEXT field matches the other side without tokenising the term", () => {
  // Names contain spaces, so "no multi-search" is not a preference here - splitting would be wrong.
  type Person = { name1: string; name2: string };
  const people = [
    { name1: "สมชาย ใจดี", name2: "ปิยะ ทองดี" },
    { name1: "อนันต์ สุขใจ", name2: "สมชาย ใจดี" },
    { name1: "วีระ มั่นคง", name2: "ธนา พูนผล" },
  ];
  const nameKeys = ["name1", "name2"];
  const found = applyColumnControls(
    people,
    { name1: (row: Person) => row.name1, name2: (row: Person) => row.name2 },
    {}, null, { name1: "สมชาย ใจดี" }, [], { name1: nameKeys, name2: nameKeys },
  );
  assert.deepEqual(found.map((row) => row.name1), ["สมชาย ใจดี", "อนันต์ สุขใจ"]);
});

/**
 * Every two-seat grid in the app, and the logical fields its columns must declare. Each `field` is
 * one thing split across two cells; side 1 owns the menu, side 2 mirrors it.
 *
 * The overview grids have no school COLUMN — school is rendered inside the athlete cell — so they
 * declare two fields, not three.
 */
const TWO_SEAT_GRIDS = [
  { file: "result-entry-grid.tsx", fields: { code: ["id1", "id2"], name: ["name1", "name2"], school: ["school1", "school2"] } },
  { file: "standings-grids.tsx", fields: { code: ["id1", "id2"], name: ["name1", "name2"], school: ["school1", "school2"] } },
  { file: "card-overview-view.tsx", fields: { code: ["id1", "id2"], name: ["name1", "name2"] } },
];

/** Every column definition line declaring `key`. One column per line is the house style here. */
function columnLines(source: string, key: string): string[] {
  const lines = source.split("\n").filter((line) => line.includes(`key: "${key}"`) && line.includes("label:"));
  assert.ok(lines.length > 0, `no column declares key ${key}`);
  return lines;
}

test("every two-seat grid declares the same fields, with side 2 as the mirror", () => {
  // One rule, five grids: a player is found from either seat, and only one column says so.
  for (const { file, fields } of TWO_SEAT_GRIDS) {
    const source = readFileSync(join(process.cwd(), "src", "ui", "components", file), "utf8");
    for (const [field, [first, second]] of Object.entries(fields)) {
      for (const line of columnLines(source, first)) {
        assert.ok(line.includes(`field: "${field}"`), `${file}: ${first} is not tagged field "${field}"`);
        assert.ok(!line.includes("searchable: false"), `${file}: ${first} must keep the menu - it is the affordance`);
      }
      for (const line of columnLines(source, second)) {
        assert.ok(line.includes(`field: "${field}"`), `${file}: ${second} is not tagged field "${field}"`);
        assert.ok(line.includes("searchable: false"), `${file}: ${second} still has its own menu`);
      }
    }
  }
});

test("the entry grid's fields resolve to real groups, not just tags", () => {
  // editColumns is the only column list exported as data, so this is the one place the derivation
  // can be checked against objects rather than source text.
  const groups = fieldGroupsOf(editColumns(true));
  assert.deepEqual(groups.id1, ["id1", "id2"]);
  assert.deepEqual(groups.id2, ["id1", "id2"]);
  assert.deepEqual(groups.name1, ["name1", "name2"]);
  assert.deepEqual(groups.school1, ["school1", "school2"]);
  // The score/diff/action columns are nobody's mirror and must stay out of every group.
  for (const key of ["pair", "score1", "score2", "diff", "action"]) assert.equal(groups[key], undefined);
});

test("score entry opens the same filter for either seat of a logical field", () => {
  const source = readFileSync(COMPONENT, "utf8");
  for (const stale of ["ENTRY_FILTER_KEYS", "VIEW_FILTER_KEYS", "ENTRY_CODE_GROUP"])
    assert.ok(!source.includes(stale), `${stale} is back - the menu list must be derived from the columns`);
  assert.match(source, /const field = column\.field/);
  assert.match(source, /toggleMenu\(event\.currentTarget, "filter", field\)/);
  assert.match(source, /\[row\.pairing\?\.playerOneId, row\.pairing\?\.playerTwoId\]\.some/);
});

test("the winner column is its own field - it answers who won, not who played", () => {
  // Grouping it with the code columns would make a รหัส filter match rows the player merely won.
  const source = readFileSync(COMPONENT, "utf8");
  const winner = columnLines(source, "winner")[0];
  assert.ok(winner.includes('filterKind: "playerCode"'), "winner still matches codes exactly");
  assert.ok(!winner.includes("field:"), "winner must not join another column's field");
});

test("the mirror mutes its HEADER only - the value reads exactly like side 1", () => {
  const css = readFileSync(GLOBALS, "utf8");
  assert.match(css, /\.entry-grid th\.egrid-th--mirror \.egrid-th__label \{ color: var\(--muted\);/,
    "the mirror header must stay muted - it is the only thing marking the column as menu-less");
  // No rule may recolour a mirror CELL. Muting it costs legibility in every grid, and a blue
  // carve-out for one grid is the same mistake in the other direction - the value simply inherits.
  assert.ok(!/td\.egrid-td--mirror\.cell-id \{/.test(css),
    "a mirror cell must take its ink from .cell-id, not from a mirror-specific rule");
  assert.match(css, /\.cell-id \{ color: var\(--blue-dark\)/, "รหัส cells are blue; the mirror inherits that");
});

const actionOf = (canPenalty: boolean) => {
  const columns = editColumns(canPenalty);
  const action = columns[columns.length - 1];
  assert.equal(action.key, "action", "จัดการ must stay the trailing column so it sits at the table's right edge");
  return action;
};

test("จัดการ is floored to the widest state the viewer's role can actually produce", () => {
  // Director rows carry ลงดาบ, so their widest is เซฟ + ✕ + ลงดาบ; staff only ever reach เซฟ + ✕.
  assert.equal(actionOf(true).fitMin, ACTION_WIDTH.director);
  assert.equal(actionOf(false).fitMin, ACTION_WIDTH.staff);
  // Both must be real reductions from the 220 this replaced, or the bug is not fixed.
  assert.ok(ACTION_WIDTH.director < 220 && ACTION_WIDTH.staff < ACTION_WIDTH.director);
});

test("the จัดการ floor is also its width, so fitWidths cannot hand back the space", () => {
  // fitWidths distributes slack by `max(1, width - fitMin)`. Any gap here reopens the column.
  for (const canPenalty of [true, false]) {
    const action = actionOf(canPenalty);
    assert.equal(action.width, action.fitMin, "width must equal fitMin or the column re-inflates");
    assert.equal(action.min, action.fitMin, "the manual-resize floor must match the content floor");
  }
});

test("จัดการ does not opt into content fitting", () => {
  // measureContentMins reads the CELL width for this column (the group is a block-level flex box
  // that fills it), so fitContent here is a ratchet that only ever grows. Verified in-browser:
  // 180px of buttons inside an 899.5px cell measured 897.
  assert.equal(actionOf(true).fitContent, undefined);
  assert.equal(actionOf(false).fitContent, undefined);
});

test("both roles render the same column count, so the width array stays aligned", () => {
  // useResizableColumns keys its restore on `count`; a differing length would silently drop
  // persisted widths and, worse, misalign colWidths against the rendered cells.
  assert.equal(editColumns(true).length, editColumns(false).length);
  assert.equal(editColumns(true).length, 11);
});

test("persisted grid widths are versioned past the 220px layout", () => {
  const source = readFileSync(join(process.cwd(), "src", "ui", "components", "data-grid.tsx"), "utf8");
  assert.match(source, /ctwe\.gridWidths\.v3\./, "bump the key or nobody with a resized tab sees the new width");
  assert.ok(!source.includes("ctwe.gridWidths.v2."), "the old key must not linger");
});

test("no grid carries a per-table mirror exception any more", () => {
  // `entry-grid--entry` existed only to except this one table from the mirror ink. One shared rule
  // replaced it, so the class and every selector naming it must be gone, not merely unused.
  for (const file of ["result-entry-grid.tsx", "card-overview-view.tsx", "standings-grids.tsx"])
    assert.ok(!readFileSync(join(process.cwd(), "src", "ui", "components", file), "utf8").includes("entry-grid--entry"),
      `${file} still names the removed carve-out class`);
  assert.ok(!readFileSync(GLOBALS, "utf8").includes("entry-grid--entry"), "the carve-out rules are still in the CSS");
});

test("a void slot renders as a plain row of em dashes - no waiting text, no badge", () => {
  const source = readFileSync(COMPONENT, "utf8");
  // The branch must come FIRST: every later branch describes a match that this slot does not have.
  const voidBranch = source.indexOf("if (slot.isVoid || isVoidPairing(pairing)) {");
  const penaltyBranch = source.indexOf('if (pairing?.resultType === "PENALTY") {');
  const pendingBranch = source.indexOf("if (!isCompletePairing(pairing)) {");
  assert.ok(voidBranch >= 0, "the void row branch is missing");
  assert.ok(voidBranch < penaltyBranch && voidBranch < pendingBranch,
    "a void slot must be answered before any branch that assumes players");
  const branch = source.slice(voidBranch, penaltyBranch);
  assert.ok(!branch.includes("Badge"), "a void row must not carry a status badge");
  assert.ok(!branch.includes("รอ"), "a void row must not say it is waiting for anything");
  assert.ok(!branch.includes("<input"), "a void row has no score to enter, not even a disabled one");
  // The pending branch keeps its waiting text: a slot with no row yet IS waiting on its source game.
  assert.match(source.slice(pendingBranch), /const waitingText = pairing \? "รอคู่แข่งจากอีก row"/);
});

test("void is internal - it never appears as a status the operator can pick", () => {
  const source = readFileSync(COMPONENT, "utf8");
  // Up to the closing `];`, not the first `;` — the type annotation contains one of its own.
  const options = /const STATUS_OPTIONS[\s\S]*?\];/.exec(source);
  assert.ok(options, "STATUS_OPTIONS not found");
  assert.ok(!options[0].includes('"void"'), "void must not be selectable - it is not a state to clear");
  assert.match(source, /type RowStatus = [^;]*"void"/, "void must still exist as a row status");
});

test("every competition score input is wheel-guarded", () => {
  // type=number steps on wheel while focused; these are the fields where that silently corrupts a
  // recorded result. Configuration inputs are deliberately left alone.
  for (const [file, expected] of [["result-entry-grid.tsx", 5], ["override-editor.tsx", 1], ["final-round-board.tsx", 4]] as const) {
    const source = readFileSync(join(process.cwd(), "src", "ui", "components", file), "utf8");
    if (file === "result-entry-grid.tsx") {
      assert.equal((source.match(/<EntryScoreInput/g) ?? []).length, expected, "entry lost a validated score field");
      assert.match(source, /function EntryScoreInput[\s\S]*?<ScoreInput \{\.\.\.props\} type="text"/);
    } else {
      assert.equal((source.match(/<ScoreInput/g) ?? []).length, expected, `${file} lost a ScoreInput`);
      if (file === "override-editor.tsx") {
        const sheet = readFileSync(COMPONENT, "utf8");
        for (const side of ["one", "two"]) assert.ok(sheet.includes(`renderScore(pairing, "${side}"`));
      }
    }
    assert.ok(!/<input[^>]*type="number"/.test(source), `${file} still has a raw number input`);
  }
});
