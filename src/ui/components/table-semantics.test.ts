import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P6-E — table semantics, enforced.
 *
 * Every screen in this product is a table: rankings, pairings, result entry, the audit log. A
 * screen reader navigating one needs two things the markup was not giving it — which column a cell
 * belongs to (`scope`), and which of the four tables on the overview it is currently in (an
 * accessible name). Without them the overview announces four identical "table"s and reads cells
 * with no header association, which is WCAG 1.3.1.
 *
 * These are source assertions rather than rendered ones because the repo has no React test setup
 * (18_P4_CLOSURE.md §9). They are deliberately crude: they catch the omission, which is the failure
 * mode that actually happens when someone adds a column.
 */

const SRC = join(process.cwd(), "src");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsxFiles(path, out);
    else if (entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const files = tsxFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const rel = (path: string) => path.slice(process.cwd().length + 1);

test("every <th> declares a scope", () => {
  const missing: string[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, i) => {
      let from = 0;
      for (;;) {
        const at = line.indexOf("<th", from);
        if (at === -1) break;
        from = at + 3;
        if (!" >".includes(line[at + 3] ?? "")) continue; // <thead>, <theme…
        const close = line.indexOf(">", at);
        const tag = close === -1 ? line.slice(at) : line.slice(at, close + 1);
        if (!tag.includes("scope=")) missing.push(`${rel(path)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(missing, [], 'a header cell needs scope="col" (or "row") to bind to its data');
});

test("every <table> has an accessible name", () => {
  const unnamed: string[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, i) => {
      let from = 0;
      for (;;) {
        const at = line.indexOf("<table", from);
        if (at === -1) break;
        from = at + 6;
        const close = line.indexOf(">", at);
        const tag = close === -1 ? line.slice(at) : line.slice(at, close + 1);
        const named = tag.includes("aria-label") || tag.includes("aria-labelledby") || tag.includes("<caption");
        if (!named) unnamed.push(`${rel(path)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(unnamed, [], "name the table: aria-label, aria-labelledby, or a <caption>");
});

test("DataGrid exposes ariaLabel and every caller passes one", () => {
  const grid = files.find((f) => f.path.endsWith("data-grid.tsx"));
  assert.ok(grid, "data-grid.tsx not found");
  assert.match(grid!.text, /ariaLabel\?: string;/, "DataGrid must accept an ariaLabel prop");
  assert.match(grid!.text, /aria-label=\{ariaLabel\}/, "DataGrid must apply ariaLabel to its <table>");

  const bare: string[] = [];
  for (const { path, text } of files) {
    if (path.endsWith("data-grid.tsx")) continue;
    // a caller's props may span lines; scan to the matching close of the opening tag
    let from = 0;
    for (;;) {
      const at = text.indexOf("<DataGrid", from);
      if (at === -1) break;
      from = at + 9;
      const close = text.indexOf(">", at);
      if (close === -1) break;
      if (!text.slice(at, close).includes("ariaLabel")) {
        bare.push(`${rel(path)}:${text.slice(0, at).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(bare, [], "pass ariaLabel — four unnamed grids on one screen are indistinguishable");
});
