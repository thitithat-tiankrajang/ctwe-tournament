import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P6 — the stylesheet's standards, enforced.
 *
 * P6 fixed a list of things. These tests are what stops the list coming back, because every one of
 * them is a rule a future edit can break silently: nothing type-checks CSS, and nothing else in the
 * suite reads it.
 *
 * The typography rules are in `docs/ux-refactor/22_P6_TYPOGRAPHY_STANDARD.md`. The short version is
 * that text must not render below 11px at any viewport, and the *first argument of a clamp()* is a
 * viewport — that is exactly where the old 35-declaration metric was blind, and where the worst
 * cases lived (5.5px headers, 7px player names on a phone).
 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** The type scale, read out of :root so the test cannot drift from the stylesheet. */
const TOKENS: Record<string, number> = (() => {
  const found: Record<string, number> = {};
  for (const m of CSS.matchAll(/(--text-[a-z-]+):\s*(\d*\.?\d+)px/g)) found[m[1]] = parseFloat(m[2]);
  return found;
})();

const FLOOR_PX = 11;

/** Resolve var(--text-*) to its px value; returns null when a value is still symbolic. */
function resolve(value: string): string | null {
  let out = value;
  for (const [name, px] of Object.entries(TOKENS)) out = out.split(`var(${name})`).join(`${px}px`);
  return /var\(/.test(out) ? null : out;
}

/** The smallest px this declaration can ever render: a clamp()'s first argument, else the value. */
function smallestPx(value: string): number | null {
  const resolved = resolve(value);
  if (resolved === null) return null;
  const clamp = resolved.match(/clamp\s*\(([^,]+),/i);
  const source = clamp ? clamp[1] : resolved;
  const px = source.match(/(-?\d*\.?\d+)px/);
  return px ? parseFloat(px[1]) : null;
}

type Decl = { line: number; selector: string; value: string };

const fontSizes: Decl[] = CSS.split("\n").flatMap((line, i) => {
  const m = line.match(/font-size:\s*([^;}]+)/);
  if (!m) return [];
  return [{ line: i + 1, selector: (line.split("{")[0] || line).trim().slice(0, 70), value: m[1].trim() }];
});

test("the type scale is declared in :root", () => {
  assert.equal(TOKENS["--text-xs"], FLOOR_PX, "--text-xs is the floor and must be 11px");
  for (const name of ["--text-xs", "--text-sm", "--text-md", "--text-base", "--text-lg", "--text-input-touch"])
    assert.ok(TOKENS[name] > 0, `${name} must be declared in :root`);
});

test("no text renders below 11px at any viewport, clamp() floors included", () => {
  const violations = fontSizes
    .map((d) => ({ ...d, px: smallestPx(d.value) }))
    // font-size: 0 is a text-hiding technique on icon-only controls, not a reading size
    .filter((d) => d.px !== null && d.px > 0 && d.px < FLOOR_PX);
  assert.deepEqual(
    violations.map((v) => `${v.line}: ${v.selector} -> ${v.px}px`),
    [],
    "raise these to a --text-* token; if a table will not fit, scroll the table (standard §5)",
  );
});

test("a fluid font-size in the small range floors on a token, not a bare px", () => {
  // A clamp()'s first argument is the size the smallest phone gets. Anywhere near the floor that
  // number has to come from the scale, so raising the floor is one edit in :root rather than a
  // hunt through the stylesheet. Display sizes (headings) stay free-form until P7 tokenises the
  // full scale — their floors are nowhere near 11px and are not what this guard is protecting.
  const SMALL_RANGE_PX = 13;
  const bare = fontSizes.filter((d) => {
    if (!/clamp/i.test(d.value)) return false;
    if (/clamp\s*\(\s*var\(--text-/i.test(d.value)) return false;
    const px = smallestPx(d.value);
    return px !== null && px < SMALL_RANGE_PX;
  });
  assert.deepEqual(
    bare.map((d) => `${d.line}: ${d.selector} -> ${d.value}`),
    [],
    "use a --text-* token as the clamp floor so the 11px floor stays enforceable in one place",
  );
});

test("text inputs reach 16px on touch-width viewports so iOS Safari cannot zoom on focus", () => {
  // [^}] already spans newlines, so no dotAll flag is needed (and the tsconfig target predates it)
  const rule = CSS.match(/@media \(max-width: 768px\) \{[^}]*font-size: var\(--text-input-touch\)[^}]*\}/);
  assert.ok(rule, "the touch-input font-size rule is missing from globals.css");
  for (const selector of [".input, .select, .textarea", ".entry-keyin input", ".entry-grid .egrid-score"])
    assert.ok(rule![0].includes(selector), `${selector} must be covered by the touch-input rule`);
});

test("no focusable control drops its outline without a replacement indicator", () => {
  const offenders: string[] = [];
  CSS.split("\n").forEach((line, i) => {
    if (!/outline:\s*(none|0)\b/.test(line)) return;
    const selector = (line.split("{")[0] || "").trim();
    if (!/input|button|select|textarea|a\b|\[tabindex/i.test(selector)) return;
    // the indicator may live on the control itself or on the wrapper it shares a name with
    const base = selector.replace(/\s+\w+$/, "").trim().split(",")[0].trim();
    const hasReplacement =
      CSS.includes(`${base}:focus-within`) || CSS.includes(`${selector}:focus-visible`) ||
      CSS.includes(`${base}:focus-visible`) || CSS.includes(`${base} :focus-visible`);
    if (!hasReplacement) offenders.push(`${i + 1}: ${selector}`);
  });
  assert.deepEqual(offenders, [], "removing the focus ring needs a :focus-visible or :focus-within replacement");
});

test("the stylesheet has no rule that nothing can match", () => {
  // Same oracle P6-C used: exact-token matching over the source, plus the dynamic `base--${x}`
  // prefixes the components actually build. A substring grep is not good enough here — it calls
  // .toolbar live because director-game-toolbar exists.
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|jsx?)$/.test(entry)) files.push(path);
    }
  })(join(process.cwd(), "src"));

  let corpus = "";
  for (const file of files) corpus += readFileSync(file, "utf8") + "\n";
  const literals = new Set([...corpus.matchAll(/[_a-zA-Z][\w-]*/g)].map((m) => m[0]));
  const prefixes = [...new Set([...corpus.matchAll(/([a-zA-Z][\w-]*?)(--|__|-)\$\{/g)].map((m) => m[1] + m[2]))];
  const keep = new Set(["sr-only"]); // a11y utility, retained deliberately

  const isLive = (cls: string) =>
    literals.has(cls) || keep.has(cls) || prefixes.some((p) => cls.startsWith(p));

  const dead: string[] = [];
  CSS.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.includes("{") || trimmed.startsWith("@") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    const selectorText = line.slice(0, line.indexOf("{"));
    if (!selectorText.includes(".")) return;
    const parts = selectorText.split(",").map((s) => s.trim()).filter(Boolean);
    const partDead = (sel: string) => {
      const classes = [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
      return classes.length > 0 && classes.some((c) => !isLive(c));
    };
    if (parts.length > 0 && parts.every(partDead)) dead.push(`${i + 1}: ${selectorText.trim().slice(0, 70)}`);
  });
  assert.deepEqual(dead, [], "these rules can never match anything — delete them, or the class that should use them is missing");
});
