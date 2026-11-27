import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { browseGroups } from "./spectator-card-groups";

/**
 * The entrance's group headings.
 *
 * The bug these pin down: the heading was hidden whenever there was a single group, on the
 * assumption that one group means the group's name IS the tournament name already in the page
 * header. Card name and tournament name are independent fields, so a tournament called
 * "Test Screen" holding one game called "A-Math" printed neither the game nor anything else that
 * named it — a spectator saw three divisions (M6, OPEN, P6) and no way to tell the sport.
 */

const card = (name: string, division: string) => ({ name, division });

test("a lone group whose name differs from the tournament prints its heading", () => {
  const groups = browseGroups([card("A-Math", "M6"), card("A-Math", "P6")], "20-SEP-2026");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "A-Math");
  assert.equal(groups[0].titled, true);
});

test("the test-screen tournament shows A-Math above M6 / OPEN / P6", () => {
  // The exact shape that was reported from a phone: three cards, one game, three divisions.
  const groups = browseGroups(
    [card("A-Math", "P6"), card("A-Math", "M6"), card("A-Math", "OPEN")],
    "Test Screen",
  );
  assert.deepEqual(
    groups.map((g) => ({ name: g.name, titled: g.titled, divisions: g.cards.map((c) => c.division) })),
    [{ name: "A-Math", titled: true, divisions: ["M6", "OPEN", "P6"] }],
  );
});

test("a lone group that only repeats the tournament name stays headless", () => {
  const groups = browseGroups([card("เอแม็ท บุรีรัมย์", "ม.ต้น"), card("เอแม็ท บุรีรัมย์", "ม.ปลาย")], "เอแม็ท บุรีรัมย์");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].titled, false, "the page header already carries this exact name");
});

test("surrounding whitespace is not a difference", () => {
  // A name typed with a trailing space is the same heading, and must not resurrect the duplicate.
  assert.equal(browseGroups([card("  A-Math ", "M6")], "A-Math")[0].titled, false);
  assert.equal(browseGroups([card("A-Math", "M6")], "\tA-Math\n")[0].titled, false);
});

test("every group keeps its heading once there is more than one", () => {
  const groups = browseGroups(
    [card("Crossword", "M3"), card("A-Math", "M3"), card("A-Math", "P6")],
    "20-SEP-2026",
  );
  assert.deepEqual(groups.map((g) => [g.name, g.titled, g.cards.length]), [["A-Math", true, 2], ["Crossword", true, 1]]);
});

test("a group that merely resembles the tournament name still prints — no fuzzy matching", () => {
  // Each of these is a DIFFERENT name. Hiding any of them would leave the game unnamed on the one
  // screen that names it, so the comparison stays exact after trimming.
  for (const [group, tournament] of [
    ["A-Math", "A Math"],
    ["A-Math", "a-math"],
    ["A-Math", "A-Math 2026"],
    ["A-Math", "A-Math  "], // fine — trimming makes these equal, so this one is the control
  ] as const) {
    const titled = browseGroups([card(group, "M6")], tournament)[0].titled;
    assert.equal(titled, tournament.trim() !== group, `"${group}" vs "${tournament}"`);
  }
});

test("a row still shows the division alone, never the game again", () => {
  // UI-R4: the heading names the game once. This is a source guard because the row is JSX, and
  // the rule it protects is exactly the one a "make the game visible" fix would be tempted to undo.
  const view = readFileSync(join(process.cwd(), "src/ui/components/tournament-viewer.tsx"), "utf8");
  const row = view.match(/<span className="vrow__main">\{([^}]*)\}<\/span>/);
  assert.ok(row, "the viewer division row no longer renders vrow__main");
  assert.equal(row![1].trim(), "card.division");
});
