import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { hasArrived, NAVIGATION_PENDING_TIMEOUT_MS, pathOf } from "./use-navigate-with-pending";

/**
 * The release rule for a navigation's pending flag.
 *
 * This is the logic that decides whether an operator's button stops spinning. Getting it wrong
 * strands them mid-tournament, so it is a pure function with tests rather than an effect nobody
 * can exercise.
 */

test("arrival ignores query and hash, which the router keeps out of the pathname", () => {
  assert.equal(pathOf("/cards/abc"), "/cards/abc");
  assert.equal(pathOf("/cards/abc?game=2"), "/cards/abc");
  assert.equal(pathOf("/cards/abc#card=x"), "/cards/abc");
  // A push to `/cards/abc?game=2` lands on pathname `/cards/abc`; comparing raw hrefs would never
  // match, and the flag would hang until the watchdog fired.
  assert.equal(hasArrived("/cards/abc?game=2", "/cards/abc"), true);
});

test("we have not arrived until the pathname is the target", () => {
  assert.equal(hasArrived("/cards/abc/games", "/cards/abc"), false);
  assert.equal(hasArrived("/cards/abc", "/cards/abc/games"), false);
});

test("with nothing in flight there is nothing to release", () => {
  assert.equal(hasArrived(null, "/cards/abc"), false);
});

test("the watchdog is bounded and short enough to not strand an operator", () => {
  assert.ok(NAVIGATION_PENDING_TIMEOUT_MS > 0);
  assert.ok(NAVIGATION_PENDING_TIMEOUT_MS <= 15_000, "a stuck spinner must not outlast an operator's patience");
});

test("pending is never wired to disabled anywhere it is used", () => {
  // The safeguard is structural: if `pending` only ever drives a spinner, a stuck flag cannot lock
  // the UI. The moment someone writes `disabled={pending}` that guarantee is gone.
  const roots = [join(process.cwd(), "src", "app"), join(process.cwd(), "src", "ui")];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".tsx")) files.push(path);
    }
  };
  roots.forEach(walk);
  const offenders = files.filter((path) => {
    const source = readFileSync(path, "utf8");
    if (!source.includes("useNavigateWithPending")) return false;
    // Renamed to `navPending` at every call site, precisely so it is greppable and cannot be
    // confused with a page's own unrelated `pending` state (players/page.tsx has one).
    return /disabled=\{[^}]*\bnavPending\b/.test(source) || /loading=\{[^}]*\bnavPending\b/.test(source);
  });
  assert.deepEqual(offenders.map((p) => p.replace(process.cwd() + "/", "")), []);
});

test("system-driven navigations keep using router.replace directly", () => {
  const shell = readFileSync(join(process.cwd(), "src", "ui", "layout", "app-shell.tsx"), "utf8");
  // The workflow auto-follow fires on a REMOTE stage change during live scoring. A spinner there
  // would be a phantom for someone who clicked nothing, so it must stay a bare router.replace.
  assert.match(shell, /if \(pathname === stageHref\(id, previousStage\)\) router\.replace\(stageHref\(id, nextStage\)\);/);
});
