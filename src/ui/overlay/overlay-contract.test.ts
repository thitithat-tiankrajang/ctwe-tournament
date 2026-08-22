import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P7-E — the overlay contract, enforced.
 *
 * Four dialogs declared aria-modal="true" and none of them behaved modally: focus stayed on
 * <body>, twenty controls stayed reachable behind them, the page kept scrolling. aria-modal is a
 * promise to assistive tech, and nothing in the build was checking that the promise was kept.
 *
 * These are source assertions. There is no React test setup here (18_P4_CLOSURE.md §9), so the
 * behaviour is verified at runtime and the wiring is verified here — which is the half that rots
 * when someone adds a fifth dialog by copying the JSX of the fourth.
 */

const SRC = join(process.cwd(), "src");
const rel = (path: string) => path.slice(process.cwd().length + 1);

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsxFiles(path, out);
    else if (entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}
const files = tsxFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("anything claiming aria-modal unconditionally uses the modal behaviour", () => {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    // A literal aria-modal="true" is an unconditional claim. An expression — as the record filter
    // uses to tell its mobile sheet from its desktop popover — is a claim about a mode, checked by
    // the next test instead.
    if (!text.includes('aria-modal="true"')) continue;
    if (!text.includes("useModalDialog")) offenders.push(rel(path));
  }
  assert.deepEqual(
    offenders,
    [],
    "a modal dialog needs useModalDialog: focus trap, focus restore, scroll lock and a unique label id",
  );
});

test("a dialog that is only sometimes modal says so conditionally, never as a literal", () => {
  // The record filter is a bottom sheet with a backdrop below 768px and a plain popover above it.
  // Measured on the desktop popover before this was fixed: backdrop display:none, page unlocked,
  // 13 controls reachable behind it — while it told assistive tech it was modal.
  const filter = files.find((f) => f.path.endsWith("overview-record-filter.tsx"));
  assert.ok(filter, "overview-record-filter.tsx not found");
  assert.ok(
    !filter!.text.includes('aria-modal="true"'),
    "the record filter must not claim aria-modal unconditionally — it is only modal as a sheet",
  );
  assert.match(filter!.text, /aria-modal=\{/, "its aria-modal must be driven by the current mode");
  assert.match(filter!.text, /MOBILE_PICKER_QUERY/, "and that mode comes from the breakpoint query");
});

test("every dialog labels itself with a generated id, not a hard-coded one", () => {
  // Two dialogs sharing id="confirm-dialog-title" point both aria-labelledby attributes at the
  // same node, so one of them is announced with the other's title. Only dialogs are at risk: a
  // <section aria-labelledby="its-own-heading"> renders once and is fine.
  // [^>] already spans newlines, so no dotAll flag is needed (and the tsconfig target predates it)
  const offenders: string[] = [];
  for (const { path, text } of files) {
    for (const m of text.matchAll(/role="dialog"[^>]*?aria-labelledby="([^"]+)"/g)) offenders.push(`${rel(path)} -> ${m[1]}`);
    for (const m of text.matchAll(/aria-labelledby="([^"]+)"[^>]*?role="dialog"/g)) offenders.push(`${rel(path)} -> ${m[1]}`);
  }
  assert.deepEqual(offenders, [], "use the id from useModalDialog (useId) so two open dialogs cannot collide");
});

test("there is exactly one modal implementation, not a second overlay system", () => {
  // A second copy of the behaviour is how the first one quietly stops being true.
  const hooks = tsxFiles(SRC).concat(
    readdirSync(join(SRC, "ui/overlay")).map((f) => join(SRC, "ui/overlay", f)),
  ).filter((p) => (p.endsWith(".ts") || p.endsWith(".tsx")) && !p.endsWith(".test.ts"));
  const definitions = hooks.filter((p) => /export function useModalDialog/.test(readFileSync(p, "utf8")));
  assert.equal(definitions.length, 1, "useModalDialog must be defined once: " + definitions.map(rel).join(", "));

  // The record filter keeps its own Escape handling on purpose: it is modal only as a bottom
  // sheet, and its close is sequenced with a drag/transition that a generic handler would cut off.
  // That exemption is deliberate and is the only one — anything else must go through the hook.
  const handRolled = files.filter((f) => /aria-modal/.test(f.text)
    && /addEventListener\(\s*["']keydown["']/.test(f.text)
    && !f.path.endsWith("overview-record-filter.tsx"));
  assert.deepEqual(handRolled.map((f) => rel(f.path)), [],
    "modal Escape handling belongs to useModalDialog, not to the component");
});
