import assert from "node:assert/strict";
import test from "node:test";

import { matchesBoardQuery } from "./board-search";

/** A pairing row: two players, so a code sits in id1 OR id2 depending on seat parity. */
interface Row { id1: string; name1: string; id2: string; name2: string }
const accessors = {
  id1: (row: Row) => row.id1, name1: (row: Row) => row.name1,
  id2: (row: Row) => row.id2, name2: (row: Row) => row.name2,
};
const CODE_KEYS = ["id1", "id2"];
const TEXT_KEYS = ["id1", "name1", "id2", "name2"];
const match = (row: Row, query: string) => matchesBoardQuery(row, query, accessors, CODE_KEYS, TEXT_KEYS);

const pair: Row = { id1: "A021", name1: "ภัทรพล อัครเดชา ปทุมคงคั่า", id2: "A004", name2: "ศุภณัฐ บุญเรือง สามเสนวิทยาลัย" };

test("one search finds a player on either side of the board", () => {
  assert.equal(match(pair, "21"), true);  // side 1
  assert.equal(match(pair, "4"), true);   // side 2 — the case that needed two attempts
  assert.equal(match(pair, "999"), false);
});

test("code matching stays exact on digits, so 4 never matches 40 or 14", () => {
  const other: Row = { ...pair, id1: "A040", id2: "A014" };
  assert.equal(match(other, "4"), false);
  assert.equal(match(other, "40"), true);
  assert.equal(match(other, "14"), true);
});

test("several codes are OR-ed, so one search pulls a whole set onto the board", () => {
  assert.equal(match(pair, "5 003 45 012"), false);
  assert.equal(match(pair, "5 003 21 012"), true);   // 21 is on this row
  assert.equal(match(pair, "5 4"), true);            // 4 is on this row
});

test("a query that is not entirely code-shaped searches text across every column", () => {
  assert.equal(match(pair, "ภัทรพล"), true);
  assert.equal(match(pair, "สามเสนวิทยาลัย"), true);   // side 2's school
  assert.equal(match(pair, "ไม่มีใครชื่อนี้"), false);
});

test("an empty query matches everything rather than nothing", () => {
  assert.equal(match(pair, ""), true);
  assert.equal(match(pair, "   "), true);
});

test("a text query never resolves against code columns as codes", () => {
  // "A021 ภัทรพล" is not a pure code set, so it is one text query — and it matches because id1
  // is also a text column. The point is that it does NOT get split into code tokens.
  assert.equal(match(pair, "A021 ภัทรพล"), false);
  assert.equal(match(pair, "ภัทรพล อัครเดชา"), true);
});
