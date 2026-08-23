import assert from "node:assert/strict";
import test from "node:test";

import { matchesRecordQuery, type OverviewRecordFilterValue } from "./overview-record-filter";

const player = { id: "A016", firstName: "ธันวา", lastName: "นาคเกิด", school: "สาธิตเกษตร" };
const base: OverviewRecordFilterValue = { mode: "player", playerIds: [], schools: [], query: "" };
const withQuery = (query: string, mode: "player" | "school" = "player") =>
  matchesRecordQuery(player, { ...base, mode, query });

test("an empty query is not a filter - it excludes nobody by matching nobody", () => {
  // The caller treats "no query" as "no filter at all"; this predicate only answers the
  // narrower question "does the typed query name this player?".
  assert.equal(withQuery(""), false);
  assert.equal(withQuery("   "), false);
});

test("a code query matches exactly, with leading zeros normalized", () => {
  assert.equal(withQuery("16"), true);
  assert.equal(withQuery("016"), true);
  assert.equal(withQuery("A16"), true);
  assert.equal(withQuery("1"), false);   // exact on digits: 1 is not 16
});

test("several codes are OR-ed", () => {
  assert.equal(withQuery("5 003 16 012"), true);
  assert.equal(withQuery("5 003 45 012"), false);
});

test("free text searches code, name and school together", () => {
  assert.equal(withQuery("ธันวา"), true);
  assert.equal(withQuery("นาคเกิด"), true);
  assert.equal(withQuery("สาธิตเกษตร"), true);
  assert.equal(withQuery("ไม่มีใครชื่อนี้"), false);
});

test("school mode searches the school and ignores code tokens", () => {
  assert.equal(withQuery("สาธิตเกษตร", "school"), true);
  assert.equal(withQuery("ธันวา", "school"), false);
  // A bare code means nothing when the viewer is searching schools.
  assert.equal(withQuery("16", "school"), false);
});
