import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { applyColumnControls, filterTargets } from "./data-grid";
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
const CODE_GROUP = ["id1", "id2"];

test("a filter key inside the group targets the whole group; everything else targets itself", () => {
  assert.deepEqual(filterTargets("id1", CODE_GROUP), CODE_GROUP);
  assert.deepEqual(filterTargets("id2", CODE_GROUP), CODE_GROUP);
  assert.deepEqual(filterTargets("school1", CODE_GROUP), ["school1"]);
  // No group configured is the default, and must leave every column filtering only itself.
  assert.deepEqual(filterTargets("id1"), ["id1"]);
});

test("searching รหัส 1 finds the player on either side of the pairing", () => {
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "45" }, CODE_GROUP, CODE_GROUP);
  // Both the row where 045 sits on side one AND the row where it sits on side two.
  assert.deepEqual(found.map((row) => row.one), ["A045", "A012"]);
});

test("a code that is in no pairing still narrows to nothing", () => {
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "500" }, CODE_GROUP, CODE_GROUP);
  assert.deepEqual(found, []);
});

test("exact-digit code matching survives the group hop", () => {
  // matchesPlayerCode is exact: 1 matches A001, never A012. The group must not degrade that to a
  // substring match, or "1" would drag in every code containing a 1.
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "12" }, CODE_GROUP, CODE_GROUP);
  assert.deepEqual(found.map((row) => row.one), ["A045", "A012"]);
  assert.deepEqual(applyColumnControls(rows, accessors, {}, null, { id1: "1" }, CODE_GROUP, CODE_GROUP), []);
});

test("without a group, a column filter still matches only its own column", () => {
  // Guards the default for DataGrid and ResultViewGrid, which keep per-column semantics.
  const found = applyColumnControls(rows, accessors, {}, null, { id1: "45" }, CODE_GROUP);
  assert.deepEqual(found.map((row) => row.one), ["A045"]);
});

test("รหัส 2 carries no sort or filter menu, and is not in the filterable key list", () => {
  const source = readFileSync(COMPONENT, "utf8");
  const filterKeys = /const ENTRY_FILTER_KEYS = \[([^\]]*)\]/.exec(source);
  assert.ok(filterKeys, "ENTRY_FILTER_KEYS not found");
  assert.ok(!filterKeys[1].includes('"id2"'), "id2 must not be sortable/filterable in the entry grid");
  assert.ok(filterKeys[1].includes('"id1"'), "id1 keeps the search affordance");
  // ENTRY_FILTER_KEYS feeds BOTH `sortable` and `filterable`, so removing id2 removes both menus.
  assert.ok(source.includes("sortable: (key) => ENTRY_FILTER_KEYS.includes(key)"));
  assert.ok(source.includes("filterable: (key) => ENTRY_FILTER_KEYS.includes(key)"));
  // The mirror flag is what renders the header without a menu.
  assert.match(source, /key: "id2",[^}]*searchable: false/);
});

test("the entry grid keeps รหัส 2 blue instead of the muted mirror ink", () => {
  const css = readFileSync(GLOBALS, "utf8");
  const muted = css.indexOf(".entry-grid td.egrid-td--mirror.cell-id");
  const blue = css.indexOf(".entry-grid--entry td.egrid-td--mirror.cell-id");
  assert.ok(muted >= 0, "the shared mirror rule is gone - overview tables lost their muted ink");
  assert.ok(blue >= 0, "the entry-grid carve-out is missing - รหัส 2 renders grey");
  // Equal specificity (0,3,1): the carve-out only wins on source order.
  assert.ok(blue > muted, "the carve-out must sit BELOW the shared rule or it loses the cascade");
  assert.match(css.slice(blue), /^\.entry-grid--entry td\.egrid-td--mirror\.cell-id \{ color: var\(--blue-dark\); \}/);
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

test("only the entry grid dissents - the overview tables keep the muted mirror", () => {
  const source = readFileSync(COMPONENT, "utf8");
  // `entry-grid--match` is shared by four grids; the carve-out must key on the narrower class.
  assert.match(source, /entry-grid entry-grid--match entry-grid--entry/);
  const overview = readFileSync(join(process.cwd(), "src", "ui", "components", "card-overview.tsx"), "utf8");
  assert.ok(!overview.includes("entry-grid--entry"), "the overview must not opt into the blue mirror");
});
