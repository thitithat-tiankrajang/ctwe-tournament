import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { viewport as tourViewport } from "./tour/layout";

/**
 * The viewer's 75% layout scale, fenced in.
 *
 * `src/app/tour/layout.tsx` widens the public viewer's layout viewport so a phone renders it the
 * way the browser's own 75% zoom does. That is a deliberate, owner-approved exception for ONE
 * route family, and it is invisible in the components — nothing in a page tells you the layout
 * viewport is no longer the device width. These tests are what stops it spreading to the
 * operational consoles, losing pinch-to-zoom, or being re-scaled until a phone falls out of the
 * report's list mode into the nine-column grid.
 */

const APP = join(process.cwd(), "src/app");

/** Every route file under src/app, so a new `viewport` export anywhere cannot arrive unnoticed. */
function routeFiles(dir: string = APP): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const declaringViewport = routeFiles()
  .filter((path) => /export\s+const\s+viewport\b/.test(readFileSync(path, "utf8")))
  .map((path) => relative(APP, path).split(sep).join("/"))
  .sort();

const TOUR_LAYOUT = readFileSync(join(APP, "tour/layout.tsx"), "utf8");
const ROOT_LAYOUT = readFileSync(join(APP, "layout.tsx"), "utf8");
/** The file's CODE. Its comments name the fields they forbid, so a raw grep would hit the prose. */
const TOUR_CODE = TOUR_LAYOUT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("the viewer lays out at 75% scale, matching the browser zoom the owner approved", () => {
  assert.equal(tourViewport.initialScale, 0.75);
  // `width` must stay device-width: the layout viewport is then max(device-width, device/scale),
  // which is the widening that stops Thai names wrapping. A fixed `width` number would scale the
  // page differently on every device instead.
  assert.equal(tourViewport.width, "device-width");
  // The root layout sets it for the notch; a segment that re-declares `viewport` must keep it.
  assert.equal(tourViewport.viewportFit, "cover");
});

test("the viewer never takes pinch-to-zoom away from a spectator", () => {
  // The accessibility cost of rendering below the 11px reading floor is only acceptable while the
  // reader can zoom back in. Both fields must stay ABSENT: `maximum-scale` and `user-scalable=no`
  // are the two ways a viewport meta can pin a page, and iOS honours both.
  assert.equal(tourViewport.maximumScale, undefined, "maximumScale pins the page — leave it out");
  assert.equal(tourViewport.userScalable, undefined, "userScalable pins the page — leave it out");
  assert.doesNotMatch(TOUR_CODE, /maximumScale|userScalable|user-scalable|maximum-scale/i);
});

test("only /tour changes the viewport — admin, director and staff keep the root one", () => {
  assert.deepEqual(
    declaringViewport,
    ["layout.tsx", "tour/layout.tsx"],
    "a viewport export outside the root and /tour would rescale a console that was never signed off",
  );
  // The legacy `/t/{hex}` viewer is deliberately NOT included: it renders the same component, but
  // it is a different segment and was not part of the approved change.
  assert.equal(declaringViewport.includes("t/[token]/layout.tsx"), false);
});

test("the root viewport still renders every other route at 1:1", () => {
  const root = ROOT_LAYOUT.match(/export const viewport: Viewport = \{([^}]*)\}/);
  assert.ok(root, "the root viewport export is missing from src/app/layout.tsx");
  assert.match(root![1], /initialScale:\s*1\b/);
  assert.match(root![1], /width:\s*"device-width"/);
});

test("at every supported phone width the report stays a list, not the nine-column grid", () => {
  // The scale widens the layout viewport, and EVERY breakpoint in the app reads that widened
  // number, so each one now flips at `breakpoint * scale` of device width. The report's own
  // switches are the ones that change what a spectator sees, so they are read from the component
  // rather than copied here: if either constant moves, this test does the arithmetic again.
  const view = readFileSync(join(process.cwd(), "src/ui/components/card-overview-view.tsx"), "utf8");
  const px = (name: string) => {
    const found = view.match(new RegExp(`${name}\\s*=\\s*"\\(max-width:\\s*(\\d+)px\\)"`));
    assert.ok(found, `${name} is no longer a (max-width: Npx) constant`);
    return Number(found![1]);
  };
  const scale = tourViewport.initialScale as number;
  /** The widest device this change was photographed and signed off on (320/375/390/430/480). */
  const SUPPORTED_PHONE_PX = 480;
  const layoutWidth = Math.ceil(SUPPORTED_PHONE_PX / scale);

  assert.ok(
    layoutWidth <= px("PHONE_VIEWPORT"),
    `a ${SUPPORTED_PHONE_PX}px phone lays out at ${layoutWidth}px, past the ${px("PHONE_VIEWPORT")}px list breakpoint: it would get the nine-column grid`,
  );
  assert.ok(
    layoutWidth <= px("NARROW_VIEWPORT"),
    `a ${SUPPORTED_PHONE_PX}px phone lays out at ${layoutWidth}px, past the ${px("NARROW_VIEWPORT")}px breakpoint: it would lose the bottom navigation`,
  );
});
