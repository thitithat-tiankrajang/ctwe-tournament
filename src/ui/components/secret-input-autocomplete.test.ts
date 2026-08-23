import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Password-manager suppression, as far as a page is allowed to go.
 *
 * `new-password` was chosen in P6 as "the strongest standard hint", but it is the exact token that
 * tells Chrome a field is a signup field — so Chrome answered by offering to generate a password.
 * `off` does not. Neither binds the browser's own "save password?" prompt; that is accepted and
 * recorded in `docs/ux-refactor/26_PASSWORD_MANAGER_LIMITS.md`.
 *
 * Source assertions, because the repo has no React test setup (18_P4_CLOSURE.md §9). The failure
 * mode these catch is a well-meaning revert to `new-password`, or a second password field added
 * somewhere that bypasses the component.
 */

const SRC = join(process.cwd(), "src");
const COMPONENT = join(SRC, "ui", "components", "fresh-secret-input.tsx");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsxFiles(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("the secret field asks for no autocomplete at all", () => {
  const source = readFileSync(COMPONENT, "utf8");
  assert.match(source, /autoComplete="off"/);
  assert.ok(
    !/autoComplete="new-password"/.test(source),
    "new-password is what triggers Chrome's password-generation offer - use off",
  );
});

test("callers cannot override it, so every call site behaves the same", () => {
  // This Omit is what makes "consistent across the application" structural rather than a
  // convention somebody has to remember at eight call sites.
  const source = readFileSync(COMPONENT, "utf8");
  assert.match(source, /Omit<InputHTMLAttributes<HTMLInputElement>, "type" \| "autoComplete" \| "value">/);
});

test("the accessible masking is intact - no CSS-masking regression", () => {
  // type must stay password while masked: a CSS mask hides the value from the screen and from
  // nothing else, so a screen reader reads it aloud (21_P6_P7_PLAN.md §2.4 rejected that).
  assert.match(readFileSync(COMPONENT, "utf8"), /type=\{revealed \? "text" : "password"\}/);
  // The mask must not creep back in as a stylesheet rule. Checked in the CSS rather than in the
  // component, where the term legitimately appears in prose explaining why it was rejected.
  const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  assert.ok(!css.includes("-webkit-text-security"), "CSS masking is not masking");
});

test("the per-manager ignore attributes are all still present", () => {
  const source = readFileSync(COMPONENT, "utf8");
  for (const attribute of ["data-1p-ignore", "data-bwignore", "data-form-type", "data-lpignore", "data-protonpass-ignore"])
    assert.ok(source.includes(attribute), `${attribute} covers one of the third-party managers`);
});

test("no password input bypasses the component", () => {
  // A raw <input type="password"> would carry none of the suppression signals above.
  const offenders = tsxFiles(SRC)
    .filter((path) => path !== COMPONENT)
    .filter((path) => /<input[^>]*type=["']password["']/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, [], "route these through FreshSecretInput instead");
});
